// backend/src/enroll-api/handler.test.ts
//
// Network-free unit test of the enroll-api WRITE PATH (DASH-05 / D2). The enroll-api Lambda is a lean
// NON-VPC fn: it zod-validates the enrollment body (400-first), SYNC-invokes the in-VPC Enroll Lambda,
// and maps the outcome → 201 / static-409 / 502 WITHOUT ever forwarding the Enroll throw's embedded
// patient UUID + remediation SQL into an HTTP body (the whole point of D2).
//
// The handler's ONLY AWS side effect is the Lambda invoke, which is expressed as an injected
// `invokeEnroll` seam over the PURE core (core.ts) — mirroring the export-anon core/handler DI split.
// So this test drives the core in isolation with a fake invoker: no @aws-sdk, no AWS, no network.
//
// Asserts (the D2 security + mapping contract):
//   1. valid body → invokeEnroll called with the mapped EnrollEvent (is_test forwarded; startDate
//      defaulted when absent) → 201 { patientId }.
//   2. invalid body (bad phone / missing is_test / localTimes over the cap / unparseable) → 400 FIRST,
//      generic, invokeEnroll NEVER called, and the 400 body never echoes the submitted phone value.
//   3. dup-active FunctionError → the EXACT static 409 string; the 409 body contains NO patient UUID,
//      NO `UPDATE ... SET is_active` SQL, and NO phone.
//   4. other FunctionError / invoke throw / malformed success → generic 502 (no internals leaked).
//   5. logs never contain the phone or the medication_name (id-only PII-safe logMetric).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateDoseSchedule } from '@medadhere/shared';
import {
  runEnrollApi as runEnrollApiCore,
  DUP_ACTIVE_MESSAGE,
  MAX_ENROLL_DAYS,
  MAX_LOCAL_TIMES,
  type EnrollInvokePayload,
  type EnrollInvokeOutcome,
} from './core.js';

const { lambdaSend } = vi.hoisted(() => ({ lambdaSend: vi.fn() }));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

const PHONE = '+15145550123';
const MED = 'Metformin';
const OWNER_SUB = '9d2c9a43-1f08-4fac-b1dd-b41fd85bcdd4';

function runEnrollApi(
  args: Omit<Parameters<typeof runEnrollApiCore>[0], 'ownerClinicianSub'> & {
    ownerClinicianSub?: string;
  },
) {
  return runEnrollApiCore({ ownerClinicianSub: OWNER_SUB, ...args });
}

/** A well-formed enrollment body (the shape the /patients/new form + the enroll-api zod agree on). */
function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phone: PHONE,
    medication_name: MED,
    display_name: 'Alex',
    timezone: 'America/Toronto',
    localTimes: ['09:00'],
    is_test: true,
    ...overrides,
  });
}

/** A fake invoker that records the forwarded payload and returns a canned outcome. */
function fakeInvoker(outcome: EnrollInvokeOutcome): {
  invokeEnroll: (p: EnrollInvokePayload) => Promise<EnrollInvokeOutcome>;
  calls: EnrollInvokePayload[];
} {
  const calls: EnrollInvokePayload[] = [];
  return {
    calls,
    invokeEnroll: async (p: EnrollInvokePayload) => {
      calls.push(p);
      return outcome;
    },
  };
}

/** The Enroll Lambda's success result payload (JSON), as AWS returns it under RequestResponse. */
function enrollSuccess(patientId = 'new-patient-uuid-1'): EnrollInvokeOutcome {
  return {
    functionError: false,
    payloadText: JSON.stringify({ enrolled: true, patientId, doseCount: 1 }),
  };
}

/** The Enroll Lambda's stable, non-PHI duplicate-active FunctionError payload. */
const PRIOR_UUID = '6b6f55a0-64e5-47a3-8f5c-e34795ac440b';
function enrollDupActive(): EnrollInvokeOutcome {
  return {
    functionError: true,
    payloadText: JSON.stringify({
      errorType: 'ActivePatientConflictError',
      errorMessage: 'ENROLL_ACTIVE_PATIENT_CONFLICT',
      trace: ['at handler (/var/task/index.js:1:1)'],
    }),
  };
}

/** A legacy/leaky generic error must never be mistaken for the stable conflict class or logged. */
function legacyLeakyError(): EnrollInvokeOutcome {
  return {
    functionError: true,
    payloadText: JSON.stringify({
      errorType: 'Error',
      errorMessage:
        `an ACTIVE patient row already exists for phone ${PHONE} (id: ${PRIOR_UUID}); ` +
        `UPDATE patient SET is_active = false WHERE id = '${PRIOR_UUID}'`,
    }),
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('enroll-api core — happy path (D2 → 201)', () => {
  it('forwards the mapped EnrollEvent (is_test carried, D14) and returns 201 { patientId } on success', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess('pt-9'));
    const res = await runEnrollApi({
      rawBody: validBody(),
      invokeEnroll,
      now: () => new Date('2026-08-20T00:00:00Z'),
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ patientId: 'pt-9' });

    // The invoke received the mapped payload exactly once, carrying is_test (D14) + the form fields.
    expect(calls).toHaveLength(1);
    const p = calls[0]!;
    expect(p.phone).toBe(PHONE);
    expect(p.medication_name).toBe(MED);
    expect(p.owner_clinician_sub).toBe(OWNER_SUB);
    expect(p.is_test).toBe(true);
    expect(p.localTimes).toEqual(['09:00']);
  });

  it('uses the server-derived owner even when the request body tries to supply another owner', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({
      rawBody: validBody({ owner_clinician_sub: '8f6e7138-fd21-4b31-8ac3-934cfc610f44' }),
      invokeEnroll,
    });

    expect(calls[0]!.owner_clinician_sub).toBe(OWNER_SUB);
  });

  it('defaults startDate to today (YYYY-MM-DD) when the body omits it (the form has no startDate field)', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({
      rawBody: validBody(),
      invokeEnroll,
      now: () => new Date('2026-08-20T12:00:00Z'),
    });
    expect(calls[0]!.startDate).toBe('2026-08-20');
  });

  it('derives startDate from the submitted zone behind UTC near midnight', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({
      rawBody: validBody({ timezone: 'America/Toronto' }),
      invokeEnroll,
      now: () => new Date('2026-08-10T03:30:00Z'),
    });
    expect(calls[0]!.startDate).toBe('2026-08-09');
  });

  it('derives startDate from the submitted zone ahead of UTC near midnight', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({
      rawBody: validBody({ timezone: 'Asia/Tokyo' }),
      invokeEnroll,
      now: () => new Date('2026-08-09T16:30:00Z'),
    });
    expect(calls[0]!.startDate).toBe('2026-08-10');
  });

  it('forwards an explicit startDate verbatim when provided', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({ rawBody: validBody({ startDate: '2026-09-01' }), invokeEnroll });
    expect(calls[0]!.startDate).toBe('2026-09-01');
  });

  it('forwards days verbatim when provided', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({ rawBody: validBody({ days: 3 }), invokeEnroll });
    expect(calls[0]!.days).toBe(3);
  });

  it('forwards a three-day, two-time payload as a six-slot-valid schedule contract', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({
      rawBody: validBody({ days: 3, localTimes: ['09:00', '20:00'] }),
      invokeEnroll,
    });
    expect(calls[0]!.days).toBe(3);
    expect(calls[0]!.localTimes).toEqual(['09:00', '20:00']);
    expect(
      generateDoseSchedule({
        startDate: calls[0]!.startDate,
        days: calls[0]!.days!,
        localTimes: calls[0]!.localTimes!,
        timezone: calls[0]!.timezone!,
      }),
    ).toHaveLength(6);
  });

  it('leaves days absent when omitted so the Enroll Lambda legacy fallback applies', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({ rawBody: validBody(), invokeEnroll });
    expect(calls[0]!.days).toBeUndefined();
  });

  it('carries is_test=false through when the form leaves the checkbox unchecked', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    await runEnrollApi({ rawBody: validBody({ is_test: false }), invokeEnroll });
    expect(calls[0]!.is_test).toBe(false);
  });
});

describe('enroll-api handler — verified clinician ownership', () => {
  it('forwards the verified JWT subject and ignores a caller-supplied owner', async () => {
    vi.resetModules();
    process.env.ENROLL_FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:Enroll';
    lambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ enrolled: true, patientId: 'pt-9', doseCount: 1 })),
    });
    const { handler } = await import('./handler.js');

    const response = await handler({
      body: validBody({ owner_clinician_sub: '8f6e7138-fd21-4b31-8ac3-934cfc610f44' }),
      requestContext: {
        authorizer: {
          jwt: { claims: { sub: OWNER_SUB, token_use: 'id' } },
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const command = lambdaSend.mock.calls[0]![0] as {
      input: { Payload: Uint8Array };
    };
    const payload = JSON.parse(Buffer.from(command.input.Payload).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(payload.owner_clinician_sub).toBe(OWNER_SUB);
  });

  it('rejects missing verified claims before invoking the Enroll Lambda', async () => {
    vi.resetModules();
    process.env.ENROLL_FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:Enroll';
    const { handler } = await import('./handler.js');

    const response = await handler({ body: validBody() });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});

describe('enroll-api core — 400-first validation (D2, generic, no value echo)', () => {
  it('rejects a non-E.164 phone with a generic 400 and NEVER invokes the Enroll Lambda', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({ rawBody: validBody({ phone: '514-555-0123' }), invokeEnroll });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    // The 400 body is generic and does NOT echo the submitted phone value.
    expect(res.body).not.toContain('514-555-0123');
  });

  it('rejects an empty medication_name (400) without invoking', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({ rawBody: validBody({ medication_name: '' }), invokeEnroll });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a medication_name longer than 120 characters (400) without invoking', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({
      rawBody: validBody({ medication_name: 'm'.repeat(121) }),
      invokeEnroll,
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a display_name longer than 80 characters (400) without invoking', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({
      rawBody: validBody({ display_name: 'd'.repeat(81) }),
      invokeEnroll,
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unrecognized IANA timezone (400) before invoking', async () => {
    const submittedTimezone = 'America/Torono';
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({
      rawBody: validBody({ timezone: submittedTimezone }),
      invokeEnroll,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid enrollment request' });
    expect(res.body).not.toContain(submittedTimezone);
    expect(calls).toHaveLength(0);
  });

  it.each(['local', 'system', 'UTC+5'])(
    'rejects the host-dependent or pseudo timezone %s before invoking',
    async (timezone) => {
      const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
      const res = await runEnrollApi({ rawBody: validBody({ timezone }), invokeEnroll });
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['GMT', 'EST5EDT'])('accepts the Intl-supported timezone %s', async (timezone) => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({ rawBody: validBody({ timezone }), invokeEnroll });
    expect(res.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it('rejects a missing is_test (400 — is_test is required in the schema, D2/D14)', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({
      rawBody: JSON.stringify({ phone: PHONE, medication_name: MED }),
      invokeEnroll,
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it(`rejects a localTimes array over the ${MAX_LOCAL_TIMES}-entry cap (400)`, async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const tooMany = Array.from({ length: MAX_LOCAL_TIMES + 1 }, () => '09:00');
    const res = await runEnrollApi({ rawBody: validBody({ localTimes: tooMany }), invokeEnroll });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-HH:mm localTime (400)', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    const res = await runEnrollApi({ rawBody: validBody({ localTimes: ['9am'] }), invokeEnroll });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([0, MAX_ENROLL_DAYS + 1, 2.5])(
    'rejects invalid days=%s (400) before invoking',
    async (days) => {
      const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
      const res = await runEnrollApi({ rawBody: validBody({ days }), invokeEnroll });
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects an unparseable / missing body with a generic 400 (no invoke)', async () => {
    const { invokeEnroll, calls } = fakeInvoker(enrollSuccess());
    expect((await runEnrollApi({ rawBody: 'not-json', invokeEnroll })).statusCode).toBe(400);
    expect((await runEnrollApi({ rawBody: undefined, invokeEnroll })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('enroll-api → Enroll schedule contract (EXEC-01)', () => {
  it('a three-day payload yields one slot on each of three consecutive local dates', () => {
    const slots = generateDoseSchedule({
      startDate: '2026-08-09',
      days: 3,
      localTimes: ['09:00'],
      timezone: 'America/Toronto',
    });
    expect(slots).toEqual([
      { doseDate: '2026-08-09', localDoseTime: '09:00' },
      { doseDate: '2026-08-10', localDoseTime: '09:00' },
      { doseDate: '2026-08-11', localDoseTime: '09:00' },
    ]);
  });
});

describe('enroll-api core — dup-active → STATIC 409 (D2, never leaks the Enroll throw)', () => {
  it('maps the dup-active FunctionError to the EXACT static 409 string', async () => {
    const { invokeEnroll } = fakeInvoker(enrollDupActive());
    const res = await runEnrollApi({ rawBody: validBody(), invokeEnroll });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: DUP_ACTIVE_MESSAGE });
    expect(DUP_ACTIVE_MESSAGE).toBe(
      'a patient with this phone may already be enrolled — check the list',
    );
  });

  it('does not classify a legacy message substring as a duplicate without the stable conflict class', async () => {
    const { invokeEnroll } = fakeInvoker(legacyLeakyError());
    const res = await runEnrollApi({ rawBody: validBody(), invokeEnroll });

    expect(res.statusCode).toBe(502);
  });

  it('the 409 body contains NO patient UUID, NO remediation SQL, and NO phone (the Enroll throw is never forwarded)', async () => {
    const { invokeEnroll } = fakeInvoker(enrollDupActive());
    const res = await runEnrollApi({ rawBody: validBody(), invokeEnroll });
    expect(res.body).not.toContain(PRIOR_UUID);
    expect(res.body).not.toContain('UPDATE patient');
    expect(res.body).not.toContain('is_active');
    expect(res.body).not.toContain(PHONE);
    expect(res.body).not.toContain('REV-H4');
  });
});

describe('enroll-api core — non-dup failures → generic 502 (no internals leaked)', () => {
  it('maps an unrecognized FunctionError to a generic 502 (never the raw errorMessage)', async () => {
    const { invokeEnroll } = fakeInvoker({
      functionError: true,
      payloadText: JSON.stringify({
        errorType: 'Error',
        errorMessage: 'DB_HOST env var is not set at db.internal',
        trace: [],
      }),
    });
    const res = await runEnrollApi({ rawBody: validBody(), invokeEnroll });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('db.internal');
    expect(res.body).not.toContain('DB_HOST');
  });

  it('maps an invoke-level throw to a generic 502', async () => {
    const res = await runEnrollApi({
      rawBody: validBody(),
      invokeEnroll: async () => {
        throw new Error('Lambda throttled at arn:aws:lambda:...:Enroll');
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('arn:aws:lambda');
  });

  it('maps a malformed success payload (enrolled!==true / no patientId) to a generic 502', async () => {
    const bad = fakeInvoker({
      functionError: false,
      payloadText: JSON.stringify({ enrolled: false }),
    });
    expect(
      (await runEnrollApi({ rawBody: validBody(), invokeEnroll: bad.invokeEnroll })).statusCode,
    ).toBe(502);

    const noId = fakeInvoker({
      functionError: false,
      payloadText: JSON.stringify({ enrolled: true }),
    });
    expect(
      (await runEnrollApi({ rawBody: validBody(), invokeEnroll: noId.invokeEnroll })).statusCode,
    ).toBe(502);
  });
});

describe('enroll-api core — PII-safe logs (never phone / medication_name)', () => {
  it('never writes the phone or the medication_name to the logs across success + dup-active + error paths', async () => {
    const success = fakeInvoker(enrollSuccess());
    await runEnrollApi({ rawBody: validBody(), invokeEnroll: success.invokeEnroll });
    const dup = fakeInvoker(enrollDupActive());
    await runEnrollApi({ rawBody: validBody(), invokeEnroll: dup.invokeEnroll });
    const legacyLeaky = fakeInvoker(legacyLeakyError());
    await runEnrollApi({ rawBody: validBody(), invokeEnroll: legacyLeaky.invokeEnroll });
    await runEnrollApi({
      rawBody: validBody({ phone: 'bad' }),
      invokeEnroll: success.invokeEnroll,
    });

    const logged = (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(PHONE);
    expect(logged).not.toContain(MED);
    // ...and the prior-patient UUID / SQL never reach the logs either (id-only metric lines).
    expect(logged).not.toContain(PRIOR_UUID);
    expect(logged).not.toContain('UPDATE patient');
  });
});
