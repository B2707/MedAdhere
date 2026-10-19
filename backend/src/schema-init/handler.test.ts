/**
 * handler.test.ts — F65 mocked unit test of the schema-init custom-resource handler's PURE logic.
 *
 * NO real AWS, NO real DB, NO Docker, NO credentials. `pg` and `@aws-sdk/client-secrets-manager`
 * are fully mocked so the test drives the Create/Update/Delete lifecycle in isolation and asserts:
 *   - Delete  → echoes the incoming PhysicalResourceId AND issues ZERO pg queries (no DROP, no connect)
 *   - Create  → returns the STABLE id "medadhere-schema" with BEGIN → <schema sql> → COMMIT ordering
 *   - Update  → returns the SAME stable id (never a fresh id — the CFN replace-then-delete hazard)
 *   - thrown query → ROLLBACK (not COMMIT) + rethrow (D-12 atomic)
 *
 * This is the regression gate for the schema-init bug class (e.g. a DROP-on-Delete that passes
 * typecheck but would roll back NAT/RDS on a live deploy) — caught here in CI, not on a live rollback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CdkCustomResourceEvent } from 'aws-lambda';

// `vi.mock` is hoisted above all top-level statements, so the spy fns the factories reference must
// be created inside `vi.hoisted` (which is also hoisted) — a plain `const fn = vi.fn()` would be
// accessed before initialization. The handler constructs `new SecretsManagerClient({})` / `new
// Client(...)` at import time, so the factory constructors must be `new`-able real `function`s
// (an arrow `() => ({...})` is not constructable).
const { queryMock, connectMock, endMock, sendMock, clientArgs } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  endMock: vi.fn(),
  sendMock: vi.fn(),
  // M-2 — captures the `new Client({...})` constructor args so the test can assert the CA-pinning
  // TLS config (`ssl.ca` non-empty PEM + `ssl.rejectUnauthorized === true`) the handler must use.
  clientArgs: [] as Array<Record<string, unknown>>,
}));

// --- mock pg: a single Client instance whose methods are the hoisted spies the test inspects ----
// The ctor pushes its args into `clientArgs` so the M-2 TLS-config assertion can read them.
vi.mock('pg', () => ({
  Client: vi.fn(function (config: Record<string, unknown>) {
    clientArgs.push(config);
    return { connect: connectMock, query: queryMock, end: endMock };
  }),
}));

// --- mock Secrets Manager: GetSecretValueCommand returns a fake DB credential JSON --------------
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: sendMock };
  }),
  GetSecretValueCommand: vi.fn(function (args: unknown) {
    return { __args: args };
  }),
}));

// Import AFTER the mocks are registered (handler captures the mocked modules at import time).
import { handler } from './handler.js';

const SCHEMA_PHYSICAL_ID = 'medadhere-schema';

function baseEvent(): Record<string, unknown> {
  return {
    ServiceToken: 'arn:aws:lambda:us-east-1:000000000000:function:schema-init',
    ResponseURL: 'https://example.invalid/cfn-response',
    StackId: 'arn:aws:cloudformation:us-east-1:000000000000:stack/medadhere/abc',
    RequestId: 'req-123',
    LogicalResourceId: 'SchemaInit',
    ResourceType: 'Custom::SchemaInit',
    ResourceProperties: { ServiceToken: 'x', SqlHash: 'hash-v1' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientArgs.length = 0; // reset the captured pg Client ctor args (M-2)
  // Default: Secrets Manager returns a well-formed DB credential secret.
  sendMock.mockImplementation((command: { __args?: { SecretId?: string } }) => {
    const secretId = command.__args?.SecretId;
    if (secretId === process.env.DB_ADMIN_SECRET_ARN) {
      return Promise.resolve({
        SecretString: JSON.stringify({ username: 'medadhere_admin', password: 'admin-pw' }),
      });
    }
    if (secretId === process.env.DB_APP_SECRET_ARN) {
      return Promise.resolve({
        SecretString: JSON.stringify({ username: 'medadhere_app', password: "app'pw" }),
      });
    }
    if (secretId === process.env.DB_INBOUND_SECRET_ARN) {
      return Promise.resolve({
        SecretString: JSON.stringify({ username: 'medadhere_inbound', password: 'inbound-pw' }),
      });
    }
    if (secretId === process.env.DB_STATUS_CALLBACK_SECRET_ARN) {
      return Promise.resolve({
        SecretString: JSON.stringify({
          username: 'medadhere_status_callback',
          password: 'status-pw',
        }),
      });
    }
    if (secretId === process.env.DB_SOURCE_IMPORT_SECRET_ARN) {
      return Promise.resolve({
        SecretString: JSON.stringify({
          username: 'medadhere_source_import',
          password: 'source-pw',
        }),
      });
    }
    return Promise.resolve({});
  });
  // Default: every pg query resolves (BEGIN / schema / COMMIT / ROLLBACK).
  queryMock.mockResolvedValue({ rows: [] });
  process.env.DB_ADMIN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-admin';
  process.env.DB_APP_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-app';
  process.env.DB_INBOUND_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-inbound';
  process.env.DB_STATUS_CALLBACK_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-status';
  process.env.DB_SOURCE_IMPORT_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-source';
  delete process.env.DB_SECRET_ARN;
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
});

describe('schema-init handler — Delete is a strict no-op (F65 / T-03-03)', () => {
  it('echoes the incoming PhysicalResourceId and issues ZERO pg queries (no DROP)', async () => {
    const event = {
      ...baseEvent(),
      RequestType: 'Delete',
      PhysicalResourceId: SCHEMA_PHYSICAL_ID,
    } as unknown as CdkCustomResourceEvent;

    const res = await handler(event);

    expect(res.PhysicalResourceId).toBe(SCHEMA_PHYSICAL_ID);
    // The whole point of F65: a Delete must NOT connect or run any query (no DROP, no connect-and-run).
    expect(queryMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('schema-init handler — Create applies the schema transactionally (F65 / D-12)', () => {
  it('returns the stable id "medadhere-schema" with BEGIN → schema → COMMIT ordering', async () => {
    const event = {
      ...baseEvent(),
      RequestType: 'Create',
    } as unknown as CdkCustomResourceEvent;

    const res = await handler(event);

    expect(res.PhysicalResourceId).toBe(SCHEMA_PHYSICAL_ID);
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Assert the transaction ordering: first BEGIN, last COMMIT, the schema SQL in between.
    const calls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    // The middle calls are the schema body followed by the idempotent runtime-role grant block.
    const middle = calls.slice(1, -1).join('\n');
    expect(middle).toMatch(/CREATE TABLE IF NOT EXISTS patient/);
    for (const role of [
      'medadhere_app',
      'medadhere_inbound',
      'medadhere_status_callback',
      'medadhere_source_import',
    ]) {
      expect(middle).toContain(role);
    }
    expect(middle).not.toMatch(/GRANT[^;]* ON ALL TABLES/i);
    expect(middle).not.toMatch(/GRANT[^;]*(?:USAGE|SELECT|UPDATE)[^;]*ON (?:ALL )?SEQUENCES?/i);
    expect(middle).not.toMatch(/GRANT[^;]*DELETE/i);
    expect(middle).toMatch(/ALTER DEFAULT PRIVILEGES/i);
    expect(middle).not.toMatch(/ALTER DEFAULT PRIVILEGES[^;]*GRANT/i);
    expect(middle).toMatch(/REVOKE ALL PRIVILEGES ON DATABASE .* FROM PUBLIC/i);
    expect(middle).toMatch(/REVOKE ALL ON SCHEMA public FROM PUBLIC/i);
    expect(middle).toMatch(/REVOKE ALL PRIVILEGES ON ALL TABLES .* FROM PUBLIC/i);
    expect(middle).toMatch(/REVOKE ALL PRIVILEGES ON ALL SEQUENCES .* FROM PUBLIC/i);
    expect(middle).toMatch(/GRANT CONNECT ON DATABASE/i);
    expect(middle).not.toMatch(/GRANT (?:CREATE|ALL)/i);
    expect(calls).not.toContain('ROLLBACK');
    expect(endMock).toHaveBeenCalled(); // connection closed in finally
  });

  it('reads separate admin and four least-privilege role passwords from Secrets Manager', async () => {
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await handler(event);
    expect(sendMock).toHaveBeenCalledTimes(5);
    expect(sendMock.mock.calls.map((call) => call[0].__args.SecretId)).toEqual([
      process.env.DB_ADMIN_SECRET_ARN,
      process.env.DB_APP_SECRET_ARN,
      process.env.DB_INBOUND_SECRET_ARN,
      process.env.DB_STATUS_CALLBACK_SECRET_ARN,
      process.env.DB_SOURCE_IMPORT_SECRET_ARN,
    ]);
    expect(clientArgs[0]).toMatchObject({ user: 'medadhere_admin', password: 'admin-pw' });
    const roleSql = queryMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(roleSql).toContain("PASSWORD 'app''pw'");
    expect(roleSql).toContain("PASSWORD 'inbound-pw'");
    expect(roleSql).toContain("PASSWORD 'status-pw'");
    expect(roleSql).toContain("PASSWORD 'source-pw'");
  });

  it('emits the exact application, public-webhook, and source-loader table grants', async () => {
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await handler(event);
    const roleSql = queryMock.mock.calls.map((call) => String(call[0])).join('\n');

    expect(roleSql).toMatch(
      /GRANT SELECT ON TABLE patient, dose_schedule, outbound_message, inbound_reply, adherence_record, safety_events, label_match, source_release, medication_identity_bridge, evidence_record, patient_medication, patient_medication_ingredient, ingredient_ddinter_map, ddinter_drug, medication_interaction, clinical_fact, turn_job, agent_turn, clinical_event, clinical_event_source, clinical_event_evidence, information_need, information_need_scope, information_need_event_candidate, information_need_transition, clinical_review_item, clinical_review_item_transition, daily_summary, clinician_review_draft, clinician_review_action, usage_bucket, provider_circuit, composer_control TO medadhere_app;/,
    );
    expect(roleSql).toMatch(
      /GRANT INSERT ON TABLE patient, dose_schedule, outbound_message, adherence_record, safety_events, label_match, patient_medication, patient_medication_ingredient, clinical_fact, agent_turn, clinical_event, clinical_event_source, clinical_event_evidence, information_need, information_need_scope, information_need_event_candidate, information_need_transition, clinical_review_item, clinical_review_item_transition, daily_summary, clinician_review_draft, clinician_review_action, usage_bucket, provider_circuit, composer_control TO medadhere_app;/,
    );
    expect(roleSql).not.toMatch(
      /GRANT UPDATE ON TABLE [^;]*(clinical_event_evidence|clinician_review_action)[^;]* TO medadhere_app;/,
    );
    expect(roleSql).toMatch(
      /GRANT SELECT ON TABLE patient, inbound_reply, turn_job, agent_turn, safety_events, usage_bucket TO medadhere_inbound;/,
    );
    expect(roleSql).toMatch(
      /GRANT INSERT ON TABLE inbound_reply, turn_job, safety_events, usage_bucket TO medadhere_inbound;/,
    );
    expect(roleSql).toMatch(
      /GRANT UPDATE \(provider_opted_in, agent_enabled, messaging_state_version, opted_out_at, next_inbound_sequence\) ON TABLE patient TO medadhere_inbound;/,
    );
    expect(roleSql).toMatch(
      /GRANT UPDATE ON TABLE inbound_reply, usage_bucket TO medadhere_inbound;/,
    );
    expect(roleSql).toMatch(
      /GRANT SELECT, UPDATE ON TABLE outbound_message TO medadhere_status_callback;/,
    );
    expect(roleSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE source_release TO medadhere_source_import;/,
    );
    expect(roleSql).toMatch(
      /GRANT INSERT ON TABLE source_release_file, evidence_record, medication_identity_bridge, ddinter_drug, ingredient_ddinter_map, medication_interaction TO medadhere_source_import;/,
    );
  });
});

describe('schema-init handler — M-2 verifies the RDS server cert against the pinned CA bundle', () => {
  it('constructs the pg Client with ssl.rejectUnauthorized:true AND a non-empty ssl.ca (the bundled RDS global CA PEM)', async () => {
    // This is the regression gate for the diff's highest-value security fix: an accidental revert to
    // `ssl: true` / `rejectUnauthorized:false` (encrypted-but-UNVERIFIED) must fail this test, because
    // it would silently re-open the SEC W-2 server-impersonation residual the CA pinning closed.
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await handler(event);

    expect(clientArgs).toHaveLength(1);
    const ssl = clientArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl).toBeDefined();
    // Server-cert verification is ON (NOT rejectUnauthorized:false, NOT bare `ssl:true`).
    expect(ssl?.rejectUnauthorized).toBe(true);
    // The pinned CA bundle is actually supplied — a non-empty PEM string (the real bundled bundle is
    // ~2700 lines; assert it is a non-trivial string so an empty/missing `ca` regresses the test).
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
  });
});

describe('schema-init handler — WR-04 guards the DB connection env vars (actionable, not opaque pg error)', () => {
  it.each([
    'DB_ADMIN_SECRET_ARN',
    'DB_APP_SECRET_ARN',
    'DB_INBOUND_SECRET_ARN',
    'DB_STATUS_CALLBACK_SECRET_ARN',
    'DB_SOURCE_IMPORT_SECRET_ARN',
  ])('throws before secret or DB access when %s is missing', async (variable) => {
    delete process.env[variable];
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await expect(handler(event)).rejects.toThrow(/DB role secret ARN env vars must all be set/);
    expect(sendMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects a role secret whose username does not match its dedicated role', async () => {
    sendMock.mockImplementation((command: { __args?: { SecretId?: string } }) => {
      if (command.__args?.SecretId === process.env.DB_ADMIN_SECRET_ARN) {
        return Promise.resolve({
          SecretString: JSON.stringify({ username: 'medadhere_admin', password: 'admin-pw' }),
        });
      }
      return Promise.resolve({
        SecretString: JSON.stringify({ username: 'medadhere_app', password: 'wrong-role-pw' }),
      });
    });
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await expect(handler(event)).rejects.toThrow(/DB secret username must be medadhere_inbound/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('throws an actionable error when DB_HOST is missing', async () => {
    delete process.env.DB_HOST;
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    // Mirrors the DB_SECRET_ARN guard: a clear message, NOT an opaque `host: undefined` pg crash that
    // would surface from inside a CFN custom resource as a full VPC/NAT/RDS rollback.
    await expect(handler(event)).rejects.toThrow(/DB_HOST \/ DB_PORT \/ DB_NAME/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('throws an actionable error when DB_NAME is missing', async () => {
    delete process.env.DB_NAME;
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await expect(handler(event)).rejects.toThrow(/DB_HOST \/ DB_PORT \/ DB_NAME/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('throws an actionable error when DB_PORT is not a valid integer (NaN guard)', async () => {
    process.env.DB_PORT = 'not-a-port';
    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;
    await expect(handler(event)).rejects.toThrow(/DB_PORT is not a valid integer/);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('schema-init handler — Update keeps the SAME stable id (F65 / CFN replace hazard)', () => {
  it('returns "medadhere-schema" (never a fresh id) on Update', async () => {
    const event = {
      ...baseEvent(),
      RequestType: 'Update',
      PhysicalResourceId: SCHEMA_PHYSICAL_ID,
      OldResourceProperties: { ServiceToken: 'x', SqlHash: 'hash-v0' },
    } as unknown as CdkCustomResourceEvent;

    const res = await handler(event);

    expect(res.PhysicalResourceId).toBe(SCHEMA_PHYSICAL_ID);
    const calls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });
});

describe('schema-init handler — a failed schema apply rolls back and rethrows (F65 / D-12)', () => {
  it('issues ROLLBACK (not COMMIT) and rethrows when the schema query throws', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
      if (sql === 'COMMIT') return Promise.resolve({ rows: [] });
      // The schema body throws (simulating a bad DDL statement).
      return Promise.reject(new Error('relation already exists'));
    });

    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;

    await expect(handler(event)).rejects.toThrow(/relation already exists/);

    const calls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(endMock).toHaveBeenCalled(); // connection still closed in finally
  });

  it('preserves the schema error when connection cleanup also fails', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
      return Promise.reject(new Error('primary schema failure'));
    });
    endMock.mockRejectedValueOnce(new Error('connection cleanup failure'));

    const event = { ...baseEvent(), RequestType: 'Create' } as unknown as CdkCustomResourceEvent;

    await expect(handler(event)).rejects.toThrow('primary schema failure');
    expect(endMock).toHaveBeenCalledOnce();
  });
});
