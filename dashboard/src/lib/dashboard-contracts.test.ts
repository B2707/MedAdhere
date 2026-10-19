import { afterAll, describe, expect, it } from 'vitest';
import {
  alertQueueResponseSchema,
  clinicalEventRowSchema,
  conversationMessageRowSchema,
  draftQueueResponseSchema,
  patientRecordResponseSchema,
  patientsResponseSchema,
  PATIENT_RECORD_LIMITS,
  PATIENT_RECORD_MAX_RESPONSE_BYTES,
} from './dashboard-contracts';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const FACT_ID = '55555555-5555-4555-8555-555555555555';
const HASH = 'a'.repeat(64);
const LOCAL_DATE = '2026-08-11';
const TIMESTAMP = '2026-08-11T12:00:00.000Z';
let maximumPatientRecordEnvelopeBytes = 0;

describe('patient roster contract', () => {
  const patient = {
    id: PATIENT_ID,
    display_name: 'Test Patient',
    phone: '+15005550006',
    medication_name: 'metformin',
    is_test: true,
    is_active: true,
    agent_enabled: false,
    provider_opted_in: true,
    opted_out_at: null,
    created_at: TIMESTAMP,
    consecutive_missed: 0,
    alerting: false,
    adherence_rate: null,
    last_reply_at: null,
    recent_doses: [],
  };

  it('requires both provider consent and doctor agent state', () => {
    expect(
      patientsResponseSchema.parse({ patients: [patient], alertThreshold: 3 }).patients[0],
    ).toMatchObject({ provider_opted_in: true, agent_enabled: false });
    expect(
      patientsResponseSchema.safeParse({
        patients: [{ ...patient, agent_enabled: undefined }],
        alertThreshold: 3,
      }).success,
    ).toBe(false);
  });

  it('tolerates an old backend without the reported-miss fields (dashboard-first deploy)', () => {
    // `patient` deliberately omits the two new fields — they default rather than reject.
    expect(
      patientsResponseSchema.parse({ patients: [patient], alertThreshold: 3 }).patients[0],
    ).toMatchObject({ consecutive_reported_misses: 0, reported_miss_alerting: false });
  });

  it('carries the reported-miss fields through when the new backend sends them', () => {
    expect(
      patientsResponseSchema.parse({
        patients: [{ ...patient, consecutive_reported_misses: 3, reported_miss_alerting: true }],
        alertThreshold: 3,
      }).patients[0],
    ).toMatchObject({ consecutive_reported_misses: 3, reported_miss_alerting: true });
  });
});

const message = {
  id: MESSAGE_ID,
  direction: 'outbound',
  body: 'Thanks for the update.',
  occurred_at: TIMESTAMP,
  language: 'en',
  detected_language: null,
  normalized_english_meaning: null,
  translated_text: null,
  message_kind: 'acknowledgement',
  status: 'prepared',
  reminder_attempt: null,
  clarification_topic: null,
  is_late: null,
  agent_turn_id: null,
  in_reply_to_inbound_id: null,
};

const event = {
  id: EVENT_ID,
  event_type: 'observation',
  event_code: 'headache',
  statement_text: 'headache',
  normalized_value: null,
  occurred_at: TIMESTAMP,
  local_date: LOCAL_DATE,
  local_time: '08:00',
  patient_timezone: 'America/Toronto',
  severity: 4,
  patient_medication_id: null,
  dose_id: null,
  agent_turn_id: null,
  source_inbound_id: MESSAGE_ID,
  supersedes_id: null,
  created_at: TIMESTAMP,
};

const alert = {
  id: EVENT_ID,
  event_code: 'important',
  tier: 'important',
  statement_text: 'headache',
  occurred_at: TIMESTAMP,
  local_date: LOCAL_DATE,
  source_inbound_id: MESSAGE_ID,
  agent_turn_id: null,
  final_policy_tier: 'important',
  created_at: TIMESTAMP,
};

const draft = {
  id: DRAFT_ID,
  local_date: LOCAL_DATE,
  version: 1,
  input_hash: HASH,
  draft_text: 'Structured clinician review draft',
  patient_statements: [{ sourceMessageId: MESSAGE_ID, text: 'headache' }],
  confirmed_facts: [FACT_ID],
  model_inferences: ['possible documented side effect'],
  uncertainties: ['dose time not stated'],
  evidence_references: ['medlineplus:metformin'],
  proposed_corrections: [
    {
      correctionId: EVENT_ID,
      factId: FACT_ID,
      proposedText: 'Reports recurring headaches',
      rationale: 'Patient reported a headache on two consecutive days',
      sourceMessageIds: [MESSAGE_ID],
    },
  ],
  source_agent_turn_id: null,
  supersedes_id: null,
  created_at: TIMESTAMP,
  is_latest: true,
  latest_action: null,
};

function recordResponse(overrides: Record<string, unknown> = {}) {
  return {
    patient: {
      id: PATIENT_ID,
      display_name: 'Test Patient',
      phone: '+15005550006',
      medication_name: 'metformin',
      timezone: 'America/Toronto',
      is_test: true,
      is_active: true,
      opted_out_at: null,
      created_at: TIMESTAMP,
      drug_profile_fetched_at: null,
      consecutive_missed: 0,
      alerting: false,
      preferred_language: 'en',
      reminder_limit: 2,
      agent_enabled: true,
      provider_opted_in: true,
      messaging_state_version: 3,
    },
    timeline: [],
    alertThreshold: 3,
    timelineWindowDays: 30,
    window: { days: 30, selectedDay: LOCAL_DATE },
    dayIndex: [
      {
        local_date: LOCAL_DATE,
        latest_summary_version: 1,
        highest_tier: 'important',
        message_count: 1,
        event_count: 1,
        alert_count: 1,
        has_draft: true,
      },
    ],
    daySummary: {
      id: DRAFT_ID,
      local_date: LOCAL_DATE,
      version: 1,
      input_hash: HASH,
      event_count: 1,
      highest_tier: 'important',
      summary_text: 'One important event.',
      window_start: '2026-08-11T04:00:00.000Z',
      window_end: '2026-08-12T04:00:00.000Z',
      structured_payload: {
        localDate: LOCAL_DATE,
        patientTimeZone: 'America/Toronto',
        eventCount: 1,
        detailedEventCount: 1,
        truncated: false,
        eventIds: [EVENT_ID],
        events: [
          {
            eventId: EVENT_ID,
            eventType: 'observation',
            eventCode: 'headache',
            occurredAtUtc: TIMESTAMP,
            severity: 4,
            priority: 'important',
          },
        ],
        symptomCount: 1,
        adherenceCounts: {
          taken: 0,
          delayed: 0,
          skipped: 0,
          stopped: 0,
          unknown: 0,
          question: 0,
        },
        highestPriority: 'important',
      },
      supersedes_id: null,
      created_at: TIMESTAMP,
    },
    messages: [message],
    events: [event],
    evidence: [],
    versions: [
      {
        record_kind: 'clinical_event',
        id: EVENT_ID,
        version: null,
        supersedes_id: null,
        created_at: TIMESTAMP,
      },
    ],
    alertsPage: { items: [alert], cursor: null, nextCursor: null, limit: 25 },
    draftsPage: { items: [draft], cursor: null, nextCursor: null, limit: 3 },
    history: { medications: [], facts: [] },
    trends: { severity: [], adherence: [] },
    ...overrides,
  };
}

describe('patientRecordResponseSchema', () => {
  it('accepts the bounded selected-day record without changing the legacy detail contract', () => {
    const parsed = patientRecordResponseSchema.parse(recordResponse());

    expect(parsed.window).toEqual({ days: 30, selectedDay: LOCAL_DATE });
    expect(parsed.daySummary?.highest_tier).toBe('important');
    expect(parsed.draftsPage.items[0]?.proposed_corrections[0]?.factId).toBe(FACT_ID);
  });

  it('accepts the strict record patient with and without the reported-miss fields', () => {
    // Old backend: fields absent → defaults (the strict schema must not reject the old shape).
    expect(patientRecordResponseSchema.parse(recordResponse()).patient).toMatchObject({
      consecutive_reported_misses: 0,
      reported_miss_alerting: false,
    });
    // New backend: fields present → carried through the .strict() patient.
    const response = recordResponse();
    expect(
      patientRecordResponseSchema.parse({
        ...response,
        patient: {
          ...response.patient,
          consecutive_reported_misses: 4,
          reported_miss_alerting: true,
        },
      }).patient,
    ).toMatchObject({ consecutive_reported_misses: 4, reported_miss_alerting: true });
  });

  it.each([
    'prepared',
    'queued',
    'sending',
    'sending_unknown',
    'sent',
    'delivered',
    'undelivered',
    'failed',
  ])('accepts the final stored outbound status %s', (status) => {
    expect(
      patientRecordResponseSchema.parse(recordResponse({ messages: [{ ...message, status }] }))
        .messages[0]?.status,
    ).toBe(status);
  });

  it('tolerates an old backend without message sent_at and carries it when present (dashboard-first deploy)', () => {
    // Old backend: field absent — the strict row schema must still parse (optional, stays undefined).
    expect(
      patientRecordResponseSchema.parse(recordResponse()).messages[0]?.sent_at,
    ).toBeUndefined();
    // New backend: explicit NULL marks a never-sent row; a timestamp marks a provider-accepted send.
    expect(
      patientRecordResponseSchema.parse(
        recordResponse({ messages: [{ ...message, sent_at: null }] }),
      ).messages[0]?.sent_at,
    ).toBeNull();
    expect(
      patientRecordResponseSchema.parse(
        recordResponse({ messages: [{ ...message, sent_at: TIMESTAMP }] }),
      ).messages[0]?.sent_at,
    ).toBe(TIMESTAMP);
  });

  it('rejects invalid windows, smuggled fields, and an overlong opaque cursor', () => {
    expect(() =>
      patientRecordResponseSchema.parse(
        recordResponse({ window: { days: 14, selectedDay: LOCAL_DATE } }),
      ),
    ).toThrow();
    expect(() => patientRecordResponseSchema.parse(recordResponse({ owner: 'leaked' }))).toThrow();
    const response = recordResponse();
    expect(() =>
      patientRecordResponseSchema.parse({
        ...response,
        patient: {
          ...response.patient,
          drug_profile_json: { arbitrary_unbounded_payload: 'must not cross the record contract' },
        },
      }),
    ).toThrow();
    expect(() =>
      patientRecordResponseSchema.parse(
        recordResponse({
          alertsPage: { items: [], cursor: 'a'.repeat(513), nextCursor: null, limit: 25 },
        }),
      ),
    ).toThrow();
  });

  it.each([
    ['dayIndex', 90],
    ['messages', 200],
    ['events', 200],
    ['versions', 200],
  ])('rejects a %s collection beyond its server bound', (field, limit) => {
    const response = recordResponse() as Record<string, unknown>;
    const item = (response[field] as unknown[])[0];
    expect(() =>
      patientRecordResponseSchema.parse({
        ...response,
        [field]: Array.from({ length: limit + 1 }, () => item),
      }),
    ).toThrow();
  });

  it('rejects oversized evidence, page, history, and trend collections', () => {
    const evidence = {
      clinical_event_id: EVENT_ID,
      evidence_id: DRAFT_ID,
      template_id: 'interaction',
      source: 'ddinter',
      source_version: '2024-01',
      evidence_code: 'DDI-1',
      passage: 'Interaction evidence.',
      url: 'https://example.invalid/evidence',
      language: 'en',
      coverage_state: 'direct_evidence',
    };
    expect(() =>
      patientRecordResponseSchema.parse(
        recordResponse({
          evidence: Array.from({ length: PATIENT_RECORD_LIMITS.evidence + 1 }, () => evidence),
        }),
      ),
    ).toThrow();
    expect(() =>
      patientRecordResponseSchema.parse(
        recordResponse({
          alertsPage: {
            items: Array.from({ length: PATIENT_RECORD_LIMITS.reviewQueue + 1 }, () => alert),
            cursor: null,
            nextCursor: null,
            limit: 100,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      patientRecordResponseSchema.parse(
        recordResponse({
          history: {
            medications: [],
            facts: Array.from({ length: PATIENT_RECORD_LIMITS.historyFacts + 1 }, () => ({
              id: FACT_ID,
              factType: 'note',
              factCode: null,
              statementText: 'History',
              status: 'current',
              supersedesId: null,
            })),
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      patientRecordResponseSchema.parse(
        recordResponse({
          trends: {
            severity: Array.from({ length: PATIENT_RECORD_LIMITS.trendPoints + 1 }, () => ({
              local_date: LOCAL_DATE,
              symptom: 'headache',
              max_severity: 4,
              observation_count: 1,
            })),
            adherence: [],
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects an envelope above the fixed 5 MiB response contract', () => {
    const labelMatch = {
      id: EVENT_ID,
      matched_phrase: 'm'.repeat(320),
      meddra_pt: 'p'.repeat(320),
      hint_level: 'info',
    };
    const timelineRow = {
      dose_id: DRAFT_ID,
      scheduled_at: TIMESTAMP,
      dose_date: LOCAL_DATE,
      local_dose_time: '09:00',
      status: null,
      adherence_state: null,
      reason_code: null,
      decided_by: null,
      is_late: null,
      label_matches: Array.from({ length: 20 }, () => labelMatch),
    };
    const oversized = recordResponse({
      timeline: Array.from({ length: 500 }, () => timelineRow),
    });

    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      5 * 1024 * 1024,
    );
    expect(patientRecordResponseSchema.safeParse(oversized).success).toBe(false);
  });

  it('keeps the all-maxima API envelope within the fixed 5 MiB response contract', () => {
    // Three-byte BMP text exercises the worst UTF-8 width accepted by the bounded string fields.
    const text = (length: number) => '漢'.repeat(length);
    const cursor = 'a'.repeat(512);
    const int4 = 2_147_483_647;
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const maxTimestamp = `2026-08-11T12:00:00.${'1'.repeat(15)}Z`;
    const maxLabelMatch = {
      id: EVENT_ID,
      matched_phrase: text(PATIENT_RECORD_LIMITS.timelineLabelText),
      meddra_pt: text(PATIENT_RECORD_LIMITS.timelineLabelText),
      hint_level: 'elevated',
    };
    const maxTimeline = {
      dose_id: DRAFT_ID,
      scheduled_at: maxTimestamp,
      dose_date: LOCAL_DATE,
      local_dose_time: '23:59:59.999999',
      status: 'recorded',
      adherence_state: 'question',
      reason_code: 'side_effect',
      decided_by: 'classifier',
      is_late: true,
      label_matches: Array.from(
        { length: PATIENT_RECORD_LIMITS.timelineLabelMatches },
        () => maxLabelMatch,
      ),
    };
    const maxMessage = {
      ...message,
      body: text(2000),
      occurred_at: maxTimestamp,
      sent_at: maxTimestamp,
      language: text(35),
      detected_language: text(35),
      normalized_english_meaning: text(2000),
      translated_text: text(2000),
      message_kind: 'acknowledgement',
      status: 'sending_unknown',
      reminder_attempt: 5,
      clarification_topic: 'interaction_item_identity',
      is_late: true,
      agent_turn_id: EVENT_ID,
      in_reply_to_inbound_id: MESSAGE_ID,
    };
    const maxEvent = {
      ...event,
      event_type: 'patient_statement',
      event_code: text(128),
      statement_text: text(2000),
      normalized_value: text(200),
      occurred_at: maxTimestamp,
      local_time: '23:59:59.999999',
      patient_timezone: text(64),
      severity: 10,
      patient_medication_id: DRAFT_ID,
      dose_id: DRAFT_ID,
      agent_turn_id: EVENT_ID,
      supersedes_id: EVENT_ID,
      created_at: maxTimestamp,
    };
    const maxEvidence = {
      clinical_event_id: EVENT_ID,
      evidence_id: DRAFT_ID,
      template_id: text(128),
      source: 'medlineplus',
      source_version: text(128),
      evidence_code: text(128),
      passage: text(4000),
      url: text(2048),
      language: text(35),
      coverage_state: 'coverage_unknown',
    };
    const maxVersion = {
      record_kind: 'clinician_review_draft',
      id: DRAFT_ID,
      version: int4,
      supersedes_id: DRAFT_ID,
      created_at: maxTimestamp,
    };
    const maxAlert = {
      ...alert,
      event_code: text(128),
      tier: 'emergency',
      statement_text: text(2000),
      occurred_at: maxTimestamp,
      agent_turn_id: EVENT_ID,
      final_policy_tier: 'emergency',
      created_at: maxTimestamp,
    };
    const maxCorrection = {
      correctionId: EVENT_ID,
      factId: FACT_ID,
      proposedText: text(1000),
      rationale: text(1000),
      sourceMessageIds: Array.from({ length: 20 }, () => MESSAGE_ID),
    };
    const maxDraft = {
      ...draft,
      version: int4,
      draft_text: text(8000),
      patient_statements: Array.from({ length: 20 }, () => ({
        sourceMessageId: MESSAGE_ID,
        text: text(1000),
      })),
      confirmed_facts: Array.from({ length: 20 }, () => FACT_ID),
      model_inferences: Array.from({ length: 20 }, () => text(1000)),
      uncertainties: Array.from({ length: 20 }, () => text(1000)),
      evidence_references: Array.from({ length: 20 }, () => text(128)),
      proposed_corrections: Array.from({ length: 10 }, () => maxCorrection),
      source_agent_turn_id: EVENT_ID,
      supersedes_id: DRAFT_ID,
      created_at: maxTimestamp,
      latest_action: {
        id: EVENT_ID,
        decision: 'confirm',
        expected_version: int4,
        selected_correction_ids: Array.from({ length: 30 }, () => EVENT_ID),
        created_at: maxTimestamp,
      },
    };
    const maxMedication = {
      id: DRAFT_ID,
      enteredName: text(320),
      identity: { system: 'rxnorm', code: text(64) },
      doseText: text(160),
      form: text(80),
      route: text(80),
      validFrom: LOCAL_DATE,
      validTo: LOCAL_DATE,
      status: 'corrected',
      supersedesId: DRAFT_ID,
      ingredients: Array.from({ length: 32 }, () => ({
        name: text(PATIENT_RECORD_LIMITS.historyIngredientName),
        ccddIngredientCode: text(64),
        rxcui: text(32),
      })).slice(0, PATIENT_RECORD_LIMITS.historyIngredients),
    };
    const maximum = recordResponse({
      patient: {
        id: PATIENT_ID,
        display_name: text(320),
        phone: text(32),
        medication_name: text(320),
        timezone: text(64),
        is_test: true,
        is_active: true,
        opted_out_at: maxTimestamp,
        created_at: maxTimestamp,
        drug_profile_fetched_at: maxTimestamp,
        consecutive_missed: maxSafe,
        alerting: true,
        preferred_language: text(35),
        reminder_limit: 5,
        agent_enabled: true,
        provider_opted_in: true,
        messaging_state_version: int4,
      },
      timeline: Array.from({ length: PATIENT_RECORD_LIMITS.timeline }, () => maxTimeline),
      alertThreshold: maxSafe,
      timelineWindowDays: maxSafe,
      dayIndex: Array.from({ length: PATIENT_RECORD_LIMITS.dayIndex }, () => ({
        local_date: LOCAL_DATE,
        latest_summary_version: int4,
        highest_tier: 'emergency',
        message_count: maxSafe,
        event_count: maxSafe,
        alert_count: maxSafe,
        has_draft: true,
      })),
      daySummary: {
        id: DRAFT_ID,
        local_date: LOCAL_DATE,
        version: int4,
        input_hash: HASH,
        event_count: maxSafe,
        highest_tier: 'emergency',
        summary_text: text(4000),
        window_start: maxTimestamp,
        window_end: maxTimestamp,
        structured_payload: {
          localDate: LOCAL_DATE,
          patientTimeZone: text(64),
          eventCount: maxSafe,
          detailedEventCount: 100,
          truncated: true,
          eventIds: Array.from({ length: 100 }, () => EVENT_ID),
          events: Array.from({ length: 100 }, () => ({
            eventId: EVENT_ID,
            eventType: 'patient_statement',
            eventCode: text(128),
            occurredAtUtc: maxTimestamp,
            severity: 10,
            priority: 'emergency',
          })),
          symptomCount: maxSafe,
          adherenceCounts: {
            taken: maxSafe,
            delayed: maxSafe,
            skipped: maxSafe,
            stopped: maxSafe,
            unknown: maxSafe,
            question: maxSafe,
          },
          highestPriority: 'emergency',
        },
        supersedes_id: DRAFT_ID,
        created_at: maxTimestamp,
      },
      messages: Array.from({ length: PATIENT_RECORD_LIMITS.messages }, () => maxMessage),
      events: Array.from({ length: PATIENT_RECORD_LIMITS.events }, () => maxEvent),
      evidence: Array.from({ length: PATIENT_RECORD_LIMITS.evidence }, () => maxEvidence),
      versions: Array.from({ length: PATIENT_RECORD_LIMITS.versions }, () => maxVersion),
      alertsPage: {
        items: Array.from({ length: PATIENT_RECORD_LIMITS.alerts }, () => maxAlert),
        cursor,
        nextCursor: cursor,
        limit: PATIENT_RECORD_LIMITS.alertRequest,
      },
      draftsPage: {
        items: Array.from({ length: PATIENT_RECORD_LIMITS.drafts }, () => maxDraft),
        cursor,
        nextCursor: cursor,
        limit: PATIENT_RECORD_LIMITS.draftRequest,
      },
      history: {
        medications: Array.from(
          { length: PATIENT_RECORD_LIMITS.historyMedications },
          () => maxMedication,
        ),
        facts: Array.from({ length: PATIENT_RECORD_LIMITS.historyFacts }, () => ({
          id: FACT_ID,
          factType: 'condition',
          factCode: text(128),
          statementText: text(PATIENT_RECORD_LIMITS.historyFactText),
          status: 'retracted',
          supersedesId: FACT_ID,
        })),
      },
      trends: {
        severity: Array.from({ length: PATIENT_RECORD_LIMITS.trendPoints }, () => ({
          local_date: LOCAL_DATE,
          symptom: text(200),
          max_severity: 10,
          observation_count: maxSafe,
        })),
        adherence: Array.from({ length: PATIENT_RECORD_LIMITS.trendPoints }, () => ({
          local_date: LOCAL_DATE,
          taken: maxSafe,
          delayed: maxSafe,
          skipped: maxSafe,
          stopped: maxSafe,
          unknown: maxSafe,
          question: maxSafe,
        })),
      },
    });
    const bytes = new TextEncoder().encode(JSON.stringify(maximum)).byteLength;
    maximumPatientRecordEnvelopeBytes = bytes;

    expect(bytes).toBeLessThanOrEqual(PATIENT_RECORD_MAX_RESPONSE_BYTES);
    expect(patientRecordResponseSchema.parse(maximum)).toBeDefined();
  });
});

afterAll(() => {
  if (maximumPatientRecordEnvelopeBytes > 0) {
    process.stdout.write(
      `maximum patient-record envelope: ${maximumPatientRecordEnvelopeBytes} bytes\n`,
    );
  }
});

// The backend writes the RAW NeedField into outbound_message.clarification_topic. A value the
// backend's DB CHECK accepts but this reader rejects fails the WHOLE strict day envelope, so the
// clinician's record page falls to its error state and loses messages, summary, alerts, and
// timeline for that day — the live-confirmed crash class from 2026-08-14, and late_intent fires
// it on the headline new question type (a patient answering "no" to a check-in).
describe('clarification_topic accepts every NeedField the backend can write', () => {
  const NEED_FIELDS = [
    'medication_identity',
    'dose_identity',
    'event_identity',
    'symptom_identity',
    'severity',
    'actual_time',
    'duration',
    'body_site',
    'frequency',
    'late_intent',
    'onset',
    'quality',
    'triggers',
    'associated_symptoms',
    'recurrence_history',
  ] as const;

  it.each(NEED_FIELDS)('parses a day record whose clarification topic is %s', (topic) => {
    expect(() =>
      conversationMessageRowSchema.parse({ ...message, clarification_topic: topic }),
    ).not.toThrow();
  });
});

// Wave-3 (2026-08-17): the parse-time preprocessors that used to paper over these two stored
// values are gone (dashboard-contracts.ts), and nothing replaced them here — this reader stays
// strict over the canonical vocabulary. 'symptom_identity' turned out NOT to be a legacy spelling
// at all (it is the live, ongoing NeedField the resolver still asks — see the
// 'clarification_topic accepts every NeedField' block above, which already covers it), so it is
// now a first-class enum literal rather than something to reject. 'symptom' as an event_type
// really was retired from the API's vocabulary — it is asserted rejected below. Stored legacy
// rows still spell it that way permanently (clinical_event is append-only), so the data API
// projects them on read (backend/src/data-api/patient-record.ts READ_EVENT_TYPE_SQL) and this
// reader never has to see one.
describe('Wave-3 vocabulary: the retired spellings stay rejected, with no parse-time rewrite', () => {
  it('parses clarification_topic symptom_identity as itself, with no substitution', () => {
    expect(
      conversationMessageRowSchema.parse({ ...message, clarification_topic: 'symptom_identity' })
        .clarification_topic,
    ).toBe('symptom_identity');
  });

  it('rejects the retired clinical_event event_type spelling instead of silently rewriting it', () => {
    expect(() => clinicalEventRowSchema.parse({ ...event, event_type: 'symptom' })).toThrow();
  });

  it('still rejects any other unknown value in both columns', () => {
    expect(() =>
      conversationMessageRowSchema.parse({ ...message, clarification_topic: 'symptom_severity' }),
    ).toThrow();
    expect(() =>
      clinicalEventRowSchema.parse({ ...event, event_type: 'symptom_identity' }),
    ).toThrow();
  });

  it('keeps a whole day envelope parseable under the vocabulary the data API emits', () => {
    const parsed = patientRecordResponseSchema.parse(
      recordResponse({
        messages: [{ ...message, clarification_topic: 'symptom_identity' }],
        events: [{ ...event, event_type: 'patient_statement' }],
      }),
    );

    expect(parsed.messages[0]?.clarification_topic).toBe('symptom_identity');
    expect(parsed.events[0]?.event_type).toBe('patient_statement');
  });
});

describe('owner-scoped queue response contracts', () => {
  it('accepts independently paged alert and draft queues', () => {
    const alertItem = {
      id: EVENT_ID,
      patient_id: PATIENT_ID,
      display_name: 'Test Patient',
      event_code: 'emergency',
      tier: 'emergency',
      statement_text: 'chest pain',
      occurred_at: TIMESTAMP,
      local_date: LOCAL_DATE,
      source_inbound_id: MESSAGE_ID,
      raw_body: 'chest pain',
      created_at: TIMESTAMP,
    };
    const draftItem = {
      id: DRAFT_ID,
      patient_id: PATIENT_ID,
      display_name: null,
      local_date: LOCAL_DATE,
      version: 1,
      draft_text: 'Structured clinician review draft',
      proposed_correction_count: 1,
      has_action: false,
      created_at: TIMESTAMP,
    };

    expect(
      alertQueueResponseSchema.parse({
        alertsPage: { items: [alertItem], cursor: null, nextCursor: 'bmV4dA', limit: 25 },
      }).alertsPage.items[0]?.tier,
    ).toBe('emergency');
    expect(
      draftQueueResponseSchema.parse({
        draftsPage: { items: [draftItem], cursor: 'cHJldg', nextCursor: null, limit: 25 },
      }).draftsPage.items[0]?.has_action,
    ).toBe(false);
  });

  it('rejects unknown queue fields and invalid limits', () => {
    expect(() =>
      alertQueueResponseSchema.parse({
        alertsPage: { items: [], cursor: null, nextCursor: null, limit: 0 },
      }),
    ).toThrow();
    expect(() =>
      draftQueueResponseSchema.parse({
        draftsPage: { items: [], cursor: null, nextCursor: null, limit: 25 },
        owner: 'leaked',
      }),
    ).toThrow();
  });
});
