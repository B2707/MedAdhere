// backend/src/enroll-api/handler.ts
//
// The lean NON-VPC enroll-api Lambda entry (DASH-05 / D2) — the ONLY public write front for enrollment.
// It sits behind the SAME API GW HTTP API + Cognito JWT defaultAuthorizer as the read router
// (POST /api/patients), holds NO pg client / NO DB secret / NO VPC attachment, and its ONLY AWS side
// effect is a synchronous (RequestResponse) invoke of the in-VPC Enroll Lambda:
//
//   Bearer id_token → API GW ( Cognito JWT authorizer = the enforcement boundary, D-09 )
//     → POST /api/patients → THIS lean fn → zod 400-first → InvokeCommand(Enroll, RequestResponse)
//     → 201 { patientId } | static 409 | 502
//
// All validation + response mapping + the D2 security posture (never forward the Enroll throw's UUID + SQL)
// live in the PURE core (core.ts). This entry supplies the single real seam: `invokeEnroll`, wrapping the
// runtime-provided `@aws-sdk/client-lambda` (externalized by esbuild — see aws-sdk-client-lambda.d.ts).
//
// The Enroll fn ARN arrives as ENROLL_FN_ARN via the FoundationStack POST-WIRE (the Enroll construct is
// built AFTER DataApiConstruct, so the grant + env are wired at stack level — U-4). Module mode: CommonJS.

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  runEnrollApi,
  type EnrollInvokePayload,
  type EnrollInvokeOutcome,
  type HttpResult,
} from './core.js';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims.js';

/** Reuse the Lambda client across warm invocations (module scope → fewer TLS handshakes). */
const lambda = new LambdaClient({});

/** The API GW v2 HTTP-proxy event subset this handler consumes (the body + its base64 flag). */
interface ApiGatewayProxyEventV2 {
  body?: string;
  isBase64Encoded?: boolean;
  routeKey?: string;
  requestContext?: {
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
}

/** PII-safe structured metric line (ids + counts ONLY — never phone / medication_name). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** The generic error envelope for the misconfigured-fn guard (mirrors core's generic 502 body). */
function genericError(statusCode: number): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'could not complete enrollment — please try again' }),
  };
}

/**
 * The enroll-api entrypoint. Extracts the request body, builds the SDK-backed `invokeEnroll` seam, and
 * delegates all validation + mapping to the pure core. The invoke is `RequestResponse` so the core can map
 * the dup-active FunctionError to the static 409 synchronously.
 */
export async function handler(event: ApiGatewayProxyEventV2): Promise<HttpResult> {
  let ownerClinicianSub: string;
  try {
    ({ sub: ownerClinicianSub } = requireClinicianClaims(event));
  } catch (error) {
    if (!(error instanceof ClinicianClaimsError)) throw error;
    logMetric({ metric: 'enroll_api_unauthorized' });
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }
  const enrollFnArn = process.env.ENROLL_FN_ARN;
  if (!enrollFnArn) {
    // The stack post-wire (U-4) sets ENROLL_FN_ARN; its absence is a deploy-time misconfig, not a client
    // error. Fail generic (never echo any internal detail).
    logMetric({ metric: 'enroll_api_misconfigured' });
    return genericError(502);
  }

  const rawBody =
    event?.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event?.body;

  const invokeEnroll = async (payload: EnrollInvokePayload): Promise<EnrollInvokeOutcome> => {
    const out = await lambda.send(
      new InvokeCommand({
        FunctionName: enrollFnArn,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    const payloadText = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
    // `FunctionError` is set ('Handled'|'Unhandled') iff the Enroll Lambda threw; the core classifies it.
    return {
      functionError: out.FunctionError !== undefined && out.FunctionError !== '',
      payloadText,
    };
  };

  return runEnrollApi({ rawBody, ownerClinicianSub, invokeEnroll });
}
