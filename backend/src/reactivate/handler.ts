import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CreateScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  buildScheduleExpression,
  patientReactivationInputSchema,
  patientReactivationResponseSchema,
  SCHEDULE_GROUP_NAME,
} from '@medadhere/shared';
import { z } from 'zod';
import { deactivateSchedules } from '../lib/scheduler-deactivate';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims';
import { createDbPoolProvider } from '../shared/db-pool';
import {
  ReactivationConflictError,
  ReactivationNotFoundError,
  reactivatePatient,
  type DoseScheduleRestoration,
  type DoseScheduleRestorer,
  type ReactivationResult,
} from './repository';

export { ReactivationConflictError, ReactivationNotFoundError } from './repository';

const MAX_BODY_BYTES = 4_096;
const patientIdSchema = z.string().uuid();
const scheduler = new SchedulerClient({});
const getPool = createDbPoolProvider(new SecretsManagerClient({}));

interface ReactivationEvent {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: {
    readonly authorizer?: {
      readonly jwt?: { readonly claims?: Readonly<Record<string, unknown>> };
    };
  };
  readonly routeKey?: string;
}

interface HttpResult {
  readonly statusCode: number;
  readonly headers: { readonly 'content-type': string };
  readonly body: string;
}

type Reactivate = (request: {
  readonly patientId: string;
  readonly clinicianSub: string;
  readonly expectedVersion: number;
}) => Promise<ReactivationResult>;

interface ReactivateHandlerDependencies {
  readonly reactivate: Reactivate;
}

interface SchedulerConfig {
  readonly outboundFnArn: string;
  readonly schedulerTargetRoleArn: string;
}

type SchedulerSender = Pick<SchedulerClient, 'send'>;
type ResetDoseSchedules = typeof deactivateSchedules;

function json(statusCode: number, body: Readonly<Record<string, unknown>>): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function logMetric(metric: string, details: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({ metric, ...details }));
}

function parseBody(event: ReactivationEvent): z.infer<typeof patientReactivationInputSchema> {
  if (
    event.isBase64Encoded === true ||
    typeof event.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new z.ZodError([]);
  }
  try {
    return patientReactivationInputSchema.parse(JSON.parse(event.body) as unknown);
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new z.ZodError([]);
  }
}

/** Production AWS adapter, injectable so tests prove the exact command without network access. */
export function createSchedulerRestorer(
  sender: SchedulerSender,
  resetDoseSchedules: ResetDoseSchedules,
  config: SchedulerConfig,
): DoseScheduleRestorer {
  if (!config.outboundFnArn || !config.schedulerTargetRoleArn) {
    throw new Error('Scheduler target configuration is missing');
  }
  return {
    reset: async (patientId) => {
      await resetDoseSchedules(patientId, 'dose');
      await resetDoseSchedules(patientId, 'reminder');
      await resetDoseSchedules(patientId, 'timeout');
    },
    create: (dose: DoseScheduleRestoration) =>
      sender.send(
        new CreateScheduleCommand({
          Name: `dose-${dose.patientId}-${dose.doseId}`.slice(0, 64),
          GroupName: SCHEDULE_GROUP_NAME,
          ScheduleExpression: buildScheduleExpression({
            doseDate: dose.doseDate,
            localDoseTime: dose.localDoseTime,
          }),
          ScheduleExpressionTimezone: dose.scheduleTimezone,
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          Target: {
            Arn: config.outboundFnArn,
            RoleArn: config.schedulerTargetRoleArn,
            Input: JSON.stringify({ patientId: dose.patientId, doseId: dose.doseId }),
          },
        }),
      ),
  };
}

export function createReactivateHandler(
  dependencies: ReactivateHandlerDependencies,
): (event: ReactivationEvent) => Promise<HttpResult> {
  return async (event) => {
    let clinicianSub: string;
    try {
      clinicianSub = requireClinicianClaims(event).sub;
    } catch (error) {
      if (!(error instanceof ClinicianClaimsError)) throw error;
      logMetric('reactivate_unauthorized');
      return json(401, { error: 'unauthorized' });
    }

    let patientId: string;
    try {
      patientId = patientIdSchema.parse(event.pathParameters?.id);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      logMetric('reactivate_bad_patient_id');
      return json(400, { error: 'invalid patient id' });
    }

    let input: z.infer<typeof patientReactivationInputSchema>;
    try {
      input = parseBody(event);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      logMetric('reactivate_bad_request');
      return json(400, { error: 'invalid request' });
    }

    try {
      const result = await dependencies.reactivate({
        patientId,
        clinicianSub,
        expectedVersion: input.expectedVersion,
      });
      const response = patientReactivationResponseSchema.parse({
        reactivated: true,
        agentEnabled: result.agentEnabled,
        isActive: result.isActive,
        messagingStateVersion: result.messagingStateVersion,
      });
      logMetric('reactivate_recorded', { schedulesRestored: result.schedulesRestored });
      return json(200, response);
    } catch (error) {
      if (error instanceof ReactivationNotFoundError) {
        logMetric('reactivate_not_found');
        return json(404, { error: 'patient not found' });
      }
      if (error instanceof ReactivationConflictError) {
        logMetric('reactivate_conflict', { reason: error.reason });
        return json(409, { error: 'reactivation conflict' });
      }
      logMetric('reactivate_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return json(500, { error: 'internal error' });
    }
  };
}

export const handler = createReactivateHandler({
  reactivate: async (request) => {
    const outboundFnArn = process.env.OUTBOUND_FN_ARN;
    const schedulerTargetRoleArn = process.env.SCHEDULER_TARGET_ROLE_ARN;
    if (!outboundFnArn || !schedulerTargetRoleArn) {
      throw new Error('OUTBOUND_FN_ARN / SCHEDULER_TARGET_ROLE_ARN must both be set');
    }
    const database = await getPool();
    return reactivatePatient(
      database,
      request,
      createSchedulerRestorer(scheduler, deactivateSchedules, {
        outboundFnArn,
        schedulerTargetRoleArn,
      }),
    );
  },
});
