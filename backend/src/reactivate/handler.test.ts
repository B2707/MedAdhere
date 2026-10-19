import { beforeEach, describe, expect, it, vi } from 'vitest';

const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DOSE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CLINICIAN_SUB = '97b4a172-e055-4c37-9d95-2a00664dfe64';

function event(body: unknown = { expectedVersion: 7 }) {
  return {
    routeKey: 'POST /api/patients/{id}/reactivate',
    pathParameters: { id: PATIENT_ID },
    body: JSON.stringify(body),
    requestContext: {
      authorizer: { jwt: { claims: { sub: CLINICIAN_SUB, token_use: 'id' } } },
    },
  };
}

describe('doctor reactivation HTTP boundary', () => {
  const reactivate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    reactivate.mockResolvedValue({
      agentEnabled: true,
      isActive: false,
      messagingStateVersion: 8,
      schedulesRestored: 1,
    });
  });

  it('checks clinician ID-token claims before caller-controlled path and body input', async () => {
    const { createReactivateHandler } = await import('./handler.js');
    const handler = createReactivateHandler({ reactivate });
    const response = await handler({
      routeKey: 'POST /api/patients/{id}/reactivate',
      pathParameters: { id: 'not-a-uuid' },
      body: '{bad json',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
    expect(reactivate).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...event(), pathParameters: { id: 'not-a-uuid' } }, 'invalid patient id'],
    [{ ...event(), body: '{bad json' }, 'invalid request'],
    [{ ...event(), body: JSON.stringify({}) }, 'invalid request'],
    [
      {
        ...event(),
        body: JSON.stringify({ expectedVersion: 7, ownerClinicianSub: CLINICIAN_SUB }),
      },
      'invalid request',
    ],
    [{ ...event(), isBase64Encoded: true }, 'invalid request'],
  ])('rejects a malformed UUID or non-strict body before any write', async (input, error) => {
    const { createReactivateHandler } = await import('./handler.js');
    const handler = createReactivateHandler({ reactivate });
    const response = await handler(input);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error });
    expect(reactivate).not.toHaveBeenCalled();
  });

  it('derives ownership from claims and passes the exact optimistic version', async () => {
    const { createReactivateHandler } = await import('./handler.js');
    const handler = createReactivateHandler({ reactivate });
    const response = await handler(event());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reactivated: true,
      agentEnabled: true,
      isActive: false,
      messagingStateVersion: 8,
    });
    expect(reactivate).toHaveBeenCalledWith({
      patientId: PATIENT_ID,
      clinicianSub: CLINICIAN_SUB,
      expectedVersion: 7,
    });
  });

  it('maps hidden ownership misses to 404 and all state conflicts to 409', async () => {
    const { createReactivateHandler, ReactivationConflictError, ReactivationNotFoundError } =
      await import('./handler.js');
    const handler = createReactivateHandler({ reactivate });

    reactivate.mockRejectedValueOnce(new ReactivationNotFoundError());
    const hidden = await handler(event());
    expect(hidden.statusCode).toBe(404);
    expect(JSON.parse(hidden.body)).toEqual({ error: 'patient not found' });

    reactivate.mockRejectedValueOnce(new ReactivationConflictError('stale_version'));
    const conflict = await handler(event());
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ error: 'reactivation conflict' });
  });

  it('returns a generic 500 and emits only identifier-free operational metrics', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { createReactivateHandler } = await import('./handler.js');
    const handler = createReactivateHandler({ reactivate });
    reactivate.mockRejectedValueOnce(new Error(`database failure for ${PATIENT_ID}`));

    const response = await handler(event());

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: 'internal error' });
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('reactivate_failed'))).toBe(true);
    expect(lines.join('\n')).not.toContain(PATIENT_ID);
    expect(lines.join('\n')).not.toContain(CLINICIAN_SUB);
  });

  it('handles a non-Error failure without reflecting its value', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { createReactivateHandler } = await import('./handler.js');
    const handler = createReactivateHandler({ reactivate });
    reactivate.mockRejectedValueOnce(PATIENT_ID);

    const response = await handler(event());

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(PATIENT_ID);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(PATIENT_ID);
  });

  it('fails closed before database access when production Scheduler configuration is absent', async () => {
    const priorOutboundArn = process.env.OUTBOUND_FN_ARN;
    const priorRoleArn = process.env.SCHEDULER_TARGET_ROLE_ARN;
    delete process.env.OUTBOUND_FN_ARN;
    delete process.env.SCHEDULER_TARGET_ROLE_ARN;
    try {
      const { handler } = await import('./handler.js');
      const response = await handler(event());
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({ error: 'internal error' });
    } finally {
      if (priorOutboundArn === undefined) delete process.env.OUTBOUND_FN_ARN;
      else process.env.OUTBOUND_FN_ARN = priorOutboundArn;
      if (priorRoleArn === undefined) delete process.env.SCHEDULER_TARGET_ROLE_ARN;
      else process.env.SCHEDULER_TARGET_ROLE_ARN = priorRoleArn;
    }
  });
});

describe('EventBridge dose-schedule restoration adapter', () => {
  it('rejects missing target configuration before a Scheduler call', async () => {
    const send = vi.fn();
    const { createSchedulerRestorer } = await import('./handler.js');

    expect(() =>
      createSchedulerRestorer({ send }, vi.fn(), {
        outboundFnArn: '',
        schedulerTargetRoleArn: '',
      }),
    ).toThrow(/configuration is missing/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('clears the patient dose prefix and recreates the exact local one-shot payload', async () => {
    const send = vi.fn().mockResolvedValue({});
    const resetDoseSchedules = vi.fn().mockResolvedValue(2);
    const { createSchedulerRestorer } = await import('./handler.js');
    const restorer = createSchedulerRestorer({ send }, resetDoseSchedules, {
      outboundFnArn: 'arn:aws:lambda:ca-central-1:000000000000:function:outbound',
      schedulerTargetRoleArn: 'arn:aws:iam::000000000000:role/scheduler-target',
    });

    await restorer.reset(PATIENT_ID);
    await restorer.create({
      patientId: PATIENT_ID,
      doseId: DOSE_ID,
      doseDate: '2026-08-15',
      localDoseTime: '09:15',
      scheduleTimezone: 'America/Toronto',
    });

    expect(resetDoseSchedules).toHaveBeenNthCalledWith(1, PATIENT_ID, 'dose');
    expect(resetDoseSchedules).toHaveBeenNthCalledWith(2, PATIENT_ID, 'reminder');
    expect(resetDoseSchedules).toHaveBeenNthCalledWith(3, PATIENT_ID, 'timeout');
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Name: `dose-${PATIENT_ID}-${DOSE_ID}`.slice(0, 64),
      GroupName: 'medadhere-prod',
      ScheduleExpression: 'at(2026-08-15T09:15:00)',
      ScheduleExpressionTimezone: 'America/Toronto',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
    });
    const target = command.input.Target as { Arn: string; RoleArn: string; Input: string };
    expect(target).toEqual({
      Arn: 'arn:aws:lambda:ca-central-1:000000000000:function:outbound',
      RoleArn: 'arn:aws:iam::000000000000:role/scheduler-target',
      Input: JSON.stringify({ patientId: PATIENT_ID, doseId: DOSE_ID }),
    });
  });
});
