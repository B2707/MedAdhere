// backend/src/lib/tester-hygiene.ts
//
// STUDY-04 + DATA-01 tester-data hygiene — the reusable, destructive-op-gated helpers a
// seed/teardown script calls to reset or scrub informal-test-cohort data (Plan 05-02).
//
// TWO operations, both DELIBERATELY hard to trigger by accident (M6):
//   - wipeTestPatients()  — one-transaction CASCADE wipe of every `is_test = true` patient.
//   - scrubTesterText()   — per-tester free-text redaction that KEEPS the audit trail.
//
// ┌─ ONE-WAY ORDERING — READ BEFORE CALLING (M6) ─────────────────────────────────────────┐
// │ wipeTestPatients() is a PRE-COHORT-RESET / PROJECT-END operation ONLY. It CASCADE-      │
// │ deletes every child row (dose_schedule, outbound_message, inbound_reply,                │
// │ adherence_record, safety_events, label_match) of every is_test patient. Run mid-cohort  │
// │ it destroys live cohort safety_events + adherence_record. It therefore REQUIRES an      │
// │ explicit { confirmDestructive: true } and refuses loudly otherwise — there is no        │
// │ "default yes". Sweep the EventBridge schedules FIRST (done here, M5) so no orphaned      │
// │ one-shot fires against a row that has been deleted out from under it.                    │
// └────────────────────────────────────────────────────────────────────────────────────────┘
//
// ┌─ TEARDOWN LIFECYCLE (project end) ────────────────────────────────────────────────────┐
// │ 1. Operational DB: `cdk destroy` removes the RDS instance outright — the database        │
// │    construct sets removalPolicy: DESTROY + deletionProtection (default false) +          │
// │    deleteAutomatedBackups: true (infra/lib/constructs/database.ts). No manual DB step;    │
// │    teardown-purge.test.ts asserts that wiring stays in place.                             │
// │ 2. Twilio message logs: NOT owned by our IaC and NOT reachable by `cdk destroy`. Purge    │
// │    them MANUALLY at project end via the Twilio Console (Monitor → Logs → Messaging) or    │
// │    the REST API. This is the one teardown step the stack cannot perform for you.          │
// └────────────────────────────────────────────────────────────────────────────────────────┘
//
// ┌─ CREDENTIAL — ADMIN ONLY (M-05) ──────────────────────────────────────────────────────┐
// │ Pass a client on the ADMIN (RDS master) credential, never the `medadhere_app` runtime   │
// │ role. Since M-05 the runtime role has DELETE REVOKEd on every append-only clinical/     │
// │ source/audit table (schema-init `applicationRoleSql`), so scrubTesterText's delete_rows │
// │ manifest steps — clinical_event, patient_medication, agent_turn, … — would raise 42501  │
// │ PART-WAY THROUGH and roll the whole scrub back. wipeTestPatients would still cascade    │
// │ from `patient` (RI triggers run as the table owner), but both operations are            │
// │ maintenance, not runtime: scripts/wipe-test-patients.ts resolves DB_SECRET_ARN from the │
// │ stack's DatabaseInstanceSecret (the master secret) — ops-runbook-06.md §DB_SECRET_ARN.  │
// └────────────────────────────────────────────────────────────────────────────────────────┘

import { deactivateSchedules } from './scheduler-deactivate';

/**
 * The patient child tables that FK `patient` ON DELETE CASCADE — i.e. the exact blast radius of
 * the STUDY-04 wipe. Exported as the single source of truth: schema.test.ts's drift guard asserts
 * this list EXACTLY equals the live `information_schema` CASCADE set, so a future child table added
 * to schema.sql cannot silently escape the wipe/scrub without failing a test.
 */
export const STUDY04_CASCADE_CHILDREN = [
  'dose_schedule',
  'outbound_message',
  'inbound_reply',
  'adherence_record',
  'safety_events',
  'label_match',
  'patient_medication',
  'patient_medication_ingredient',
  'clinical_fact',
  'turn_job',
  'agent_turn',
  'clinical_event',
  'clinical_event_source',
  'clinical_event_evidence',
  'information_need',
  'information_need_scope',
  'information_need_event_candidate',
  'information_need_transition',
  'clinical_review_item',
  'clinical_review_item_transition',
  'daily_summary',
  'clinician_review_draft',
  'clinician_review_action',
  'usage_bucket',
] as const;

export const PHASE8_PATIENT_OWNED_TABLES = [
  'patient_medication',
  'patient_medication_ingredient',
  'clinical_fact',
  'turn_job',
  'agent_turn',
  'clinical_event',
  'clinical_event_source',
  'clinical_event_evidence',
  'information_need',
  'information_need_scope',
  'information_need_event_candidate',
  'information_need_transition',
  'clinical_review_item',
  'clinical_review_item_transition',
  'daily_summary',
  'clinician_review_draft',
  'clinician_review_action',
  'usage_bucket',
] as const;

export type TesterHygieneScrubAction =
  | 'preserve'
  | 'redact_empty_string'
  | 'redact_null'
  | 'delete_rows';

export type TesterHygieneReadSurface =
  | 'owner_scoped_data_api'
  | 'owner_scoped_review_queue'
  | 'service_owned_export'
  | 'privileged_ops'
  | 'future_phase8_owner_scoped_repository'
  | 'internal_worker_only';

interface TesterHygieneFieldInventoryBaseItem {
  readonly table: string;
  readonly column: string;
  readonly writer: string;
  readonly retention: string;
  readonly maxLength: number;
  readonly scrubAction: TesterHygieneScrubAction;
}

export interface TesterHygieneFieldInventoryItem extends TesterHygieneFieldInventoryBaseItem {
  readonly reader: string;
  readonly readSurface: TesterHygieneReadSurface;
}

const TESTER_HYGIENE_FIELD_INVENTORY_BASE = [
  {
    table: 'patient',
    column: 'phone',
    writer: 'enroll',
    retention: 'patient root identifier until wipe/export teardown',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'patient',
    column: 'display_name',
    writer: 'enroll',
    retention: 'patient root display label until wipe/export teardown',
    maxLength: 80,
    scrubAction: 'preserve',
  },
  {
    table: 'patient',
    column: 'timezone',
    writer: 'enroll',
    retention: 'structured scheduling setting',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'patient',
    column: 'preferred_language',
    writer: 'clinician-patient-settings',
    retention: 'structured patient language preference',
    maxLength: 35,
    scrubAction: 'preserve',
  },
  {
    table: 'patient',
    column: 'medication_name',
    writer: 'enroll',
    retention: 'root medication label until wipe/export teardown',
    maxLength: 120,
    scrubAction: 'preserve',
  },
  {
    table: 'patient',
    column: 'drug_profile_json',
    writer: 'drug-profile-freeze',
    retention: 'structured drug facts until wipe/export teardown',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'patient',
    column: 'owner_clinician_sub',
    writer: 'enroll-api',
    retention: 'structured owner UUID',
    maxLength: 36,
    scrubAction: 'preserve',
  },
  {
    table: 'dose_schedule',
    column: 'local_dose_time',
    writer: 'enroll',
    retention: 'structured HH:mm schedule value',
    maxLength: 5,
    scrubAction: 'preserve',
  },
  {
    table: 'dose_schedule',
    column: 'schedule_timezone',
    writer: 'enroll',
    retention: 'structured IANA timezone',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'outbound_message',
    column: 'twilio_sid',
    writer: 'outbound',
    retention: 'provider delivery identifier until wipe/export teardown',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'outbound_message',
    column: 'status',
    writer: 'outbound',
    retention: 'structured delivery status',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'outbound_message',
    column: 'body',
    writer: 'outbound',
    retention: 'exact outbound SMS body for real patients; test patients redact in place',
    maxLength: 320,
    scrubAction: 'redact_empty_string',
  },
  // ORDER MATTERS: composed_body must be cleared BEFORE composition — the live
  // outbound_message_composed_body_check requires a non-null composition next to any composed
  // body, so redacting the provenance first would abort the scrub transaction.
  {
    table: 'outbound_message',
    column: 'composed_body',
    writer: 'conversation-turn-worker',
    retention: 'exact AI-composed SMS body actually sent to real patients; test patients redact',
    // The composed-body CHECK errors on an empty string (btrim + 1..320), so this column
    // redacts to NULL rather than '' like the append-only template body beside it.
    maxLength: 320,
    scrubAction: 'redact_null',
  },
  {
    table: 'outbound_message',
    column: 'composition',
    writer: 'conversation-turn-worker',
    retention:
      'bounded composition provenance (intent, day context, attempts) for the send-time re-check',
    maxLength: 100_000,
    scrubAction: 'redact_null',
  },
  {
    table: 'outbound_message',
    column: 'message_kind',
    writer: 'outbound',
    retention: 'structured outbound message purpose',
    maxLength: 24,
    scrubAction: 'preserve',
  },
  {
    table: 'outbound_message',
    column: 'language',
    writer: 'conversation-turn-worker',
    retention: 'structured outbound language tag',
    maxLength: 35,
    scrubAction: 'preserve',
  },
  {
    table: 'outbound_message',
    column: 'clarification_topic',
    writer: 'conversation-turn-worker',
    retention: 'structured latest-question topic',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'outbound_message',
    column: 'temporal_candidates',
    writer: 'conversation-turn-worker',
    retention: 'bounded structured pending temporal candidates',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'inbound_reply',
    column: 'raw_body',
    writer: 'inbound',
    retention: 'immutable inbound evidence for real patients; test patients redact in place',
    maxLength: 2_000,
    scrubAction: 'redact_empty_string',
  },
  {
    table: 'inbound_reply',
    column: 'twilio_message_sid',
    writer: 'inbound',
    retention: 'provider dedupe identifier until wipe/export teardown',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'inbound_reply',
    column: 'original_control',
    writer: 'inbound',
    retention: 'bounded STOP or START replay authorization marker',
    maxLength: 5,
    scrubAction: 'preserve',
  },
  {
    table: 'adherence_record',
    column: 'adherence_state',
    writer: 'classifier-timeout',
    retention: 'structured outcome projection',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'adherence_record',
    column: 'reason_code',
    writer: 'classifier-timeout',
    retention: 'structured reason projection',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'adherence_record',
    column: 'safety_flag',
    writer: 'classifier-timeout',
    retention: 'structured safety projection',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'adherence_record',
    column: 'decided_by',
    writer: 'classifier-timeout',
    retention: 'structured arbiter provenance',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'adherence_record',
    column: 'status',
    writer: 'classifier-timeout',
    retention: 'structured dose status',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'safety_events',
    column: 'flag_category',
    writer: 'inbound-classifier',
    retention: 'structured safety audit category',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'safety_events',
    column: 'trigger_source',
    writer: 'inbound-classifier',
    retention: 'structured safety provenance',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'safety_events',
    column: 'auto_reply_status',
    writer: 'inbound-classifier',
    retention: 'structured auto-reply lifecycle',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'safety_events',
    column: 'auto_reply_twilio_sid',
    writer: 'inbound-classifier',
    retention: 'provider delivery identifier until wipe/export teardown',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'safety_events',
    column: 'auto_reply_error',
    writer: 'inbound-classifier',
    retention: 'bounded provider diagnostic; test patients null in place',
    maxLength: 500,
    scrubAction: 'redact_null',
  },
  {
    table: 'label_match',
    column: 'matched_phrase',
    writer: 'classifier',
    retention: 'regenerable verbatim ADE hint; test patients delete hint rows',
    maxLength: 2_000,
    scrubAction: 'delete_rows',
  },
  {
    table: 'label_match',
    column: 'meddra_pt',
    writer: 'classifier',
    retention: 'regenerable normalized ADE hint',
    maxLength: 200,
    scrubAction: 'delete_rows',
  },
  {
    table: 'label_match',
    column: 'hint_level',
    writer: 'classifier',
    retention: 'structured ADE hint level',
    maxLength: 32,
    scrubAction: 'delete_rows',
  },
  {
    table: 'patient_medication',
    column: 'entered_name',
    writer: 'clinician-medication-editor',
    retention: 'immutable medication history; test patients delete derived rows',
    maxLength: 320,
    scrubAction: 'delete_rows',
  },
  {
    table: 'patient_medication',
    column: 'identity_system',
    writer: 'clinician-medication-editor',
    retention: 'structured medication identity system',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication',
    column: 'identity_code',
    writer: 'clinician-medication-editor',
    retention: 'structured medication identity code',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication',
    column: 'dose_text',
    writer: 'clinician-medication-editor',
    retention: 'immutable medication dose text; row deletion handles test scrub',
    maxLength: 160,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication',
    column: 'form',
    writer: 'clinician-medication-editor',
    retention: 'structured medication form',
    maxLength: 80,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication',
    column: 'route',
    writer: 'clinician-medication-editor',
    retention: 'structured medication route',
    maxLength: 80,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication',
    column: 'status',
    writer: 'clinician-medication-editor',
    retention: 'structured medication status',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication',
    column: 'confirmed_by_clinician_sub',
    writer: 'clinician-medication-editor',
    retention: 'structured confirmer UUID',
    maxLength: 36,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication_ingredient',
    column: 'ingredient_name',
    writer: 'clinician-medication-editor',
    retention: 'immutable ingredient text; test patients delete derived rows',
    maxLength: 320,
    scrubAction: 'delete_rows',
  },
  {
    table: 'patient_medication_ingredient',
    column: 'ccdd_ingredient_code',
    writer: 'clinician-medication-editor',
    retention: 'structured CCDD ingredient code',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'patient_medication_ingredient',
    column: 'rxcui',
    writer: 'clinician-medication-editor',
    retention: 'structured RxNorm ingredient code',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_fact',
    column: 'fact_type',
    writer: 'clinician-clinical-history-editor',
    retention: 'structured clinical fact type',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_fact',
    column: 'fact_code',
    writer: 'clinician-clinical-history-editor',
    retention: 'structured clinical fact code',
    maxLength: 128,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_fact',
    column: 'statement_text',
    writer: 'clinician-clinical-history-editor',
    retention: 'immutable clinical history; test patients delete derived rows',
    maxLength: 1_000,
    scrubAction: 'delete_rows',
  },
  {
    table: 'clinical_fact',
    column: 'status',
    writer: 'clinician-clinical-history-editor',
    retention: 'structured clinical fact status',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_fact',
    column: 'authored_by_clinician_sub',
    writer: 'clinician-clinical-history-editor',
    retention: 'structured author UUID',
    maxLength: 36,
    scrubAction: 'preserve',
  },
  {
    table: 'turn_job',
    column: 'failure_kind',
    writer: 'conversation-turn-worker',
    retention: 'structured turn failure class',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'turn_job',
    column: 'clinical_context_hash',
    writer: 'conversation-turn-worker',
    retention: 'structured clinical snapshot hash',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'turn_job',
    column: 'writer_result',
    writer: 'conversation-turn-worker',
    retention: 'bounded transient writer result until tester scrub or patient wipe',
    maxLength: 100_000,
    scrubAction: 'redact_null',
  },
  {
    table: 'turn_job',
    column: 'interpretation_result',
    writer: 'conversation-turn-worker',
    retention: 'bounded transient interpretation result until tester scrub or patient wipe',
    maxLength: 100_000,
    scrubAction: 'redact_null',
  },
  {
    table: 'agent_turn',
    column: 'detected_language',
    writer: 'conversation-agent',
    retention: 'structured BCP-47-like language tag',
    maxLength: 35,
    scrubAction: 'preserve',
  },
  {
    table: 'agent_turn',
    column: 'normalized_english_meaning',
    writer: 'conversation-agent',
    retention: 'immutable turn interpretation; test patients delete derived rows',
    maxLength: 2_000,
    scrubAction: 'delete_rows',
  },
  {
    table: 'agent_turn',
    column: 'translated_text',
    writer: 'conversation-agent',
    retention: 'immutable translation evidence; row deletion handles test scrub',
    maxLength: 2_000,
    scrubAction: 'preserve',
  },
  {
    table: 'agent_turn',
    column: 'model_id',
    writer: 'conversation-agent',
    retention: 'structured model provenance',
    maxLength: 128,
    scrubAction: 'preserve',
  },
  {
    table: 'agent_turn',
    column: 'prompt_version',
    writer: 'conversation-agent',
    retention: 'structured prompt provenance',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'agent_turn',
    column: 'schema_version',
    writer: 'conversation-agent',
    retention: 'structured schema provenance',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'agent_turn',
    column: 'context_hash',
    writer: 'conversation-agent',
    retention: 'structured context hash',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  ...['clinical_context_hash', 'prepared_batch_hash', 'prepared_command_hash'].map(
    (column) =>
      ({
        table: 'agent_turn',
        column,
        writer: 'clinical-memory-repository',
        retention: 'structured recovery integrity hash; test patients delete the immutable turn',
        maxLength: 64,
        scrubAction: 'preserve',
      }) as const,
  ),
  ...['extractor_version', 'resolver_version', 'reducer_version', 'renderer_version'].map(
    (column) =>
      ({
        table: 'agent_turn',
        column,
        writer: 'clinical-memory-repository',
        retention: 'structured recovery pipeline version; test patients delete the immutable turn',
        maxLength: 64,
        scrubAction: 'preserve',
      }) as const,
  ),
  ...['prepared_command_batch', 'prepared_response_plan', 'prepared_result_receipt'].map(
    (column) =>
      ({
        table: 'agent_turn',
        column,
        writer: 'clinical-memory-repository',
        retention: 'immutable bounded recovery envelope; test patients delete the turn row',
        maxLength: 100_000,
        scrubAction: 'delete_rows',
      }) as const,
  ),
  {
    table: 'agent_turn',
    column: 'final_policy_tier',
    writer: 'conversation-agent',
    retention: 'structured policy tier',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'agent_turn',
    column: 'failure_class',
    writer: 'conversation-agent',
    retention: 'structured failure class',
    maxLength: 32,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_event',
    column: 'event_type',
    writer: 'conversation-agent',
    retention: 'structured clinical event type',
    maxLength: 24,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_event',
    column: 'event_code',
    writer: 'conversation-agent',
    retention: 'structured clinical event code',
    maxLength: 128,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_event',
    column: 'statement_text',
    writer: 'conversation-agent',
    retention: 'immutable clinical event text; test patients delete derived rows',
    maxLength: 2_000,
    scrubAction: 'delete_rows',
  },
  {
    table: 'clinical_event',
    column: 'normalized_value',
    writer: 'conversation-agent',
    retention: 'immutable normalized patient event text; test patients delete derived rows',
    maxLength: 200,
    scrubAction: 'delete_rows',
  },
  {
    table: 'clinical_event',
    column: 'local_time',
    writer: 'conversation-temporal-resolver',
    retention: 'structured resolved patient-local time',
    maxLength: 5,
    scrubAction: 'preserve',
  },
  {
    table: 'clinical_event',
    column: 'patient_timezone',
    writer: 'conversation-temporal-resolver',
    retention: 'structured IANA timezone used for resolution',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  ...['semantic_event_id', 'authored_by', 'review_state', 'clinical_operation'].map(
    (column) =>
      ({
        table: 'clinical_event',
        column,
        writer: 'clinical-memory-repository',
        retention: 'structured recovery event metadata; test patients delete the immutable event',
        maxLength: column === 'semantic_event_id' ? 160 : column === 'clinical_operation' ? 32 : 16,
        scrubAction: 'preserve',
      }) as const,
  ),
  ...['source_spans', 'clinical_values'].map(
    (column) =>
      ({
        table: 'clinical_event',
        column,
        writer: 'clinical-memory-repository',
        retention: 'immutable bounded patient event payload; test patients delete the event row',
        maxLength: 100_000,
        scrubAction: 'delete_rows',
      }) as const,
  ),
  {
    table: 'clinical_event_evidence',
    column: 'template_id',
    writer: 'conversation-agent',
    retention: 'structured event-evidence template id',
    maxLength: 128,
    scrubAction: 'preserve',
  },
  {
    table: 'information_need_scope',
    column: 'scope_payload',
    writer: 'clinical-memory-repository',
    retention: 'immutable bounded clarification scope; test patients delete the need rows',
    maxLength: 100_000,
    scrubAction: 'delete_rows',
  },
  ...['source_spans', 'candidate_scope'].map(
    (column) =>
      ({
        table: 'clinical_review_item',
        column,
        writer: 'clinical-memory-repository',
        retention:
          'immutable bounded clinician review payload; test patients delete the review row',
        maxLength: 100_000,
        scrubAction: 'delete_rows',
      }) as const,
  ),
  {
    table: 'daily_summary',
    column: 'input_hash',
    writer: 'conversation-summary',
    retention: 'structured summary input hash',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'daily_summary',
    column: 'highest_tier',
    writer: 'conversation-summary',
    retention: 'structured summary highest safety tier',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'daily_summary',
    column: 'structured_payload',
    writer: 'conversation-summary',
    retention: 'structured summary payload; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'daily_summary',
    column: 'summary_text',
    writer: 'conversation-summary',
    retention: 'immutable day summary text; test patients delete derived rows',
    maxLength: 4_000,
    scrubAction: 'delete_rows',
  },
  {
    table: 'clinician_review_draft',
    column: 'input_hash',
    writer: 'conversation-review-draft',
    retention: 'structured draft input hash',
    maxLength: 64,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'patient_statements',
    writer: 'conversation-review-draft',
    retention: 'immutable structured patient statements; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'confirmed_facts',
    writer: 'conversation-review-draft',
    retention: 'immutable structured confirmed facts; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'model_inferences',
    writer: 'conversation-review-draft',
    retention: 'immutable structured model inferences; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'uncertainties',
    writer: 'conversation-review-draft',
    retention: 'immutable structured uncertainties; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'evidence_references',
    writer: 'conversation-review-draft',
    retention: 'immutable structured evidence references; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'proposed_corrections',
    writer: 'conversation-review-draft',
    retention: 'immutable structured proposed corrections; row deletion handles test scrub',
    maxLength: 100_000,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_draft',
    column: 'draft_text',
    writer: 'conversation-review-draft',
    retention: 'immutable clinician review draft text; test patients delete derived rows',
    maxLength: 8_000,
    scrubAction: 'delete_rows',
  },
  {
    table: 'clinician_review_action',
    column: 'clinician_sub',
    writer: 'clinician-review-confirmation',
    retention: 'structured reviewing clinician UUID',
    maxLength: 36,
    scrubAction: 'preserve',
  },
  {
    table: 'clinician_review_action',
    column: 'decision',
    writer: 'clinician-review-confirmation',
    retention: 'structured review decision',
    maxLength: 16,
    scrubAction: 'preserve',
  },
  {
    table: 'usage_bucket',
    column: 'bucket_scope',
    writer: 'usage-reservation',
    retention: 'mutable structured usage scope',
    maxLength: 24,
    scrubAction: 'preserve',
  },
  {
    table: 'usage_bucket',
    column: 'subject_key',
    writer: 'usage-reservation',
    retention: 'mutable structured usage subject key',
    maxLength: 128,
    scrubAction: 'preserve',
  },
] as const satisfies readonly TesterHygieneFieldInventoryBaseItem[];

function readerForInventoryItem(
  item: TesterHygieneFieldInventoryBaseItem,
): Pick<TesterHygieneFieldInventoryItem, 'reader' | 'readSurface'> {
  if (item.table === 'safety_events' || item.table === 'label_match') {
    return {
      reader: 'owner-scoped data-api review queue and privileged operator hygiene',
      readSurface: 'owner_scoped_review_queue',
    };
  }
  if (
    item.table === 'patient' ||
    item.table === 'dose_schedule' ||
    item.table === 'outbound_message' ||
    item.table === 'inbound_reply' ||
    item.table === 'adherence_record'
  ) {
    return {
      reader:
        'owner-scoped data-api patient/cohort/detail reads and service-owned anonymized export',
      readSurface: 'owner_scoped_data_api',
    };
  }
  if (item.table === 'turn_job' || item.table === 'usage_bucket') {
    return {
      reader: 'internal conversation worker and privileged operator diagnostics',
      readSurface: 'internal_worker_only',
    };
  }
  return {
    reader: 'future Phase 8 owner-scoped clinical repository and privileged operator hygiene',
    readSurface: 'future_phase8_owner_scoped_repository',
  };
}

export const TESTER_HYGIENE_FIELD_INVENTORY: readonly TesterHygieneFieldInventoryItem[] =
  TESTER_HYGIENE_FIELD_INVENTORY_BASE.map((item) =>
    Object.freeze({
      ...item,
      ...readerForInventoryItem(item),
    }),
  );

/**
 * Minimal dedicated-client query surface. `scrubTesterText()` owns BEGIN/COMMIT/ROLLBACK, so callers
 * must pass one checked-out `pg.Client`/`pg.PoolClient`, not a bare Pool whose queries may fan out to
 * different connections. The helper never opens credentials or releases the client.
 */
export interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/**
 * Explicit destructive-op confirmation (M6). Passing `{ confirmDestructive: true }` is the caller's
 * acknowledgement that this irreversibly deletes/redacts tester data; anything else is refused.
 */
export interface DestructiveConfirmation {
  readonly confirmDestructive: boolean;
}

export interface WipeResult {
  /** How many `is_test = true` patients were found and swept. */
  readonly testersFound: number;
  /** Rows removed from `patient` (children cascade). */
  readonly patientsDeleted: number;
  /** Total EventBridge schedules deleted across both prefixes for all testers. */
  readonly schedulesSwept: number;
}

export interface ScrubResult {
  /** `inbound_reply` rows whose `raw_body` was blanked (0 iff the id was not an is_test patient). */
  readonly repliesRedacted: number;
  /** `label_match` rows deleted for the tester. */
  readonly labelMatchesDeleted: number;
  /** `safety_events` rows whose phone-bearing `auto_reply_error` diagnostic was NULLed (row retained). */
  readonly safetyErrorsScrubbed: number;
  /** Total field-level redactions/deletes across the manifest, including Phase 8 fields when present. */
  readonly manifestFieldsScrubbed: number;
}

/**
 * Throw a loud, actionable refusal unless the caller passed `{ confirmDestructive: true }`. Called
 * BEFORE any DB or AWS reach, so a refused call writes nothing (M6).
 */
function assertConfirmed(confirmation: DestructiveConfirmation | undefined, op: string): void {
  if (confirmation?.confirmDestructive === true) return;
  throw new Error(
    `${op}: refusing to run a destructive tester-data operation without { confirmDestructive: true }. ` +
      'This irreversibly deletes/redacts is_test patient data — run ONLY at a pre-cohort reset or at ' +
      'project end, NEVER mid-cohort.',
  );
}

async function tableExists(client: Queryable, table: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 /* $table:${table} */`,
    [table],
  );
  return result.rows.length > 0;
}

async function scrubField(
  client: Queryable,
  item: TesterHygieneFieldInventoryItem,
  patientId: string,
  deletedTables: Set<string>,
): Promise<number> {
  if (item.scrubAction === 'preserve') return 0;
  if (!(await tableExists(client, item.table))) return 0;

  if (item.scrubAction === 'delete_rows') {
    if (deletedTables.has(item.table)) return 0;
    deletedTables.add(item.table);
    let dependentRowsDeleted = 0;
    if (item.table === 'patient_medication') {
      // Remove patient-owned clinical-memory roots before their same-patient event and medication
      // references. Their child scopes, candidates, transitions, sources, and evidence cascade.
      for (const dependentTable of ['clinical_review_item', 'information_need'] as const) {
        if (deletedTables.has(dependentTable)) continue;
        deletedTables.add(dependentTable);
        const deletedDependents = await client.query(
          `DELETE FROM ${dependentTable}
            USING patient p
            WHERE ${dependentTable}.patient_id = p.id
              AND p.is_test = true
              AND p.id = $1`,
          [patientId],
        );
        dependentRowsDeleted += deletedDependents.rowCount ?? 0;
      }
      if (!deletedTables.has('clinical_event')) {
        deletedTables.add('clinical_event');
        const deletedEvents = await client.query(
          `DELETE FROM clinical_event
            USING patient p
            WHERE clinical_event.patient_id = p.id
              AND p.is_test = true
              AND p.id = $1`,
          [patientId],
        );
        dependentRowsDeleted = deletedEvents.rowCount ?? 0;
      }
      await client.query(
        `UPDATE dose_schedule
            SET patient_medication_id = NULL
           FROM patient p
          WHERE dose_schedule.patient_id = p.id
            AND p.is_test = true
            AND p.id = $1
            AND dose_schedule.patient_medication_id IS NOT NULL`,
        [patientId],
      );
    }
    const deleted = await client.query(
      `DELETE FROM ${item.table}
        USING patient p
        WHERE ${item.table}.patient_id = p.id
          AND p.is_test = true
          AND p.id = $1`,
      [patientId],
    );
    return dependentRowsDeleted + (deleted.rowCount ?? 0);
  }

  if (item.table === 'outbound_message' && item.column === 'body') {
    // Detach immutable agent-turn provenance before blanking tester message text. The FK also sets
    // this column NULL when agent_turn rows are deleted later in the same transaction, but doing it
    // first satisfies the live agent-body constraint and makes the redaction order fail closed.
    await client.query(
      `UPDATE outbound_message
          SET agent_turn_id = NULL
         FROM patient p
        WHERE outbound_message.patient_id = p.id
          AND p.is_test = true
          AND p.id = $1
          AND outbound_message.agent_turn_id IS NOT NULL`,
      [patientId],
    );
  }

  const replacement = item.scrubAction === 'redact_null' ? 'NULL' : "''";
  const redacted = await client.query(
    `UPDATE ${item.table}
        SET ${item.column} = ${replacement}
       FROM patient p
      WHERE ${item.table}.patient_id = p.id
        AND p.is_test = true
        AND p.id = $1`,
    [patientId],
  );
  return redacted.rowCount ?? 0;
}

/**
 * STUDY-04 one-transaction CASCADE wipe of every `is_test = true` patient.
 *
 * M6: requires an explicit destructive-op flag (see {@link assertConfirmed}).
 * M5: enumerates the testers and sweeps the `dose-`, `reminder-`, and `timeout-` EventBridge schedule
 *     prefixes for each BEFORE the DELETE, so no orphaned one-shot fires post-wipe. A sweep failure
 *     surfaces (throws) with the DB still intact — the destructive DELETE has not run yet.
 *
 * The wipe DELETEs EXACTLY the tester ids captured by the SELECT above (`WHERE id = ANY($1::uuid[])`),
 * NOT a re-evaluated `WHERE is_test = true`: a patient enrolled BETWEEN the SELECT and the DELETE would
 * otherwise be deleted without ever having its EventBridge schedules swept (M5) — a TOCTOU orphan. A
 * lone statement is atomic in PostgreSQL, so every ON DELETE CASCADE child row is removed in the same
 * implicit transaction and any failure rolls the whole statement back.
 *
 * TRANSACTIONALITY: to run the SELECT + sweeps + DELETE as ONE atomic unit the caller MUST pass a single
 * dedicated `pg.Client` (or a checked-out `PoolClient`) wrapped in its own BEGIN/COMMIT. A bare `pg.Pool`
 * does NOT work — it may route each `.query()` to a DIFFERENT pooled connection, so a Pool-level
 * BEGIN/COMMIT would not span these statements.
 */
export async function wipeTestPatients(
  client: Queryable,
  confirmation: DestructiveConfirmation,
): Promise<WipeResult> {
  assertConfirmed(confirmation, 'wipeTestPatients');

  const found = await client.query('SELECT id FROM patient WHERE is_test = true');
  const testerIds = found.rows.map((row) => String((row as { id: unknown }).id));

  let schedulesSwept = 0;
  for (const id of testerIds) {
    schedulesSwept += await deactivateSchedules(id, 'dose');
    schedulesSwept += await deactivateSchedules(id, 'reminder');
    schedulesSwept += await deactivateSchedules(id, 'timeout');
  }

  // Delete EXACTLY the captured set (TOCTOU-safe): a patient enrolled after the SELECT is NOT in
  // testerIds, so it is left for the next wipe rather than deleted with its schedules unswept. An empty
  // array binds cleanly (`id = ANY(ARRAY[]::uuid[])` matches nothing → 0 rows).
  const deleted = await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [testerIds]);
  return {
    testersFound: testerIds.length,
    patientsDeleted: deleted.rowCount ?? 0,
    schedulesSwept,
  };
}

/**
 * DATA-01 per-tester text scrub (H7 — redact-in-place, NOT delete).
 *
 * Blanks `inbound_reply.raw_body` for one tester while KEEPING the row and all its linkage:
 * `raw_body` is NOT NULL (schema.sql) so it cannot be nulled, and deleting the row would
 * CASCADE-destroy safety_events and SET NULL adherence_record.inbound_message_id — erasing SAFETY-04
 * audit evidence. adherence_record is left entirely untouched, and the safety_events ROW is retained
 * (audit evidence) — but its `auto_reply_error` column is NULLed, because the failed/suppressed
 * auto-reply diagnostic can embed the recipient PHONE NUMBER (outbound/classifier handlers slice the
 * Twilio error message, which names the `To` number, into that column). NULLing it scrubs the last
 * free-text/PII tail while keeping the rest of the audit row (status, category, timestamps). The
 * tester's `label_match` rows (regenerable advisory ADE hints) are DELETEd rather than blanked, because
 * overwriting `matched_phrase` with '' could collide on the `label_match_replay_key`
 * UNIQUE(inbound_message_id, matched_phrase, meddra_pt).
 *
 * The `p.is_test = true` patient-JOIN is the LOAD-BEARING guard: a real (is_test = false) patient id
 * matches zero rows, so a real patient's text can NEVER be scrubbed. M6 confirmation is also required.
 *
 * TRANSACTIONALITY: this helper owns BEGIN/COMMIT/ROLLBACK because every manifest step must succeed or
 * none may persist. Pass a dedicated checked-out client; do not pass a Pool.
 */
export async function scrubTesterText(
  client: Queryable,
  patientId: string,
  confirmation: DestructiveConfirmation,
): Promise<ScrubResult> {
  assertConfirmed(confirmation, 'scrubTesterText');

  await client.query('BEGIN');
  try {
    let repliesRedacted = 0;
    let labelMatchesDeleted = 0;
    let safetyErrorsScrubbed = 0;
    let manifestFieldsScrubbed = 0;
    const deletedTables = new Set<string>();
    for (const item of TESTER_HYGIENE_FIELD_INVENTORY) {
      const count = await scrubField(client, item, patientId, deletedTables);
      manifestFieldsScrubbed += count;
      if (item.table === 'inbound_reply' && item.column === 'raw_body') repliesRedacted += count;
      if (item.table === 'label_match') labelMatchesDeleted += count;
      if (item.table === 'safety_events' && item.column === 'auto_reply_error') {
        safetyErrorsScrubbed += count;
      }
    }

    await client.query('COMMIT');
    return {
      repliesRedacted,
      labelMatchesDeleted,
      safetyErrorsScrubbed,
      manifestFieldsScrubbed,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original manifest failure; rollback failure is secondary here.
    }
    throw error;
  }
}
