import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import twilio from 'twilio';
import {
  HELP_AUTO_REPLY,
  INTAKE_LIMIT_NOTICE,
  MEDIA_UNSUPPORTED_REPLY,
  buildInitialInboundReplyWake,
  isHelpKeyword,
  isStartKeyword,
  isStopKeyword,
  runSafetyPrefilter,
  safetyAutoReplyEmergency,
} from '@medadhere/shared';
import { deactivateSchedules } from '../lib/scheduler-deactivate';
import { createDbPoolProvider } from '../shared/db-pool';
import {
  markInboundEnqueued,
  reserveInboundIntake,
  sweepStopSchedulesUnderCurrentEpoch,
  type ReserveInboundIntakeResult,
} from './intake-repository.js';

interface ApiGatewayProxyEventV2 {
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

interface HttpResult {
  readonly statusCode: number;
  readonly headers: { readonly 'content-type': string };
  readonly body: string;
}

interface TwilioSecret {
  readonly accountSid: string;
  readonly authToken: string;
}

type ProviderControl = 'stop' | 'start' | 'help';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const sm = new SecretsManagerClient({});
const sqs = new SQSClient({});
const getPool = createDbPoolProvider(sm);

function twiml(statusCode = 200, body = EMPTY_TWIML): HttpResult {
  return { statusCode, headers: { 'content-type': 'text/xml' }, body };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function twimlMessage(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`;
}

function emergencyResponse(): HttpResult {
  return twiml(200, twimlMessage(safetyAutoReplyEmergency('en')));
}

function retryableResponse(): HttpResult {
  return twiml(503);
}

function logMetric(entry: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify(entry));
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : '';
  return name ? name.slice(0, 64) : 'unknown';
}

function parseProviderControl(value: string | undefined): ProviderControl | null {
  if (value === 'STOP') return 'stop';
  if (value === 'START') return 'start';
  if (value === 'HELP') return 'help';
  return null;
}

function header(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

async function getTwilioCreds(): Promise<TwilioSecret> {
  const secretArn = process.env.TWILIO_SECRET_ARN;
  if (!secretArn) throw new Error('TWILIO_SECRET_ARN env var is not set');

  const secret = await sm.send(
    new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }),
  );
  if (!secret.SecretString || secret.SecretString.trim() === '') {
    throw new Error('Twilio secret is empty');
  }
  let parsed: Partial<TwilioSecret>;
  try {
    parsed = JSON.parse(secret.SecretString) as Partial<TwilioSecret>;
  } catch {
    throw new Error('Twilio secret is not valid JSON');
  }
  if (!parsed.accountSid || !parsed.authToken) {
    throw new Error('Twilio secret requires accountSid and authToken');
  }
  return { accountSid: parsed.accountSid, authToken: parsed.authToken };
}

async function enqueueStoredInbound(
  db: Pool,
  reservation: Exclude<ReserveInboundIntakeResult, { kind: 'unmatched' }>,
  messageSid: string,
): Promise<'queued' | 'enqueue_failed' | 'stamp_failed'> {
  if (!reservation.shouldEnqueue) return 'queued';

  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) {
    logMetric({
      metric: 'inbound_enqueue_failure',
      errorName: 'MissingQueueUrl',
    });
    return 'enqueue_failed';
  }

  try {
    const input = buildInitialInboundReplyWake({
      queueUrl,
      inboundMessageId: reservation.inboundMessageId,
      patientId: reservation.patientId,
      messageSid,
    });
    const sent = await sqs.send(new SendMessageCommand(input));
    if (!sent.MessageId) throw new Error('SQS send returned no MessageId');
  } catch (error) {
    logMetric({
      metric: 'inbound_enqueue_failure',
      errorName: errorName(error),
    });
    return 'enqueue_failed';
  }

  try {
    await markInboundEnqueued(db, reservation.inboundMessageId);
    return 'queued';
  } catch (error) {
    logMetric({
      metric: 'inbound_enqueue_stamp_failure',
      errorName: errorName(error),
    });
    return 'stamp_failed';
  }
}

/** Public Twilio webhook. HMAC is the sole authentication boundary for this route. */
export async function handler(event: ApiGatewayProxyEventV2): Promise<HttpResult> {
  const rawBody = event.body ?? '';
  const decodedBody = event.isBase64Encoded
    ? Buffer.from(rawBody, 'base64').toString('utf8')
    : rawBody;
  const params = new URLSearchParams(decodedBody);
  const fullParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) fullParams[key] = value;

  const inboundUrl = process.env.INBOUND_URL;
  if (!inboundUrl) throw new Error('INBOUND_URL env var is not set');
  const credentials = await getTwilioCreds();
  const signature = header(event.headers, 'x-twilio-signature') ?? '';
  if (!twilio.validateRequest(credentials.authToken, signature, inboundUrl, fullParams)) {
    return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: '' };
  }

  const messageSid = fullParams.MessageSid ?? fullParams.SmsSid;
  const from = fullParams.From;
  const body = fullParams.Body ?? '';
  if (!messageSid || !from) {
    logMetric({ metric: 'inbound_malformed_params', hasMessageSid: Boolean(messageSid) });
    return twiml();
  }

  // OptOutType is trusted only after the full form passes Twilio HMAC validation. When Twilio
  // supplies a recognized control it is authoritative over Body; the exact Body fallback keeps
  // the legacy route working when Advanced Opt-Out omits the field.
  const providerControl = parseProviderControl(fullParams.OptOutType);
  const control =
    providerControl ??
    (isStopKeyword(body)
      ? 'stop'
      : isStartKeyword(body)
        ? 'start'
        : isHelpKeyword(body)
          ? 'help'
          : null);
  const prefilter = runSafetyPrefilter(body);
  const isEmergency = prefilter.hit && prefilter.category !== null;
  // M-13: media is stored as an unread inbound row and answered with the fixed text-only reply.
  // The attachment URL is never read, so an unparsable count is treated as media and stays out
  // of the model path. Controls and the safety divert still take precedence below.
  const hasMedia = (fullParams.NumMedia ?? '0').trim() !== '0';

  let db: Pool;
  let reservation: ReserveInboundIntakeResult;
  try {
    db = await getPool();
    reservation = await reserveInboundIntake(db, {
      phone: from,
      rawBody: body,
      emergencyCategory: prefilter.category,
      messageSid,
      createTurnJob: control === null && !isEmergency && !hasMedia,
      control,
    });
  } catch (error) {
    if (isEmergency) {
      logMetric({
        metric: 'inbound_emergency_persistence_failed',
        errorName: errorName(error),
      });
    } else {
      logMetric({
        metric: 'inbound_intake_failure',
        errorName: errorName(error),
      });
    }
    return isEmergency ? emergencyResponse() : retryableResponse();
  }

  if (reservation.kind === 'unmatched') {
    logMetric({
      metric: 'inbound_no_single_active_match',
      matchCount: reservation.matchCount,
    });
    return isEmergency ? emergencyResponse() : twiml();
  }

  if (reservation.kind === 'duplicate') {
    logMetric({ metric: 'inbound_duplicate_sid' });
  }

  if (reservation.shouldSweepSchedules) {
    await sweepStopSchedulesUnderCurrentEpoch(
      db,
      {
        patientId: reservation.patientId,
        inboundMessageId: reservation.inboundMessageId,
      },
      async () => {
        await deactivateSchedules(reservation.patientId, 'dose');
        await deactivateSchedules(reservation.patientId, 'reminder');
        await deactivateSchedules(reservation.patientId, 'timeout');
      },
    );
  }

  if (control === 'stop') {
    logMetric({
      metric: 'inbound_stop',
      replay: reservation.kind === 'duplicate',
    });
    return twiml();
  }

  if (control === 'start') {
    if (reservation.kind === 'new') {
      logMetric({
        metric: 'inbound_start',
      });
    }
    return twiml();
  }

  if (control === 'help') {
    if (reservation.kind === 'new') {
      logMetric({
        metric: 'inbound_help',
      });
    }
    return providerControl === 'help' ? twiml() : twiml(200, twimlMessage(HELP_AUTO_REPLY));
  }

  if (isEmergency && prefilter.category) {
    if (reservation.kind === 'new' && reservation.safetyEventId) {
      logMetric({
        metric: 'safety_event_recorded',
        source: 'prefilter',
      });
    }
    return emergencyResponse();
  }

  if (reservation.rateLimited) {
    logMetric({
      metric: 'inbound_intake_limited',
      notified: reservation.rateLimited === 'notice',
    });
    return reservation.rateLimited === 'notice'
      ? twiml(200, twimlMessage(INTAKE_LIMIT_NOTICE))
      : twiml();
  }

  if (hasMedia) {
    logMetric({
      metric: 'inbound_media_unsupported',
    });
    return twiml(200, twimlMessage(MEDIA_UNSUPPORTED_REPLY));
  }

  const handoff = await enqueueStoredInbound(db, reservation, messageSid);
  return handoff === 'queued' ? twiml() : retryableResponse();
}
