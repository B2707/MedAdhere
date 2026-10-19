// scripts/demo-seed.ts
//
// The demo-cohort seed — a PRIVILEGED OFFLINE operator script that fills a freshly deployed
// database with a small SYNTHETIC patient cohort so the clinician dashboard has content to show.
// It is NEVER a clinician/browser path, NOT a Lambda, and NOT part of any deployed stack; it is an
// offline operator script (tsx-runnable, like scripts/enroll-seed.ts / scripts/wipe-test-patients.ts).
//
// ALL DATA IS SYNTHETIC. No real person, phone number, medication order, or clinical record. Every
// patient row is written with `is_test = true` (the only table carrying that column — STUDY-04), so
// the standard pre-cohort wipe removes them too.
//
// ONE-SHOT IDEMPOTENT: every id is derived deterministically from a slug (see `demoUuid`), and the
// seed transaction DELETEs exactly those ids before re-inserting them. Running it twice leaves the
// database in the same state as running it once. `--wipe` runs only the DELETE half, in one
// transaction, so the demo cohort is removable without touching any other row.
//
// CONNECTING (primary — deployed RDS through a localhost SSM port-forward tunnel):
//   The script fetches the RDS-managed credential itself with @aws-sdk/client-secrets-manager,
//   exactly as backend/src/shared/db-pool.ts does, so the operator never runs `aws secretsmanager
//   get-secret-value` by hand. username/password/dbname come from the secret; host/port default to
//   the tunnel (127.0.0.1:5432). TLS pins the tracked RDS global CA bundle with
//   rejectUnauthorized:true and an SNI servername taken from the secret's `host` (the real RDS
//   endpoint) — otherwise verification against `127.0.0.1` would fail. The credential is never
//   printed.
//
//     aws ssm start-session --target <bastion> --document-name AWS-StartPortForwardingSessionToRemoteHost \
//       --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["5432"]}'
//     npx tsx scripts/demo-seed.ts --db-secret-arn "$DB_SECRET_ARN" --owner-sub "$CLINICIAN_SUB"
//     npx tsx scripts/demo-seed.ts --db-secret-arn "$DB_SECRET_ARN" --wipe
//
// CONNECTING (secondary — a plain connection string, used by the local testcontainers test):
//     npx tsx scripts/demo-seed.ts --database-url postgres://user:pw@127.0.0.1:5432/medadhere \
//       --owner-sub "$CLINICIAN_SUB"
//
// `--owner-sub` is the verified Cognito clinician subject that will OWN the demo patients. Every
// dashboard read is owner-scoped (`patient.owner_clinician_sub = <jwt sub>`), so a wrong value seeds
// rows that are invisible in the UI. Discover it with scripts/ops-runbook-06.md §3.
//
// CLINICAL-MEMORY SCOPE (deliberate): the append-only hash-lineage columns and tables
// (agent_turn.prepared_command_batch / prepared_command_hash / prepared_batch_hash,
// patient.clinical_memory_version, information_need*, clinical_review_item*, clinical_event_source)
// are NOT written. No dashboard or data-API read touches them, and forging that lineage by hand
// outside the core's own apply path would be wrong. `agent_turn` rows themselves ARE written with
// every prepared_* column NULL — legal under `agent_turn_prepared_batch_check` — so the conversation
// panel shows real language metadata and policy tiers.
//
// Module mode: CommonJS-compatible (no `import.meta`); tsx/NodeNext resolve the deps natively.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import { DateTime } from 'luxon';

// --- deterministic identity -----------------------------------------------------------------------

/** Bump this when the cohort shape changes so a re-seed replaces the previous generation's rows. */
const DEMO_NAMESPACE = 'medadhere-demo-seed/v1';

/**
 * A stable v4-SHAPED uuid derived from a readable slug. Deterministic ids are what make the seed
 * one-shot idempotent and make `--wipe` able to delete EXACTLY the demo rows. The version/variant
 * nibbles are forced so the value satisfies `patient_owner_clinician_sub_uuid_shape` and every
 * `z.string().uuid()` contract gate.
 */
export function demoUuid(key: string): string {
  const digest = createHash('sha256').update(`${DEMO_NAMESPACE}:${key}`).digest('hex');
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/** A stable [0,1) roll used to vary synthetic outcomes without a random source. */
function roll(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
}

/** A stable sha256 hex string for the columns whose CHECKs require one. */
function contentHash(key: string): string {
  return createHash('sha256').update(`${DEMO_NAMESPACE}:${key}`).digest('hex');
}

/** jsonb parameters must be pre-serialised — node-postgres would emit PG array syntax otherwise. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

// --- cohort definition ----------------------------------------------------------------------------

/** How many trailing days of dose history the demo covers (inside the 30-day roster/trend window). */
export const DEMO_HISTORY_DAYS = 28;
/** How many upcoming doses each active patient keeps scheduled. */
export const DEMO_UPCOMING_DAYS = 7;
/** The deterministic id of the frozen evidence release the demo evidence passages hang off. */
const DEMO_SOURCE_RELEASE_ID = demoUuid('source-release/medlineplus');
/**
 * Hours before "now" that the newest demo dose fired. It MUST exceed the classifier's response
 * window (RESPONSE_WINDOW_MINUTES = 120) — every dashboard read treats a dose whose window is still
 * open as undecided, which would silently zero the consecutive-miss streak the demo relies on.
 */
const DEMO_ANCHOR_HOURS_AGO = 4;

/**
 * The instant the newest demo dose fired, in the patient's own timezone. Every other timestamp is
 * derived from it, so the whole cohort slides forward with the clock. Exported so the test can
 * address the same local days the seed wrote.
 */
export function demoAnchor(now: DateTime, timezone: string): DateTime {
  return now.setZone(timezone).minus({ hours: DEMO_ANCHOR_HOURS_AGO });
}

type AdherenceState = 'taken' | 'delayed' | 'skipped' | 'stopped' | 'unknown';

interface DemoIngredient {
  readonly name: string;
  readonly ccddIngredientCode: string | null;
  readonly rxcui: string | null;
}

interface DemoPatientSpec {
  readonly slug: string;
  readonly displayName: string | null;
  readonly phone: string;
  readonly medicationName: string;
  readonly enteredName: string;
  readonly doseText: string;
  readonly form: string;
  readonly route: string;
  readonly ingredients: readonly DemoIngredient[];
  readonly timezone: string;
  readonly language: string;
  /** Share of doses reported taken/delayed — drives the deterministic outcome roll. */
  readonly adherence: number;
  /** The most recent N doses are forced to time out, so the consecutive-miss banner is provable. */
  readonly forcedRecentMisses: number;
  /** Patient texted STOP: no doses newer than this many days, is_active/agent_enabled false. */
  readonly stoppedDaysAgo?: number;
  readonly reminderLimit: number;
  readonly condition: string;
  readonly allergy: string;
}

/**
 * Five synthetic patients spanning the states the dashboard is built to surface: a struggling
 * alerting patient with a rich clinical record, a near-perfect adherer, a mid-range patient whose
 * review draft has already been decided, an opted-out patient, and a low-adherence patient with an
 * unresolved crisis flag who replies in Spanish.
 */
export const DEMO_COHORT: readonly DemoPatientSpec[] = [
  {
    slug: 'alice',
    displayName: 'Alice Reyes',
    phone: '+15005550101',
    medicationName: 'metformin 500 mg',
    enteredName: 'Metformin',
    doseText: '500 mg',
    form: 'tablet',
    route: 'oral',
    ingredients: [{ name: 'metformin hydrochloride', ccddIngredientCode: 'TM-MET', rxcui: '6809' }],
    timezone: 'America/Toronto',
    language: 'en',
    adherence: 0.62,
    forcedRecentMisses: 4,
    reminderLimit: 2,
    condition: 'Type 2 diabetes mellitus, diagnosed 2021',
    allergy: 'Penicillin — urticaria',
  },
  {
    slug: 'marcus',
    displayName: 'Marcus Webb',
    phone: '+15005550102',
    medicationName: 'lisinopril 10 mg',
    enteredName: 'Lisinopril',
    doseText: '10 mg',
    form: 'tablet',
    route: 'oral',
    ingredients: [{ name: 'lisinopril', ccddIngredientCode: 'TM-LIS', rxcui: '29046' }],
    timezone: 'America/Toronto',
    language: 'en',
    adherence: 0.96,
    forcedRecentMisses: 0,
    reminderLimit: 2,
    condition: 'Essential hypertension',
    allergy: 'No known drug allergies',
  },
  {
    slug: 'priya',
    displayName: 'Priya Nandakumar',
    phone: '+15005550103',
    medicationName: 'sertraline 50 mg',
    enteredName: 'Sertraline',
    doseText: '50 mg',
    form: 'tablet',
    route: 'oral',
    ingredients: [
      { name: 'sertraline hydrochloride', ccddIngredientCode: 'TM-SER', rxcui: '36437' },
    ],
    timezone: 'America/Vancouver',
    language: 'en',
    adherence: 0.81,
    forcedRecentMisses: 0,
    reminderLimit: 3,
    condition: 'Major depressive disorder, recurrent',
    allergy: 'Sulfonamides — rash',
  },
  {
    slug: 'tom',
    displayName: 'Tom Okafor',
    phone: '+15005550104',
    medicationName: 'warfarin 5 mg',
    enteredName: 'Warfarin',
    doseText: '5 mg',
    form: 'tablet',
    route: 'oral',
    ingredients: [{ name: 'warfarin sodium', ccddIngredientCode: 'TM-WAR', rxcui: '11289' }],
    timezone: 'America/Toronto',
    language: 'en',
    adherence: 0.74,
    forcedRecentMisses: 0,
    stoppedDaysAgo: 9,
    reminderLimit: 2,
    condition: 'Atrial fibrillation, anticoagulated',
    allergy: 'No known drug allergies',
  },
  {
    slug: 'noname',
    displayName: null,
    phone: '+15005550105',
    medicationName: 'atorvastatin 20 mg',
    enteredName: 'Atorvastatin',
    doseText: '20 mg',
    form: 'tablet',
    route: 'oral',
    ingredients: [{ name: 'atorvastatin calcium', ccddIngredientCode: 'TM-ATO', rxcui: '83367' }],
    timezone: 'America/Toronto',
    language: 'es',
    adherence: 0.44,
    forcedRecentMisses: 5,
    reminderLimit: 4,
    condition: 'Hyperlipidaemia',
    allergy: 'No known drug allergies',
  },
];

/** Every demo patient id, in cohort order. `--wipe` deletes exactly these (plus the frozen release). */
export function demoPatientIds(): readonly string[] {
  return DEMO_COHORT.map((spec) => demoUuid(`patient/${spec.slug}`));
}

// --- synthetic message text -----------------------------------------------------------------------

const REPLY_TEXT: Record<AdherenceState, readonly string[]> = {
  taken: ['Took it, thanks', 'yes took it with breakfast', 'done ✅', 'Yep, all good today'],
  delayed: [
    'took it late, around lunch',
    'forgot until the afternoon but I took it',
    'a couple hours late sorry',
  ],
  skipped: [
    'skipped today, my stomach was off',
    'no, I ran out yesterday',
    'not today — felt queasy',
  ],
  stopped: ['I stopped taking it, my doctor said to hold off'],
  unknown: ['maybe? the days blur together', 'not sure honestly'],
};

const SPANISH_REPLY_TEXT: Record<AdherenceState, readonly string[]> = {
  taken: ['sí, ya la tomé', 'tomada con el desayuno'],
  delayed: ['la tomé tarde, como a la una'],
  skipped: ['hoy no la tomé, me dolía el estómago'],
  stopped: ['dejé de tomarla'],
  unknown: ['no me acuerdo bien'],
};

const ENGLISH_MEANING: Record<AdherenceState, string> = {
  taken: 'Patient reports taking the scheduled dose.',
  delayed: 'Patient reports taking the dose several hours after the scheduled time.',
  skipped: 'Patient reports not taking the scheduled dose.',
  stopped: 'Patient reports stopping the medication.',
  unknown: 'Patient reply does not resolve whether the dose was taken.',
};

function pick<T>(pool: readonly T[], key: string): T {
  return pool[Math.floor(roll(key) * pool.length) % pool.length]!;
}

// --- plan model -----------------------------------------------------------------------------------

export interface TableBatch {
  readonly table: string;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface DemoPlan {
  readonly patientIds: readonly string[];
  readonly sourceReleaseId: string;
  readonly batches: readonly TableBatch[];
}

interface PlannedInbound {
  readonly id: string;
  readonly patientId: string;
  readonly doseId: string | null;
  readonly body: string;
  readonly receivedAt: DateTime;
  readonly safetyFlagged: boolean;
  readonly isLate: boolean;
  readonly state: AdherenceState;
  readonly language: string;
  readonly policyTier: 'routine' | 'important' | 'emergency';
}

/** Human-readable outcome for one scheduled dose. `missed` means the response window timed out. */
function doseOutcome(spec: DemoPatientSpec, daysAgo: number): AdherenceState | 'missed' {
  if (daysAgo < spec.forcedRecentMisses) return 'missed';
  if (spec.stoppedDaysAgo !== undefined && daysAgo === spec.stoppedDaysAgo) return 'stopped';
  if (daysAgo === 5) return 'unknown';
  const value = roll(`${spec.slug}:dose:${daysAgo}`);
  if (value > spec.adherence + 0.22) return 'missed';
  if (value < spec.adherence * 0.75) return 'taken';
  if (value < spec.adherence) return 'delayed';
  return 'skipped';
}

function reasonFor(state: AdherenceState, key: string): string {
  if (state === 'delayed') return roll(`${key}:reason`) < 0.6 ? 'forgot' : 'none';
  if (state === 'skipped') return roll(`${key}:reason`) < 0.5 ? 'side_effect' : 'ran_out';
  if (state === 'stopped') return 'other';
  return 'none';
}

/**
 * Build the whole demo dataset as an ordered list of insert batches. Pure: the clock is injected, so
 * a test can assert on exact row counts and shapes without a database. Batch order is FK-safe.
 */
export function buildDemoPlan(options: {
  readonly now: DateTime;
  readonly ownerSub: string;
}): DemoPlan {
  const { now, ownerSub } = options;

  const patients: Record<string, unknown>[] = [];
  const medications: Record<string, unknown>[] = [];
  const medicationIngredients: Record<string, unknown>[] = [];
  const doses: Record<string, unknown>[] = [];
  const checkIns: Record<string, unknown>[] = [];
  const inbounds: Record<string, unknown>[] = [];
  const turnJobs: Record<string, unknown>[] = [];
  const agentTurns: Record<string, unknown>[] = [];
  const agentReplies: Record<string, unknown>[] = [];
  const adherenceRecords: Record<string, unknown>[] = [];
  const safetyEvents: Record<string, unknown>[] = [];
  const labelMatches: Record<string, unknown>[] = [];
  const clinicalEvents: Record<string, unknown>[] = [];
  const eventEvidence: Record<string, unknown>[] = [];
  const dailySummaries: Record<string, unknown>[] = [];
  const reviewDrafts: Record<string, unknown>[] = [];
  const reviewActions: Record<string, unknown>[] = [];
  const clinicalFacts: Record<string, unknown>[] = [];

  for (const spec of DEMO_COHORT) {
    const patientId = demoUuid(`patient/${spec.slug}`);
    const medicationId = demoUuid(`medication/${spec.slug}`);
    const anchor = demoAnchor(now, spec.timezone);
    const oldestDay = DEMO_HISTORY_DAYS - 1;
    const stopped = spec.stoppedDaysAgo !== undefined;

    // Timestamps for the spontaneous (dose-free) texts, hoisted so the inbound row, its safety
    // event, and its alert event all agree. The two safety texts land on the CURRENT local day so
    // the record page — which opens on today — is never blank for the patients that matter most.
    const spontaneousAt = {
      safety: anchor.plus({ minutes: 30 }),
      crisis: anchor.plus({ minutes: 45 }),
      label: anchor.minus({ days: 4 }).plus({ minutes: 30 }),
      unattributed: anchor.minus({ days: 3 }).plus({ minutes: 20 }),
    } as const;

    const patientInbounds: PlannedInbound[] = [];
    const dayEvents = new Map<string, Record<string, unknown>[]>();
    const addEvent = (localDate: string, event: Record<string, unknown>): void => {
      // insertBatch derives the column list from the first row, so every clinical_event row must
      // carry the same keys — default the jsonb column here rather than at each call site.
      const row = { clinical_values: null, ...event };
      clinicalEvents.push(row);
      const bucket = dayEvents.get(localDate);
      if (bucket) bucket.push(row);
      else dayEvents.set(localDate, [row]);
    };

    // ---- scheduled doses, check-in sends, replies, and outcomes --------------------------------
    for (let daysAgo = 0; daysAgo <= oldestDay; daysAgo += 1) {
      if (stopped && daysAgo < spec.stoppedDaysAgo!) continue;
      const fireAt = anchor.minus({ days: daysAgo });
      const localDate = fireAt.toISODate()!;
      const doseId = demoUuid(`dose/${spec.slug}/${daysAgo}`);
      const key = `${spec.slug}:${daysAgo}`;
      const outcome = doseOutcome(spec, daysAgo);

      doses.push({
        id: doseId,
        patient_id: patientId,
        scheduled_at: fireAt.toISO(),
        local_dose_time: fireAt.toFormat('HH:mm'),
        schedule_timezone: spec.timezone,
        dose_date: localDate,
        patient_medication_id: medicationId,
        created_at: fireAt.minus({ days: 1 }).toISO(),
      });

      const sentAt = fireAt.plus({ minutes: 1 });
      checkIns.push({
        id: demoUuid(`checkin/${spec.slug}/${daysAgo}`),
        patient_id: patientId,
        dose_id: doseId,
        status: 'delivered',
        sent_at: sentAt.toISO(),
        status_updated_at: sentAt.plus({ seconds: 20 }).toISO(),
        created_at: fireAt.toISO(),
        message_kind: 'check_in',
        body: `Time for your ${spec.medicationName}. Did you take it? Reply any way you like.`,
        language: spec.language,
      });

      if (outcome === 'missed') {
        adherenceRecords.push({
          id: demoUuid(`adherence/${spec.slug}/${daysAgo}`),
          patient_id: patientId,
          dose_id: doseId,
          inbound_message_id: null,
          adherence_state: 'unknown',
          reason_code: 'none',
          safety_flag: 'none',
          decided_by: 'timeout',
          status: 'missed',
          created_at: sentAt.plus({ minutes: 120 }).toISO(),
        });
        // A bounded reminder ladder is part of the story for the doses that never came back.
        if (daysAgo < spec.reminderLimit) {
          agentReplies.push({
            id: demoUuid(`reminder/${spec.slug}/${daysAgo}`),
            patient_id: patientId,
            dose_id: doseId,
            status: 'delivered',
            sent_at: sentAt.plus({ minutes: 45 }).toISO(),
            status_updated_at: sentAt.plus({ minutes: 46 }).toISO(),
            created_at: sentAt.plus({ minutes: 45 }).toISO(),
            message_kind: 'reminder',
            reminder_attempt: 1,
            body: 'Just checking in again about your dose — no rush, reply whenever you can.',
            language: spec.language,
            in_reply_to_inbound_id: null,
            agent_turn_id: null,
            clarification_topic: null,
            temporal_candidates: null,
          });
        }
        continue;
      }

      const lateMinutes = outcome === 'delayed' ? 190 : 14;
      const receivedAt = sentAt.plus({ minutes: lateMinutes });
      const inboundId = demoUuid(`inbound/${spec.slug}/${daysAgo}`);
      const pool = spec.language === 'es' ? SPANISH_REPLY_TEXT : REPLY_TEXT;
      const body = pick(pool[outcome], key);
      patientInbounds.push({
        id: inboundId,
        patientId,
        doseId,
        body,
        receivedAt,
        safetyFlagged: false,
        isLate: lateMinutes > 120,
        state: outcome,
        language: spec.language,
        policyTier: outcome === 'stopped' ? 'important' : 'routine',
      });

      adherenceRecords.push({
        id: demoUuid(`adherence/${spec.slug}/${daysAgo}`),
        patient_id: patientId,
        dose_id: doseId,
        inbound_message_id: inboundId,
        adherence_state: outcome,
        reason_code: reasonFor(outcome, key),
        safety_flag: 'none',
        decided_by: 'classifier',
        status: 'recorded',
        created_at: receivedAt.plus({ seconds: 4 }).toISO(),
      });

      addEvent(localDate, {
        id: demoUuid(`event/adherence/${spec.slug}/${daysAgo}`),
        patient_id: patientId,
        agent_turn_id: demoUuid(`turn/${inboundId}`),
        source_inbound_id: inboundId,
        event_type: 'adherence',
        event_code: `${outcome}:dose`,
        statement_text: body,
        occurred_at: receivedAt.toISO(),
        local_date: localDate,
        local_time: receivedAt.toFormat('HH:mm'),
        patient_timezone: spec.timezone,
        severity: null,
        normalized_value: outcome,
        patient_medication_id: medicationId,
        dose_id: doseId,
        created_at: receivedAt.plus({ seconds: 5 }).toISO(),
      });

      // A recurring symptom thread gives the severity chart something real to plot.
      if (!stopped && daysAgo % 3 === 0 && daysAgo <= 21) {
        const severity = 3 + Math.floor(roll(`${key}:severity`) * 6);
        addEvent(localDate, {
          id: demoUuid(`event/symptom/${spec.slug}/${daysAgo}`),
          patient_id: patientId,
          agent_turn_id: demoUuid(`turn/${inboundId}`),
          source_inbound_id: inboundId,
          // Post-Wave-3 storage shape (2026-08-17): the live writer (clinical-memory/repository.ts
          // persistEvent) puts every domain field in clinical_values and leaves the physical
          // severity/normalized_value columns NULL. It writes event_type =
          // storedEventType(event.kind) = 'patient_statement' for a symptom claim (Lane W),
          // the only spelling the dashboard's strict clinicalEventRowSchema accepts. Older
          // 'symptom' rows can never be converted (clinical_event is append-only); the day-events
          // read projects them instead (data-api/patient-record.ts READ_EVENT_TYPE_SQL).
          event_type: 'patient_statement',
          event_code: 'symptom',
          statement_text: 'Reported nausea after the dose.',
          occurred_at: receivedAt.plus({ minutes: 2 }).toISO(),
          local_date: localDate,
          local_time: receivedAt.plus({ minutes: 2 }).toFormat('HH:mm'),
          patient_timezone: spec.timezone,
          severity: null,
          normalized_value: null,
          clinical_values: {
            rawSymptom: 'nausea',
            symptomConcept: 'nausea',
            severity: `${severity}`,
          },
          patient_medication_id: medicationId,
          dose_id: doseId,
          created_at: receivedAt.plus({ minutes: 2 }).toISO(),
        });
      }
    }

    // ---- upcoming doses: the schedule is live, not just history --------------------------------
    if (!stopped) {
      for (let ahead = 1; ahead <= DEMO_UPCOMING_DAYS; ahead += 1) {
        const fireAt = anchor.plus({ days: ahead });
        doses.push({
          id: demoUuid(`dose-upcoming/${spec.slug}/${ahead}`),
          patient_id: patientId,
          scheduled_at: fireAt.toISO(),
          local_dose_time: fireAt.toFormat('HH:mm'),
          schedule_timezone: spec.timezone,
          dose_date: fireAt.toISODate(),
          patient_medication_id: medicationId,
          created_at: now.toISO(),
        });
      }
    }

    // ---- spontaneous inbound texts that drive the review queues ---------------------------------
    if (spec.slug === 'alice') {
      patientInbounds.push({
        id: demoUuid(`inbound-safety/${spec.slug}`),
        patientId,
        doseId: null,
        body: 'my chest feels tight and I am short of breath since this morning',
        receivedAt: spontaneousAt.safety,
        safetyFlagged: true,
        isLate: false,
        state: 'unknown',
        language: spec.language,
        policyTier: 'emergency',
      });
    }
    if (spec.slug === 'marcus') {
      patientInbounds.push({
        id: demoUuid(`inbound-label/${spec.slug}`),
        patientId,
        doseId: null,
        body: 'took it, but I have had a dry cough for a few days now',
        receivedAt: spontaneousAt.label,
        safetyFlagged: false,
        isLate: false,
        state: 'taken',
        language: spec.language,
        policyTier: 'important',
      });
    }
    if (spec.slug === 'noname') {
      patientInbounds.push({
        id: demoUuid(`inbound-crisis/${spec.slug}`),
        patientId,
        doseId: null,
        body: 'ya no quiero seguir así, no le veo sentido a nada',
        receivedAt: spontaneousAt.crisis,
        safetyFlagged: true,
        isLate: false,
        state: 'unknown',
        language: spec.language,
        policyTier: 'emergency',
      });
      patientInbounds.push({
        id: demoUuid(`inbound-unattributed/${spec.slug}`),
        patientId,
        doseId: null,
        body: 'la otra pastilla, la que me dieron nueva',
        receivedAt: spontaneousAt.unattributed,
        safetyFlagged: false,
        isLate: false,
        state: 'unknown',
        language: spec.language,
        policyTier: 'routine',
      });
    }

    // ---- inbound rows, their turn markers, and the agent's replies ------------------------------
    const ordered = [...patientInbounds].sort(
      (left, right) => left.receivedAt.toMillis() - right.receivedAt.toMillis(),
    );
    ordered.forEach((inbound, index) => {
      const sequence = index + 1;
      inbounds.push({
        id: inbound.id,
        patient_id: patientId,
        dose_id: inbound.doseId,
        raw_body: inbound.body,
        safety_flagged: inbound.safetyFlagged,
        is_late: inbound.isLate,
        received_at: inbound.receivedAt.toISO(),
        enqueued_at: inbound.receivedAt.plus({ seconds: 1 }).toISO(),
        inbound_sequence: sequence,
      });

      const jobId = demoUuid(`job/${inbound.id}`);
      const turnId = demoUuid(`turn/${inbound.id}`);
      turnJobs.push({
        id: jobId,
        patient_id: patientId,
        inbound_message_id: inbound.id,
        inbound_sequence: sequence,
        interpretation_attempted_at: inbound.receivedAt.plus({ seconds: 1 }).toISO(),
        writer_attempted_at: inbound.receivedAt.plus({ seconds: 3 }).toISO(),
        completed_at: inbound.receivedAt.plus({ seconds: 4 }).toISO(),
        messaging_state_version: 1,
        created_at: inbound.receivedAt.plus({ seconds: 1 }).toISO(),
      });
      agentTurns.push({
        id: turnId,
        patient_id: patientId,
        inbound_message_id: inbound.id,
        turn_job_id: jobId,
        detected_language: inbound.language,
        normalized_english_meaning: ENGLISH_MEANING[inbound.state],
        translated_text: inbound.language === 'en' ? null : englishGloss(inbound.body),
        model_id: 'claude-haiku-4-5-20251001',
        prompt_version: 'demo-seed-v1',
        schema_version: 'demo-seed-v1',
        context_hash: contentHash(`context/${inbound.id}`),
        input_tokens: 420 + Math.floor(roll(`${inbound.id}:in`) * 600),
        output_tokens: 60 + Math.floor(roll(`${inbound.id}:out`) * 180),
        latency_ms: 700 + Math.floor(roll(`${inbound.id}:ms`) * 1500),
        final_policy_tier: inbound.policyTier,
        created_at: inbound.receivedAt.plus({ seconds: 4 }).toISO(),
      });

      // Only the conversationally interesting turns produce a visible agent SMS; a plain "took it"
      // is acknowledged silently, exactly as the routine tier is meant to behave.
      const wantsReply =
        inbound.doseId === null || inbound.state === 'stopped' || sequence % 6 === 0;
      if (!wantsReply) return;
      const isClarification = inbound.id === demoUuid(`inbound-unattributed/${spec.slug}`);
      agentReplies.push({
        id: demoUuid(`agentreply/${inbound.id}`),
        patient_id: patientId,
        dose_id: null,
        status: 'delivered',
        sent_at: inbound.receivedAt.plus({ seconds: 12 }).toISO(),
        status_updated_at: inbound.receivedAt.plus({ seconds: 30 }).toISO(),
        created_at: inbound.receivedAt.plus({ seconds: 10 }).toISO(),
        message_kind: isClarification ? 'clarification' : 'acknowledgement',
        reminder_attempt: null,
        body: isClarification
          ? '¿Se refiere a la atorvastatina de 20 mg o a otro medicamento?'
          : 'Thanks — noted. Your care team can see this.',
        language: inbound.language,
        in_reply_to_inbound_id: inbound.id,
        agent_turn_id: turnId,
        clarification_topic: isClarification ? 'medication_identity' : null,
        temporal_candidates: isClarification
          ? json([{ label: 'atorvastatin 20 mg', kind: 'medication' }])
          : null,
      });
    });

    const inboundCount = ordered.length;
    const lastInbound = ordered.at(-1);

    // ---- the patient row itself ------------------------------------------------------------------
    patients.push({
      id: patientId,
      owner_clinician_sub: ownerSub,
      phone: spec.phone,
      display_name: spec.displayName,
      timezone: spec.timezone,
      medication_name: spec.medicationName,
      is_test: true,
      is_active: !stopped,
      agent_enabled: !stopped,
      provider_opted_in: !stopped,
      opted_out_at: stopped ? anchor.minus({ days: spec.stoppedDaysAgo! }).toISO() : null,
      preferred_language: spec.language,
      reminder_limit: spec.reminderLimit,
      messaging_state_version: 1,
      next_inbound_sequence: inboundCount + 1,
      created_at: anchor.minus({ days: oldestDay + 2 }).toISO(),
    });

    medications.push({
      id: medicationId,
      patient_id: patientId,
      entered_name: spec.enteredName,
      identity_system: 'rxnorm',
      identity_code: spec.ingredients[0]!.rxcui,
      dose_text: spec.doseText,
      form: spec.form,
      route: spec.route,
      valid_from: anchor.minus({ days: oldestDay + 2 }).toISODate(),
      valid_to: stopped ? anchor.minus({ days: spec.stoppedDaysAgo! }).toISODate() : null,
      status: stopped ? 'stopped' : 'active',
      confirmed_by_clinician_sub: ownerSub,
      confirmed_at: anchor.minus({ days: oldestDay + 2 }).toISO(),
      created_at: anchor.minus({ days: oldestDay + 2 }).toISO(),
    });
    spec.ingredients.forEach((ingredient, index) => {
      medicationIngredients.push({
        id: demoUuid(`ingredient/${spec.slug}/${index}`),
        patient_id: patientId,
        patient_medication_id: medicationId,
        ingredient_order: index + 1,
        ingredient_name: ingredient.name,
        ccdd_ingredient_code: ingredient.ccddIngredientCode,
        rxcui: ingredient.rxcui,
        created_at: anchor.minus({ days: oldestDay + 2 }).toISO(),
      });
    });

    clinicalFacts.push(
      {
        id: demoUuid(`fact/condition/${spec.slug}`),
        patient_id: patientId,
        fact_type: 'condition',
        fact_code: null,
        statement_text: spec.condition,
        status: 'current',
        authored_by_clinician_sub: ownerSub,
        created_at: anchor.minus({ days: oldestDay + 1 }).toISO(),
      },
      {
        id: demoUuid(`fact/allergy/${spec.slug}`),
        patient_id: patientId,
        fact_type: 'allergy',
        fact_code: null,
        statement_text: spec.allergy,
        status: 'current',
        authored_by_clinician_sub: ownerSub,
        created_at: anchor.minus({ days: oldestDay + 1 }).toISO(),
      },
    );

    // ---- safety events, label hints, and the unattributed ambiguity row --------------------------
    if (spec.slug === 'alice') {
      const inboundId = demoUuid(`inbound-safety/${spec.slug}`);
      const at = spontaneousAt.safety;
      safetyEvents.push({
        id: demoUuid(`safety/${spec.slug}`),
        patient_id: patientId,
        inbound_message_id: inboundId,
        flag_category: 'acute_physical',
        trigger_source: 'both',
        auto_reply_status: 'sent',
        auto_reply_sent_at: at.plus({ seconds: 20 }).toISO(),
        auto_reply_error: null,
        created_at: at.plus({ seconds: 2 }).toISO(),
      });
      addEvent(at.toISODate()!, {
        id: demoUuid(`event/alert/${spec.slug}`),
        patient_id: patientId,
        agent_turn_id: demoUuid(`turn/${inboundId}`),
        source_inbound_id: inboundId,
        event_type: 'alert',
        event_code: 'emergency',
        statement_text: 'Chest tightness with shortness of breath reported by the patient.',
        occurred_at: at.toISO(),
        local_date: at.toISODate(),
        local_time: at.toFormat('HH:mm'),
        patient_timezone: spec.timezone,
        severity: 9,
        normalized_value: 'chest tightness',
        patient_medication_id: medicationId,
        dose_id: null,
        created_at: at.plus({ seconds: 3 }).toISO(),
      });
    }
    if (spec.slug === 'noname') {
      const crisisId = demoUuid(`inbound-crisis/${spec.slug}`);
      const at = spontaneousAt.crisis;
      safetyEvents.push({
        id: demoUuid(`safety/${spec.slug}`),
        patient_id: patientId,
        inbound_message_id: crisisId,
        flag_category: 'crisis',
        trigger_source: 'model',
        // A failed auto-reply is what pushes this event into the urgent tier of the safety queue.
        auto_reply_status: 'failed',
        auto_reply_sent_at: null,
        auto_reply_error: 'provider rejected the message (demo)',
        created_at: at.plus({ seconds: 2 }).toISO(),
      });
      addEvent(at.toISODate()!, {
        id: demoUuid(`event/alert/${spec.slug}`),
        patient_id: patientId,
        agent_turn_id: demoUuid(`turn/${crisisId}`),
        source_inbound_id: crisisId,
        event_type: 'alert',
        event_code: 'emergency',
        statement_text: 'Patient expressed hopelessness; crisis resources were sent.',
        occurred_at: at.toISO(),
        local_date: at.toISODate(),
        local_time: at.toFormat('HH:mm'),
        patient_timezone: spec.timezone,
        severity: 10,
        normalized_value: 'hopelessness',
        patient_medication_id: null,
        dose_id: null,
        created_at: at.plus({ seconds: 3 }).toISO(),
      });

      const unattributedId = demoUuid(`inbound-unattributed/${spec.slug}`);
      const unattributedAt = spontaneousAt.unattributed;
      adherenceRecords.push({
        id: demoUuid(`adherence-unattributed/${spec.slug}`),
        patient_id: patientId,
        dose_id: null,
        inbound_message_id: unattributedId,
        adherence_state: 'unknown',
        reason_code: 'none',
        safety_flag: 'none',
        decided_by: 'classifier',
        status: 'recorded',
        created_at: unattributedAt.plus({ seconds: 4 }).toISO(),
      });
    }
    if (spec.slug === 'marcus') {
      const inboundId = demoUuid(`inbound-label/${spec.slug}`);
      const at = spontaneousAt.label;
      labelMatches.push({
        id: demoUuid(`label/${spec.slug}`),
        inbound_message_id: inboundId,
        patient_id: patientId,
        matched_phrase: 'dry cough',
        meddra_pt: 'Cough',
        hint_level: 'elevated',
        created_at: at.plus({ seconds: 6 }).toISO(),
      });
      addEvent(at.toISODate()!, {
        id: demoUuid(`event/alert/${spec.slug}`),
        patient_id: patientId,
        agent_turn_id: demoUuid(`turn/${inboundId}`),
        source_inbound_id: inboundId,
        event_type: 'alert',
        event_code: 'important',
        statement_text: 'Persistent dry cough reported while on an ACE inhibitor.',
        occurred_at: at.toISO(),
        local_date: at.toISODate(),
        local_time: at.toFormat('HH:mm'),
        patient_timezone: spec.timezone,
        severity: 4,
        normalized_value: 'dry cough',
        patient_medication_id: medicationId,
        dose_id: null,
        created_at: at.plus({ seconds: 3 }).toISO(),
      });
      // The one worked example of frozen, cited evidence hanging off a clinical event.
      eventEvidence.push({
        patient_id: patientId,
        clinical_event_id: demoUuid(`event/alert/${spec.slug}`),
        evidence_record_id: demoUuid('evidence/lisinopril-cough'),
        template_id: 'demo.symptom.label_context',
        created_at: at.plus({ seconds: 4 }).toISO(),
      });
    }

    // ---- daily summaries for the last week ------------------------------------------------------
    for (let daysAgo = 0; daysAgo <= 6 && !stopped; daysAgo += 1) {
      const localDate = anchor.minus({ days: daysAgo }).toISODate()!;
      const dayRows = dayEvents.get(localDate) ?? [];
      if (dayRows.length === 0) continue;
      const windowStart = anchor.minus({ days: daysAgo }).startOf('day');
      dailySummaries.push({
        id: demoUuid(`summary/${spec.slug}/${daysAgo}`),
        patient_id: patientId,
        local_date: localDate,
        version: 1,
        window_start: windowStart.toISO(),
        window_end: windowStart.plus({ days: 1 }).toISO(),
        input_hash: contentHash(`summary/${spec.slug}/${localDate}`),
        event_count: dayRows.length,
        highest_tier: summaryTier(dayRows),
        structured_payload: json(buildSummaryPayload(localDate, spec.timezone, dayRows)),
        summary_text: summaryText(spec, dayRows),
        created_at: anchor.minus({ days: daysAgo }).plus({ minutes: 5 }).toISO(),
      });
    }

    // ---- clinician review drafts: one open, one already decided ---------------------------------
    if (spec.slug === 'alice' || spec.slug === 'priya') {
      const daysAgo = spec.slug === 'alice' ? 0 : 2;
      const draftId = demoUuid(`draft/${spec.slug}`);
      const draftAt = anchor.minus({ days: daysAgo }).plus({ minutes: 10 });
      const correctionId = demoUuid(`correction/${spec.slug}`);
      const sourceMessageId = lastInbound?.id ?? demoUuid(`inbound/${spec.slug}/0`);
      reviewDrafts.push({
        id: draftId,
        patient_id: patientId,
        local_date: draftAt.toISODate(),
        version: 1,
        input_hash: contentHash(`draft/${spec.slug}`),
        patient_statements: json([
          { sourceMessageId, text: 'Patient described taking the dose later than scheduled.' },
        ]),
        confirmed_facts: json([demoUuid(`fact/condition/${spec.slug}`)]),
        model_inferences: json(['Timing drift appears tied to weekday mornings.']),
        uncertainties: json(['Whether the delay is intentional or forgetfulness is unresolved.']),
        evidence_references: json(['demo.symptom.label_context']),
        proposed_corrections: json([
          {
            correctionId,
            factId: demoUuid(`fact/condition/${spec.slug}`),
            proposedText: `${spec.condition}; dose timing under review`,
            rationale: 'Repeated late-morning administrations across the trailing two weeks.',
            sourceMessageIds: [sourceMessageId],
          },
        ]),
        draft_text:
          `Trailing-week review for ${spec.displayName ?? 'this patient'}: ` +
          'adherence is mixed, with repeated late administrations and one reported symptom thread. ' +
          'No medication change is proposed; confirm or reject the timing note below.',
        source_agent_turn_id: lastInbound ? demoUuid(`turn/${lastInbound.id}`) : null,
        created_at: draftAt.toISO(),
      });
      if (spec.slug === 'priya') {
        reviewActions.push({
          id: demoUuid(`action/${spec.slug}`),
          patient_id: patientId,
          clinician_review_draft_id: draftId,
          clinician_sub: ownerSub,
          decision: 'confirm',
          expected_version: 1,
          selected_correction_ids: [correctionId],
          created_at: draftAt.plus({ hours: 3 }).toISO(),
        });
      }
    }
  }

  const frozenAt = now.minus({ days: 40 });
  return {
    patientIds: demoPatientIds(),
    sourceReleaseId: DEMO_SOURCE_RELEASE_ID,
    batches: [
      {
        table: 'source_release',
        rows: [
          {
            id: DEMO_SOURCE_RELEASE_ID,
            source_name: 'medlineplus',
            release_version: 'demo-seed-v1',
            checksum_sha256: contentHash('source-release/medlineplus'),
            source_url: 'https://medlineplus.gov/druginfo/meds/a692051.html',
            licence_id: 'US-Government-Public-Domain',
            // Deliberately NOT 'active': `uq_source_release_one_active` is a partial unique index on
            // source_name, so an active demo row could collide with a real import later. No read
            // path filters on state, so the evidence panel is unaffected.
            state: 'superseded',
            is_complete: true,
            retrieved_at: frozenAt.toISO(),
            fresh_until: frozenAt.plus({ days: 30 }).toISO(),
            created_at: frozenAt.toISO(),
          },
        ],
      },
      {
        table: 'evidence_record',
        rows: [
          {
            id: demoUuid('evidence/lisinopril-cough'),
            source_release_id: DEMO_SOURCE_RELEASE_ID,
            evidence_code: 'lisinopril.adverse.cough',
            evidence_kind: 'medlineplus',
            language: 'en',
            passage:
              'A dry, persistent cough is a well-described effect of ACE inhibitors such as ' +
              'lisinopril and usually resolves after the medicine is stopped.',
            source_url: 'https://medlineplus.gov/druginfo/meds/a692051.html',
            coverage_state: 'direct_evidence',
            created_at: frozenAt.toISO(),
          },
        ],
      },
      { table: 'patient', rows: patients },
      { table: 'patient_medication', rows: medications },
      { table: 'patient_medication_ingredient', rows: medicationIngredients },
      { table: 'dose_schedule', rows: doses },
      { table: 'outbound_message', rows: checkIns },
      { table: 'inbound_reply', rows: inbounds },
      { table: 'turn_job', rows: turnJobs },
      { table: 'agent_turn', rows: agentTurns },
      { table: 'outbound_message', rows: agentReplies },
      { table: 'adherence_record', rows: adherenceRecords },
      { table: 'safety_events', rows: safetyEvents },
      { table: 'label_match', rows: labelMatches },
      { table: 'clinical_event', rows: clinicalEvents },
      { table: 'clinical_event_evidence', rows: eventEvidence },
      { table: 'daily_summary', rows: dailySummaries },
      { table: 'clinician_review_draft', rows: reviewDrafts },
      { table: 'clinician_review_action', rows: reviewActions },
      { table: 'clinical_fact', rows: clinicalFacts },
    ],
  };
}

/** A crude, fixed gloss so the non-English demo turns carry a translation the reviewer can read. */
function englishGloss(body: string): string {
  const glosses: Record<string, string> = {
    'sí, ya la tomé': 'yes, I already took it',
    'tomada con el desayuno': 'taken with breakfast',
    'la tomé tarde, como a la una': 'I took it late, around one',
    'hoy no la tomé, me dolía el estómago': "I didn't take it today, my stomach hurt",
    'dejé de tomarla': 'I stopped taking it',
    'no me acuerdo bien': "I don't remember clearly",
    'ya no quiero seguir así, no le veo sentido a nada':
      "I don't want to go on like this, nothing feels meaningful",
    'la otra pastilla, la que me dieron nueva': 'the other pill, the new one they gave me',
  };
  return glosses[body] ?? body;
}

/**
 * Severity lives in the `clinical_values` jsonb (as a free-text string) on events written by the
 * live conversational core, and in the legacy physical `severity` column on the alert rows this
 * seed still writes that way. Mirrors canonical-projections.ts `summaryEvent`, which reads the
 * jsonb field and admits only 1-10.
 */
function eventSeverity(row: Record<string, unknown>): number | null {
  const physical = row.severity as number | null | undefined;
  if (typeof physical === 'number') return physical;
  const stored = (row.clinical_values as { severity?: unknown } | null | undefined)?.severity;
  return typeof stored === 'string' && /^(?:10|[1-9])$/u.test(stored) ? Number(stored) : null;
}

function summaryTier(rows: readonly Record<string, unknown>[]): string {
  if (rows.some((row) => row.event_code === 'emergency')) return 'emergency';
  if (rows.some((row) => row.event_type === 'alert' || eventSeverity(row) !== null)) {
    return 'important';
  }
  return 'routine';
}

function eventPriority(row: Record<string, unknown>): string {
  if (row.event_code === 'emergency') return 'emergency';
  if (row.event_type === 'alert') return 'important';
  return 'routine';
}

/** Matches `daySummaryPayloadSchema` in dashboard/src/lib/dashboard-contracts.ts exactly (strict). */
function buildSummaryPayload(
  localDate: string,
  timezone: string,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const counts = { taken: 0, delayed: 0, skipped: 0, stopped: 0, unknown: 0, question: 0 };
  for (const row of rows) {
    if (row.event_type !== 'adherence') continue;
    const state = String(row.event_code ?? '').split(':')[0] ?? '';
    if (state in counts) counts[state as keyof typeof counts] += 1;
  }
  return {
    localDate,
    patientTimeZone: timezone,
    eventCount: rows.length,
    detailedEventCount: rows.length,
    truncated: false,
    eventIds: rows.map((row) => row.id),
    events: rows.map((row) => ({
      eventId: row.id,
      eventType: row.event_type,
      eventCode: row.event_code ?? null,
      occurredAtUtc: new Date(String(row.occurred_at)).toISOString(),
      severity: eventSeverity(row),
      priority: eventPriority(row),
    })),
    symptomCount: rows.filter((row) => row.event_code === 'symptom').length,
    adherenceCounts: counts,
    highestPriority: summaryTier(rows),
  };
}

function summaryText(spec: DemoPatientSpec, rows: readonly Record<string, unknown>[]): string {
  const who = spec.displayName ?? 'The patient';
  const alerts = rows.filter((row) => row.event_type === 'alert').length;
  return (
    `${who} produced ${rows.length} recorded event(s) for ${spec.medicationName}` +
    (alerts > 0 ? `, including ${alerts} needing clinician attention.` : '.')
  );
}

// --- database application -------------------------------------------------------------------------

export interface SeedClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Row-count-bounded multi-row INSERT. Table/column names are module constants, never user input. */
async function insertBatch(client: SeedClient, batch: TableBatch): Promise<void> {
  if (batch.rows.length === 0) return;
  const columns = Object.keys(batch.rows[0]!);
  const rowsPerStatement = Math.max(1, Math.floor(2000 / columns.length));
  for (let start = 0; start < batch.rows.length; start += rowsPerStatement) {
    const chunk = batch.rows.slice(start, start + rowsPerStatement);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((column) => {
        if (!(column in row)) {
          throw new Error(`demo-seed: ${batch.table} row is missing column "${column}"`);
        }
        values.push(row[column] ?? null);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${batch.table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

export interface WipeCounts {
  readonly patientsDeleted: number;
  readonly releasesDeleted: number;
}

/**
 * Delete exactly the demo rows. Every demo child row cascades from `patient` (STUDY-04), so two
 * statements cover the whole cohort; the frozen evidence release is the only non-patient-owned row.
 * The caller owns the transaction so the seed can reuse this as its delete-then-insert first half.
 */
async function deleteDemoRows(client: SeedClient, plan: DemoPlan): Promise<WipeCounts> {
  const patientsDeleted = await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
    plan.patientIds,
  ]);
  const releasesDeleted = await client.query('DELETE FROM source_release WHERE id = $1', [
    plan.sourceReleaseId,
  ]);
  return {
    patientsDeleted: patientsDeleted.rowCount ?? 0,
    releasesDeleted: releasesDeleted.rowCount ?? 0,
  };
}

export interface SeedCounts {
  readonly deleted: WipeCounts;
  readonly inserted: Readonly<Record<string, number>>;
}

/** ONE transaction: remove the previous generation of demo rows, then write the current one. */
export async function applyDemoSeed(client: SeedClient, plan: DemoPlan): Promise<SeedCounts> {
  await client.query('BEGIN');
  try {
    const deleted = await deleteDemoRows(client, plan);
    const inserted: Record<string, number> = {};
    for (const batch of plan.batches) {
      await insertBatch(client, batch);
      inserted[batch.table] = (inserted[batch.table] ?? 0) + batch.rows.length;
    }
    await client.query('COMMIT');
    return { deleted, inserted };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** ONE transaction: remove the demo cohort and nothing else. */
export async function wipeDemoSeed(client: SeedClient, plan: DemoPlan): Promise<WipeCounts> {
  await client.query('BEGIN');
  try {
    const counts = await deleteDemoRows(client, plan);
    await client.query('COMMIT');
    return counts;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// --- CLI ------------------------------------------------------------------------------------------

/** Parse a `--flag value` option from argv; reject a missing or next-flag value loudly. */
export function argValue(flag: string, argv: readonly string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`demo-seed: ${flag} requires a value`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RdsSecret {
  readonly username: string;
  readonly password: string;
  readonly host?: string;
  readonly port?: number;
  readonly dbname?: string;
}

function readRdsCaBundle(): string {
  return readFileSync(
    join(__dirname, '..', 'backend', 'src', 'schema-init', 'rds-global-bundle.pem'),
    'utf8',
  );
}

/**
 * Build the operator client. PRIMARY mode resolves the RDS-managed credential through the Secrets
 * Manager SDK (mirroring backend/src/shared/db-pool.ts) because the operator shell cannot run
 * `aws secretsmanager get-secret-value`. host/port default to the localhost SSM tunnel while TLS
 * still verifies against the tracked RDS CA using the secret's real endpoint as the SNI servername.
 * The credential is never logged. SECONDARY mode is a plain `--database-url` for local databases.
 */
export async function buildClient(argv: readonly string[]): Promise<Client> {
  const databaseUrl = argValue('--database-url', argv);
  const secretArn = argValue('--db-secret-arn', argv);
  if (databaseUrl !== undefined && secretArn !== undefined) {
    throw new Error('demo-seed: --database-url and --db-secret-arn are mutually exclusive');
  }
  if (databaseUrl !== undefined) return new Client({ connectionString: databaseUrl });
  if (secretArn === undefined) {
    throw new Error(
      'demo-seed: one of --db-secret-arn (deployed) or --database-url (local) is required',
    );
  }

  const secrets = new SecretsManagerClient({});
  const secretValue = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!secretValue.SecretString) {
    throw new Error('demo-seed: DB secret has no SecretString — secret not populated');
  }
  const secret = JSON.parse(secretValue.SecretString) as RdsSecret;
  if (!secret.username || !secret.password) {
    throw new Error('demo-seed: DB secret is missing username/password');
  }

  const host = argValue('--host', argv) ?? '127.0.0.1';
  const port = Number(argValue('--port', argv) ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`demo-seed: --port is not a valid TCP port (1-65535)`);
  }
  const database = argValue('--db', argv) ?? secret.dbname ?? 'medadhere';
  const servername = argValue('--tls-servername', argv) ?? secret.host;
  if (servername === undefined) {
    throw new Error(
      'demo-seed: the DB secret has no host; pass --tls-servername <rds-endpoint> so TLS can verify',
    );
  }

  return new Client({
    host,
    port,
    database,
    user: secret.username,
    password: secret.password,
    ssl: { ca: readRdsCaBundle(), rejectUnauthorized: true, servername },
  });
}

const USAGE =
  'usage: npx tsx scripts/demo-seed.ts (--db-secret-arn <arn> [--host 127.0.0.1] [--port 5432] ' +
  '[--db medadhere] [--tls-servername <rds-endpoint>] | --database-url <url>) ' +
  '(--owner-sub <clinician-sub-uuid> | --wipe)';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wipe = argv.includes('--wipe');
  const ownerSub = argValue('--owner-sub', argv);
  if (!wipe && (ownerSub === undefined || !UUID_PATTERN.test(ownerSub))) {
    console.error('demo-seed: --owner-sub must be the verified Cognito clinician subject (a UUID)');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // The plan's ids do not depend on the owner, so --wipe never needs a clinician subject.
  const plan = buildDemoPlan({
    now: DateTime.now(),
    ownerSub: ownerSub ?? demoUuid('owner/unset'),
  });
  const client = await buildClient(argv);
  await client.connect();
  try {
    if (wipe) {
      const counts = await wipeDemoSeed(client, plan);
      console.log(
        `[demo-seed] wiped — patients deleted: ${counts.patientsDeleted}; ` +
          `frozen evidence releases deleted: ${counts.releasesDeleted}`,
      );
      return;
    }
    const counts = await applyDemoSeed(client, plan);
    const total = Object.values(counts.inserted).reduce((sum, value) => sum + value, 0);
    console.log(
      `[demo-seed] seeded ${plan.patientIds.length} demo patients (is_test=true) — ` +
        `${total} rows across ${Object.keys(counts.inserted).length} tables; ` +
        `replaced ${counts.deleted.patientsDeleted} previous demo patient(s)`,
    );
    console.log('[demo-seed] re-run to refresh; run with --wipe to remove exactly these rows');
  } finally {
    await client.end();
  }
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected error';
    console.error(`[demo-seed] fatal: ${message}`);
    process.exitCode = 1;
  });
}
