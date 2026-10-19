import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClinicalRecordConflictError } from '../clinical-knowledge/repository';

const {
  appendMedicationMock,
  appendFactMock,
  listHistoryMock,
  connectMock,
  releaseMock,
  smSendMock,
} = vi.hoisted(() => ({
  appendMedicationMock: vi.fn(),
  appendFactMock: vi.fn(),
  listHistoryMock: vi.fn(),
  connectMock: vi.fn(),
  releaseMock: vi.fn(),
  smSendMock: vi.fn(),
}));

vi.mock('../clinical-knowledge/repository', async () => {
  const actual = await vi.importActual<typeof import('../clinical-knowledge/repository')>(
    '../clinical-knowledge/repository',
  );
  return {
    ...actual,
    appendMedicationRevision: appendMedicationMock,
    appendClinicalFactRevision: appendFactMock,
    listClinicalHistory: listHistoryMock,
  };
});

vi.mock('pg', () => ({
  Pool: vi.fn(function () {
    return { connect: connectMock };
  }),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: smSendMock };
  }),
  GetSecretValueCommand: vi.fn(function (args: unknown) {
    return { args };
  }),
}));

const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CLINICIAN_SUB = '97b4a172-e055-4c37-9d95-2a00664dfe64';

function event(routeKey: string, body?: unknown) {
  return {
    routeKey,
    pathParameters: { id: PATIENT_ID },
    requestContext: {
      authorizer: { jwt: { claims: { sub: CLINICIAN_SUB, token_use: 'id' } } },
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function medicationBody() {
  return {
    enteredName: 'Amoxicillin / clavulanate',
    identity: { system: 'din', code: '02415322' },
    doseText: '875 mg / 125 mg',
    form: 'tablet',
    route: 'oral',
    validFrom: '2026-08-11',
    validTo: null,
    status: 'active',
    supersedesId: null,
    scheduleIds: [],
    ingredients: [
      { name: 'amoxicillin', ccddIngredientCode: 'TM-AMOX', rxcui: '723' },
      { name: 'clavulanate', ccddIngredientCode: 'TM-CLAV', rxcui: '21212' },
    ],
  };
}

async function freshHandler() {
  vi.resetModules();
  return (await import('./handler.js')).handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:app';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  smSendMock.mockResolvedValue({
    SecretString: JSON.stringify({ username: 'medadhere_app', password: 'pw' }),
  });
  connectMock.mockResolvedValue({ query: vi.fn(), release: releaseMock });
  appendMedicationMock.mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  appendFactMock.mockResolvedValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  listHistoryMock.mockResolvedValue({ medications: [], facts: [] });
});

describe('clinical history handler authorization and validation', () => {
  it('returns generic 401 before route, body, or database access without verified ID claims', async () => {
    const handler = await freshHandler();
    const response = await handler({
      routeKey: 'POST /api/patients/{id}/medications',
      pathParameters: { id: 'bad' },
      body: '{bad',
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('returns 400 before database access for an invalid patient id or strict body', async () => {
    const handler = await freshHandler();
    const badId = event('GET /api/patients/{id}/clinical-history');
    badId.pathParameters.id = 'bad';
    expect((await handler(badId)).statusCode).toBe(400);
    expect(
      (
        await handler(
          event('POST /api/patients/{id}/medications', {
            ...medicationBody(),
            ownerClinicianSub: 'spoofed',
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('clinical history handler routes', () => {
  it('appends a medication with the server-derived clinician sub', async () => {
    const handler = await freshHandler();
    const response = await handler(event('POST /api/patients/{id}/medications', medicationBody()));
    expect(response.statusCode).toBe(201);
    expect(appendMedicationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        patientId: PATIENT_ID,
        clinicianSub: CLINICIAN_SUB,
        input: medicationBody(),
      }),
    );
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('appends a clinician fact and returns its opaque id', async () => {
    const handler = await freshHandler();
    const fact = {
      factType: 'condition',
      factCode: 'mesh:d006261',
      statementText: 'Hypertension',
      status: 'current',
      supersedesId: null,
    };
    const response = await handler(event('POST /api/patients/{id}/clinical-facts', fact));
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(appendFactMock).toHaveBeenCalledWith(expect.anything(), {
      patientId: PATIENT_ID,
      clinicianSub: CLINICIAN_SUB,
      input: fact,
    });
  });

  it('returns all preserved versions and hides a foreign patient as 404', async () => {
    const handler = await freshHandler();
    const ok = await handler(event('GET /api/patients/{id}/clinical-history'));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ history: { medications: [], facts: [] } });

    listHistoryMock.mockResolvedValueOnce(null);
    const hidden = await handler(event('GET /api/patients/{id}/clinical-history'));
    expect(hidden.statusCode).toBe(404);
    expect(JSON.parse(hidden.body)).toEqual({ error: 'patient not found' });
  });

  it('returns a fixed 409 for a revision conflict', async () => {
    appendMedicationMock.mockRejectedValueOnce(new ClinicalRecordConflictError());
    const response = await (
      await freshHandler()
    )(event('POST /api/patients/{id}/medications', medicationBody()));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'revision conflict' });
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('returns a generic 500 without leaking database errors', async () => {
    appendMedicationMock.mockRejectedValueOnce(new Error('secret SQL detail'));
    const response = await (
      await freshHandler()
    )(event('POST /api/patients/{id}/medications', medicationBody()));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: 'internal error' });
    expect(response.body).not.toContain('secret SQL detail');
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});
