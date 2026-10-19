-- =====================================================================================
-- MedAdhere — schema.sql
-- The SINGLE SOURCE OF TRUTH for the database (D-03). Full v1 schema in Phase 1 (D-02):
-- all six tables, the classifier enums, indexes, and FKs are created here — Phase 3 only
-- *uses* these tables, it does not create them.
--
-- Idempotency model (D-12): additive, guarded DDL. The whole file is re-runnable — every
-- statement is `CREATE … IF NOT EXISTS`, a guarded `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
-- or an enum-type creation wrapped in a `DO $$ … IF NOT EXISTS (pg_type) … $$` guard
-- (Postgres has no `CREATE TYPE IF NOT EXISTS`). Statement order creates enums/types BEFORE
-- the tables that reference them. There is NO migration tool and NO `schema_migrations`
-- version table (D-12). Later-phase schema changes are made by APPENDING further guarded
-- statements to THIS file.
--
-- Transaction control: this file contains PURE DDL with NO `BEGIN`/`COMMIT`/`ROLLBACK`. The
-- CDK custom-resource Lambda (Plan 03) wraps the entire file in ONE `BEGIN`/`COMMIT` and
-- `ROLLBACK`s on any failure — so the schema applies atomically.
--
-- ------------------------------------------------------------------------------------
-- !!! D-12 CONSTRAINT-IDEMPOTENCY CAVEAT (F36) — READ BEFORE APPENDING TO THIS FILE !!!
-- Postgres has NO `ALTER TABLE … ADD CONSTRAINT IF NOT EXISTS`. All Phase-1 constraints
-- below are declared INLINE at table-creation time, so re-apply under `CREATE TABLE IF NOT
-- EXISTS` is safe. Any FUTURE phase that appends an `ALTER TABLE … ADD CONSTRAINT` to this
-- file MUST wrap it in a pg_constraint existence guard, e.g.:
--
--   DO $$ BEGIN
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'my_constraint_name') THEN
--       ALTER TABLE my_table ADD CONSTRAINT my_constraint_name CHECK (...);
--     END IF;
--   END $$;
--
-- …or declare the constraint inline in a `CREATE TABLE IF NOT EXISTS`. An unguarded bare
-- `ADD CONSTRAINT` throws SQLSTATE 42710 (duplicate_object) on the second apply and breaks
-- idempotency.
-- ------------------------------------------------------------------------------------
--
-- Classifier-contract source of truth: the THREE classifier enums (adherence_state,
-- reason_code, safety_flag) mirror `packages/shared/src/adherence-schema.ts`
-- (AdherenceClassification Zod schema — same SSOT). `decided_by` is a DB-INTERNAL enum with
-- NO Zod counterpart (F35) and MUST NOT be added to adherence-schema.ts.
--   adherence_state : taken | delayed | skipped | stopped | question | unknown
--   reason_code     : none | side_effect | ran_out | forgot | other
--   safety_flag     : none | acute_physical | crisis | medical_question   (4-VALUE ENUM,
--                     NEVER a boolean — encoding it as a boolean is a blocking anti-pattern)
--   decided_by      : classifier | timeout   (DB-internal, no Zod counterpart, F35)
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. ENUM TYPES (created FIRST — before the tables that reference them, D-12).
--    Guarded with a pg_type existence check because Postgres lacks CREATE TYPE IF NOT EXISTS.
-- -------------------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adherence_state_enum') THEN
    CREATE TYPE adherence_state_enum AS ENUM
      ('taken', 'delayed', 'skipped', 'stopped', 'question', 'unknown');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reason_code_enum') THEN
    CREATE TYPE reason_code_enum AS ENUM
      ('none', 'side_effect', 'ran_out', 'forgot', 'other');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'safety_flag_enum') THEN
    CREATE TYPE safety_flag_enum AS ENUM
      ('none', 'acute_physical', 'crisis', 'medical_question');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'decided_by_enum') THEN
    CREATE TYPE decided_by_enum AS ENUM ('classifier', 'timeout');
  END IF;
END $$;

-- -------------------------------------------------------------------------------------
-- 2. TABLES (created in FK-dependency order: patient first, then its children).
--    Every child table FKs to patient with ON DELETE CASCADE (STUDY-04 one-transaction wipe).
-- -------------------------------------------------------------------------------------

-- 2.1 patient — the root table. All child tables cascade-delete from here (STUDY-04).
CREATE TABLE IF NOT EXISTS patient (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                     text        NOT NULL,
  display_name              text,
  timezone                  text        NOT NULL DEFAULT 'America/Toronto',
  medication_name           text        NOT NULL,                                  -- D-03 / PIPE-08
  is_test                   boolean     NOT NULL DEFAULT false,                     -- STUDY-04
  is_active                 boolean     NOT NULL DEFAULT true,                      -- OPS-01 / STUDY-05
  opted_out_at              timestamptz,                                           -- OPS-01 STOP self-deactivation
  drug_profile_json         jsonb,                                                 -- D-03 (populated P3 by DRUG-01)
  drug_profile_fetched_at   timestamptz,                                           -- D-03 (populated P3 by DRUG-01)
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- 2.2 dose_schedule — the per-patient scheduled doses (ROADMAP P3 SC2/SC5).
CREATE TABLE IF NOT EXISTS dose_schedule (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE, -- STUDY-04 cascade
  scheduled_at      timestamptz NOT NULL,                                          -- absolute UTC fire instant (PIPE-09)
  local_dose_time   text        NOT NULL,                                          -- e.g. '09:00' patient-local
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 2.3 outbound_message — one row per sent SMS (ROADMAP P3 SC3/SC4/SC7).
--     status is a constrained lifecycle domain: queued → sent → delivered/undelivered/failed
--     (Twilio delivery-status callback transitions — F37). Implemented as text + named inline
--     CHECK (additive-friendly for later phases; see SUMMARY for the enum-vs-CHECK rationale).
CREATE TABLE IF NOT EXISTS outbound_message (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,     -- STUDY-04 cascade
  dose_id       uuid        REFERENCES dose_schedule (id) ON DELETE CASCADE,        -- the dose this message prompts
  twilio_sid    text,                                                              -- set after Twilio send
  status        text        NOT NULL DEFAULT 'queued'
                  CONSTRAINT outbound_message_status_check
                  CHECK (status IN ('queued', 'sent', 'delivered', 'undelivered', 'failed')),
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 2.4 inbound_reply — one row per inbound SMS. dose_id is NULLABLE for unattributed
--     replies (PIPE-10). safety_flagged is set true on the divert path (04-AI-SPEC §4).
CREATE TABLE IF NOT EXISTS inbound_reply (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,   -- STUDY-04 cascade
  dose_id         uuid        REFERENCES dose_schedule (id) ON DELETE CASCADE,      -- NULLABLE — PIPE-10 unattributed
  raw_body        text        NOT NULL,
  safety_flagged  boolean     NOT NULL DEFAULT false,                              -- set on divert path (04-AI-SPEC)
  is_late         boolean     NOT NULL DEFAULT false,                              -- PIPE-06 late reply
  received_at     timestamptz NOT NULL DEFAULT now()
);

-- 2.5 adherence_record — the classifier write target (04-AI-SPEC §4 / PIPE-04 / PIPE-06).
--     UNIQUE(dose_id): one outcome per dose; the classifier upserts with
--       INSERT … ON CONFLICT (dose_id) DO UPDATE … WHERE adherence_record.decided_by = 'timeout'.
--     adherence_state + reason_code: the classifier's TWO-AXIS label (F31). reason_code defaults
--       to 'none' (most replies carry no reason).
--     safety_flag: the 4-value enum from the classification (none on the normal recorded path).
--     inbound_message_id: FK to inbound_reply. The original UNIQUE constraint is removed by the
--       Phase-8 append below so one reply can project multiple doses; a non-unique lookup index
--       retains efficient replay reads. NULLABLE because timeout rows have NO inbound reply.
--     decided_by: 'classifier' | 'timeout' (DB-internal, F35).
--     status: the dose-OUTCOME LIFECYCLE column — DISTINCT from adherence_state (F37). It carries
--       'missed' (Timeout Lambda, ROADMAP P5 SC1) and 'recorded' (a reply was classified). The
--       dashboard color-codes the per-dose timeline by THIS column (ROADMAP P6 SC2) and alerts on
--       consecutive 'missed' rows (P6 SC3). adherence_state is the classifier's label
--       (taken/delayed/skipped/…); status is the lifecycle outcome — they are NOT redundant.
--       Value set (documented, pinned to prevent P5/P6 drift): {recorded, missed}.
CREATE TABLE IF NOT EXISTS adherence_record (
  id                  uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid                  NOT NULL REFERENCES patient (id) ON DELETE CASCADE,  -- STUDY-04 cascade
  dose_id             uuid                  NOT NULL REFERENCES dose_schedule (id) ON DELETE CASCADE,
  inbound_message_id  uuid                  REFERENCES inbound_reply (id) ON DELETE SET NULL,     -- F34 replay-idempotency lookup
  adherence_state     adherence_state_enum  NOT NULL,                                            -- F31 classifier label
  reason_code         reason_code_enum      NOT NULL DEFAULT 'none',                             -- F31 classifier label
  safety_flag         safety_flag_enum      NOT NULL DEFAULT 'none',                             -- 4-value enum, never boolean
  decided_by          decided_by_enum       NOT NULL,                                            -- classifier | timeout (F35)
  status              text                  NOT NULL,                                            -- outcome lifecycle (F37)
  created_at          timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT adherence_record_dose_id_key            UNIQUE (dose_id),                            -- UNIQUE(dose_id) — PIPE-04
  CONSTRAINT adherence_record_inbound_message_id_key UNIQUE (inbound_message_id),                 -- F34
  CONSTRAINT adherence_record_status_check           CHECK (status IN ('recorded', 'missed'))     -- F37 value set: {recorded, missed}
);

-- 2.6 safety_events — the safety audit trail (04-AI-SPEC §4 db.safetyEvents.insert contract /
--     SAFETY-02 / SAFETY-04). inbound_message_id is a NOT NULL FK (every safety event is anchored
--     to its inbound reply — F32) and UNIQUE (F34). flag_category is constrained to exactly the
--     three flag values the insert ever writes — {acute_physical, crisis, medical_question} —
--     never 'none' (F32; matches db.safetyEvents.insert({ flagCategory }) whose values are exactly
--     those three). Implemented as text + named CHECK so 'none' is structurally excluded.
CREATE TABLE IF NOT EXISTS safety_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,             -- STUDY-04 cascade
  inbound_message_id  uuid        NOT NULL REFERENCES inbound_reply (id) ON DELETE CASCADE,       -- F32 NOT NULL anchor
  flag_category       text        NOT NULL,                                                      -- F32, never 'none'
  created_at          timestamptz NOT NULL DEFAULT now(),                                         -- F32
  CONSTRAINT safety_events_inbound_message_id_key UNIQUE (inbound_message_id),                    -- F34
  CONSTRAINT safety_events_flag_category_check
    CHECK (flag_category IN ('acute_physical', 'crisis', 'medical_question'))                     -- F32, never 'none'
);

-- -------------------------------------------------------------------------------------
-- 3. INDEXES (additive, IF NOT EXISTS). The inbound_message_id constraints above initially
--    create supporting btree indexes (F34); the adherence constraint is replaced by a plain
--    lookup index in the Phase-8 append. These add the other indexes Phase 3-6 rely on.
-- -------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dose_schedule_patient_id     ON dose_schedule (patient_id);
CREATE INDEX IF NOT EXISTS idx_outbound_message_patient_id  ON outbound_message (patient_id);
CREATE INDEX IF NOT EXISTS idx_outbound_message_dose_id     ON outbound_message (dose_id);
CREATE INDEX IF NOT EXISTS idx_inbound_reply_patient_id     ON inbound_reply (patient_id);
CREATE INDEX IF NOT EXISTS idx_inbound_reply_dose_id        ON inbound_reply (dose_id);
CREATE INDEX IF NOT EXISTS idx_adherence_record_patient_id  ON adherence_record (patient_id);
CREATE INDEX IF NOT EXISTS idx_adherence_record_status      ON adherence_record (status);  -- P6 color-code / consecutive-miss
CREATE INDEX IF NOT EXISTS idx_safety_events_patient_id     ON safety_events (patient_id);

-- =====================================================================================
-- PHASE 3 — ADDITIVE, GUARDED APPEND (Outbound SMS). Editing this file changes the
-- SqlHash MD5, re-running the existing schema-init custom resource on the next deploy.
-- ALL six tables already exist (Phase 1, F67-proven); this block ONLY adds columns/indexes
-- and widens ONE existing CHECK. The three new columns are INTENTIONALLY NULLABLE —
-- additive idempotency: NO `NOT NULL`, NO column default that would rewrite existing rows.
-- Every statement below is natively idempotent (`ADD COLUMN IF NOT EXISTS` /
-- `CREATE … IF NOT EXISTS`) except the status-CHECK widening, which is pg_constraint-guarded
-- per the F36 caveat in this file's header.
-- =====================================================================================

-- 4.1 dose_schedule — record the IANA tz passed to EventBridge Scheduler + the local
--     calendar date of the dose (so re-enroll/dedupe + the offset-less at() build are
--     reproducible). Both NULLABLE (additive — PIPE-09).
ALTER TABLE dose_schedule ADD COLUMN IF NOT EXISTS schedule_timezone text;   -- IANA tz passed to Scheduler
ALTER TABLE dose_schedule ADD COLUMN IF NOT EXISTS dose_date date;           -- local calendar date of the dose

-- 4.2 outbound_message — last-callback bookkeeping for the out-of-order status guard (SC7).
--     NULLABLE (additive). The SC6 response-timeout anchor needs NO new column —
--     outbound_message.sent_at already exists and is the anchor (written = now() at send time
--     by the Outbound Lambda in Plan 02), NOT dose_schedule.scheduled_at.
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;
-- Accepted-but-response-lost sends correlate their status callback through a random, single-purpose
-- token. Only its SHA-256 hash is durable; the raw token exists solely in the provider callback URL
-- and is never a database or patient identifier.
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS callback_token_hash bytea;

-- 4.3 Indexes (both natively idempotent under IF NOT EXISTS).
--   - uq_outbound_message_twilio_sid: PARTIAL unique on twilio_sid (set only AFTER send) —
--     the status-callback lookup keys on twilio_sid and there is at most one row per sid.
--   - uq_outbound_message_dose_id (HIGH-2, RETIRED 2026-08-16): the old whole-table UNIQUE on
--     dose_id is superseded by the partial uq_outbound_message_check_in_dose_id (created where
--     this one is dropped, further down). Its CREATE must NOT appear here: on a live database
--     the index is already dropped, and re-creating it fails against legitimate duplicate
--     dose_id rows (check_in + reminders share a dose) — this aborted the 2026-08-16 deploy
--     inside the schema-init custom resource (create-then-drop is a latent re-apply bomb).
--     Only the later DROP remains, as a no-op safeguard for databases that still carry it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_message_twilio_sid
  ON outbound_message (twilio_sid) WHERE twilio_sid IS NOT NULL;   -- partial unique (sid set after send)
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_message_callback_token_hash
  ON outbound_message (callback_token_hash) WHERE callback_token_hash IS NOT NULL;

-- 4.4 Widen the outbound_message.status CHECK to include 'sending' (HIGH-2 — the pre-send
--     reservation state). The Phase-1 CHECK (`outbound_message_status_check`) is declared
--     INLINE at CREATE TABLE time and so CANNOT be re-declared idempotently. Per the F36
--     caveat, re-point it under a pg_constraint guard: a `DO $$` block that DROPs the named
--     constraint if present, then ADDs the widened one. This is idempotent — on the second
--     apply it DROPs the just-added widened constraint and re-ADDs the identical definition.
--     This is the ONLY ADD CONSTRAINT this phase, and it is guarded. Do NOT append any other
--     unguarded ADD CONSTRAINT.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_message_status_check') THEN
    ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_status_check;
  END IF;
  ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_status_check
    CHECK (status IN ('prepared', 'queued', 'sending', 'sending_unknown', 'sent', 'delivered', 'undelivered', 'failed'));
END $$;

-- Referenced by Phase-8 patient-owned turn/event tables below; repeated IF NOT EXISTS in
-- the compatibility-link block remains intentional for safe cherry-pick/apply ordering.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_reply_patient_id_id
  ON inbound_reply (patient_id, id);

-- =====================================================================================
-- PHASE 4 — ADDITIVE, GUARDED APPEND (Inbound + Classifier + Safety Layer — 04-01).
-- SIX items ratified by the 2026-07-03 pre-exec gate (04-PLAN Plan 04-01; gate fixes
-- U-01/U-03/U-13/U-18 + REV-H2/H4/H5/M1). Every statement idempotent per the F36
-- caveat: ADD COLUMN IF NOT EXISTS / CREATE … IF NOT EXISTS / pg_constraint-guarded
-- ADD CONSTRAINT. All new columns NULLABLE (additive — no default rewrites existing rows).
-- =====================================================================================

-- 5.1 inbound_reply.twilio_message_sid — PIPE-03 webhook dedup. Partial unique mirrors
--     uq_outbound_message_twilio_sid: NULL on pre-Phase-4 / non-webhook rows, at most one
--     row per Twilio MessageSid otherwise. The inbound reservation INSERT dedups with
--       ON CONFLICT (twilio_message_sid) WHERE twilio_message_sid IS NOT NULL DO NOTHING
--     — the partial-index arbiter REQUIRES the predicate restated (gate fix U-03).
ALTER TABLE inbound_reply ADD COLUMN IF NOT EXISTS twilio_message_sid text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_reply_twilio_message_sid
  ON inbound_reply (twilio_message_sid) WHERE twilio_message_sid IS NOT NULL;

-- 5.2 safety_events.trigger_source — SC3 OR-semantics provenance: which detector fired
--     ('prefilter' inbound-side, 'model' classifier-side, 'both' when the model flag lands
--     on an existing prefilter row via the 04-04 upsert). NULLABLE additive (pre-Phase-4
--     rows keep NULL); net-new CHECK under the F36 pg_constraint guard.
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS trigger_source text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'safety_events_trigger_source_check') THEN
    ALTER TABLE safety_events ADD CONSTRAINT safety_events_trigger_source_check
      CHECK (trigger_source IN ('prefilter', 'model', 'both'));
  END IF;
END $$;

-- 5.3 safety_events auto-reply send-state (gate fix U-18/REV-H5): a bare UNIQUE
--     reservation has no failure state — a Twilio failure after the reservation insert
--     would suppress the safety redirect SMS forever. Lifecycle (Plans 04-02/04-04):
--     reserve 'sending' → send → 'sent' | 'failed'; replays retry ONLY 'failed' rows;
--     Twilio error 21610 (Advanced Opt-Out blocklist) → 'suppressed' for out-of-band
--     operator follow-up. All NULLABLE additive.
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS auto_reply_status text;
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS auto_reply_twilio_sid text;
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS auto_reply_sent_at timestamptz;
ALTER TABLE safety_events ADD COLUMN IF NOT EXISTS auto_reply_error text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'safety_events_auto_reply_status_check') THEN
    ALTER TABLE safety_events ADD CONSTRAINT safety_events_auto_reply_status_check
      CHECK (auto_reply_status IN ('sending', 'sent', 'failed', 'suppressed'));
  END IF;
END $$;

-- 5.4 label_match — DRUG-02 deterministic ADE annotation (net-new table; the pre-exec
--     gate's "discovered gap"). Rows are advisory hints ONLY — written strictly after
--     classification, never blocking, never SMS-touching (SC11). patient_id is
--     DENORMALIZED on the safety_events convention so the STUDY-04 one-transaction wipe
--     cascades directly; the 04-06 matcher MUST derive it from the referenced
--     inbound_reply row, never independently (app-level consistency — REV-M1).
--     Multiple matches per reply are legitimate (several mapped PTs); replay-idempotency
--     comes from the UNIQUE triple + the matcher's ON CONFLICT DO NOTHING writes
--     (REV-M1). matched_phrase is a verbatim reply fragment — enumerated in DATA-01's
--     deletion scope (gate fix U-13).
CREATE TABLE IF NOT EXISTS label_match (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_message_id  uuid        NOT NULL REFERENCES inbound_reply (id) ON DELETE CASCADE,
  patient_id          uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,      -- STUDY-04 cascade
  matched_phrase      text        NOT NULL,                                                -- verbatim fragment (DATA-01)
  meddra_pt           text        NOT NULL,                                                -- mapped MedDRA preferred term
  hint_level          text        NOT NULL
                        CONSTRAINT label_match_hint_level_check
                        CHECK (hint_level IN ('info', 'elevated')),                        -- 'elevated' iff PT in boxed_warning/warnings text
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT label_match_replay_key UNIQUE (inbound_message_id, matched_phrase, meddra_pt) -- REV-M1 replay idempotency
);
-- FK-lookup index for patient_id only: inbound_message_id lookups ride the LEFTMOST PREFIX
-- of label_match_replay_key's underlying btree, so a standalone index would be pure
-- write/storage overhead (04-01 database-review finding, 2026-07-03).
CREATE INDEX IF NOT EXISTS idx_label_match_patient_id ON label_match (patient_id);

-- 5.5 adherence_record.dose_id → NULLABLE (gate fix U-01/REV-H2): PIPE-10 unattributed
--     replies persist in the SAME write path with dose_id NULL (review queue, DASH-07 —
--     the single-write-path decision; no parallel inbound_classification table).
--     UNIQUE(dose_id) is unaffected: PG treats NULLs as non-conflicting, so unattributed
--     rows coexist; their idempotency key is UNIQUE(inbound_message_id) enforced via the
--     pre-flight existsForInboundMessage check (04-03). DROP NOT NULL is natively
--     idempotent (a no-op on an already-nullable column, not an error).
ALTER TABLE adherence_record ALTER COLUMN dose_id DROP NOT NULL;

-- 5.6 One ACTIVE patient per phone (gate fix REV-H4): Twilio hands the webhook `From`,
--     not a patient id — without this invariant, two active rows sharing a phone attach
--     classifications/STOP-deactivations/safety events to the wrong patient. Companion
--     contracts: enrollment rejects-or-deactivates prior active rows for the same phone in
--     one transaction; the inbound lookup requires exactly one active match (04-02 step 3).
--     PRE-CHECK: on a database predating this append, duplicate active phones would make
--     CREATE UNIQUE INDEX fail mid-apply with an opaque error — so fail FIRST with an
--     actionable message naming the colliding rows and the remedy.
DO $$
DECLARE dup record;
BEGIN
  SELECT phone, count(*) AS n, array_agg(id) AS ids
    INTO dup
    FROM patient
   WHERE is_active = true
   GROUP BY phone
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'uq_patient_active_phone pre-check: % active patient rows share phone % (ids: %). Deactivate the duplicates (UPDATE patient SET is_active = false WHERE id = ''<id>'') and re-apply.',
      dup.n, dup.phone, dup.ids;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_active_phone
  ON patient (phone) WHERE is_active = true;

-- 5.7 patient.owner_clinician_sub — Phase-8 doctor ownership boundary. NULL is intentional
--     for restored legacy/test rows: owner-scoped application writes compare this value to
--     the authenticated clinician sub and therefore fail closed for an ownerless row.
--     Additive + guarded so the production schema remains safe to apply repeatedly.
ALTER TABLE patient ADD COLUMN IF NOT EXISTS owner_clinician_sub text;
CREATE INDEX IF NOT EXISTS idx_patient_owner_clinician_sub
  ON patient (owner_clinician_sub);

-- 5.8 New patient rows must always carry an owner. NOT VALID deliberately preserves any
--     restored legacy NULL rows while PostgreSQL enforces the CHECK for every new/updated row.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_owner_clinician_sub_not_null'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_owner_clinician_sub_not_null
      CHECK (owner_clinician_sub IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- =====================================================================================
-- PHASE 08-05 — TEMPORAL MEMORY, CONSENT STATE, AND BOUNDED REMINDERS
-- =====================================================================================

-- Provider consent and application enablement are separate state. START may restore the
-- provider's permission, but only a doctor action may enable the application again.
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS preferred_language varchar(35) NOT NULL DEFAULT 'en';
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS reminder_limit smallint NOT NULL DEFAULT 2;
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS agent_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS provider_opted_in boolean NOT NULL DEFAULT true;
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS messaging_state_version integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_preferred_language_check'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_preferred_language_check
      CHECK (
        char_length(preferred_language) BETWEEN 2 AND 35
        AND preferred_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_reminder_limit_check'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_reminder_limit_check
      CHECK (reminder_limit BETWEEN 0 AND 5) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_messaging_state_version_check'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_messaging_state_version_check
      CHECK (messaging_state_version > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_agent_requires_provider_opt_in_check'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_agent_requires_provider_opt_in_check
      CHECK (NOT agent_enabled OR provider_opted_in) NOT VALID;
  END IF;
END $$;

-- Outbound rows are the reminder-attempt ledger; pending clarification state stays with the
-- exact question that created it. No reminder/session table is needed.
ALTER TABLE outbound_message
  ADD COLUMN IF NOT EXISTS message_kind varchar(24) NOT NULL DEFAULT 'check_in';
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS reminder_attempt smallint;
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS clarification_topic varchar(32);
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS temporal_candidates jsonb;

DROP INDEX IF EXISTS uq_outbound_message_dose_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_message_check_in_dose_id
  ON outbound_message (dose_id)
  WHERE dose_id IS NOT NULL AND message_kind = 'check_in';
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_message_reminder_attempt
  ON outbound_message (dose_id, reminder_attempt)
  WHERE dose_id IS NOT NULL AND message_kind = 'reminder';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_reminder_metadata_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_reminder_metadata_check
      CHECK (
        (message_kind = 'reminder') = (reminder_attempt IS NOT NULL)
        AND (reminder_attempt IS NULL OR reminder_attempt BETWEEN 1 AND 5)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_clarification_metadata_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_clarification_metadata_check
      CHECK (
        (message_kind = 'clarification') =
          (clarification_topic IS NOT NULL AND temporal_candidates IS NOT NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_clarification_topic_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_clarification_topic_check
      CHECK (
        clarification_topic IS NULL OR clarification_topic IN (
          'medication_identity', 'medication_taking', 'dose_time', 'dose_day',
          'dose_meridiem', 'symptom', 'severity', 'recurrence_comparison', 'frequency',
          'duration', 'sleep', 'context', 'interaction_item_identity', 'clinical_history',
          'other'
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_temporal_candidates_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_temporal_candidates_check
      CHECK (
        temporal_candidates IS NULL OR (
          jsonb_typeof(temporal_candidates) = 'array'
          AND jsonb_array_length(temporal_candidates) <= 20
          AND octet_length(temporal_candidates::text) <= 100000
        )
      ) NOT VALID;
  END IF;
END $$;

-- Cognito clinician subjects are UUID-shaped strings. Keep the column nullable for restored
-- ownerless rows, but enforce the exact trust-boundary shape for every new non-NULL owner.
-- NOT VALID preserves migration safety for legacy rows while still checking new writes.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_owner_clinician_sub_uuid_shape'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_owner_clinician_sub_uuid_shape
      CHECK (
        owner_clinician_sub IS NULL
        OR (
          char_length(owner_clinician_sub) = 36
          AND owner_clinician_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
      ) NOT VALID;
  END IF;
END $$;

-- =====================================================================================
-- PHASE 8 — ADDITIVE CONVERSATIONAL CLINICAL FOUNDATION
-- New tables remain deliberately narrow: deterministic state, immutable clinical history,
-- frozen evidence provenance, and PostgreSQL-owned resource reservations only.
-- =====================================================================================

-- Existing-table state required for atomic patient-local intake ordering and medication-bound doses.
ALTER TABLE patient ADD COLUMN IF NOT EXISTS next_inbound_sequence bigint NOT NULL DEFAULT 1;
ALTER TABLE inbound_reply ADD COLUMN IF NOT EXISTS enqueued_at timestamptz;
ALTER TABLE inbound_reply ADD COLUMN IF NOT EXISTS inbound_sequence bigint;
-- Consent cleanup retries are valid only while the original STOP remains the patient's current
-- messaging epoch. Nullable metadata leaves legacy rows unknown, so their replays fail closed.
ALTER TABLE inbound_reply ADD COLUMN IF NOT EXISTS original_control varchar(5);
ALTER TABLE inbound_reply ADD COLUMN IF NOT EXISTS control_messaging_state_version integer;
ALTER TABLE dose_schedule ADD COLUMN IF NOT EXISTS patient_medication_id uuid;
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS body varchar(320);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_next_inbound_sequence_positive'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_next_inbound_sequence_positive
      CHECK (next_inbound_sequence > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inbound_reply_inbound_sequence_positive'
       AND conrelid = 'inbound_reply'::regclass
  ) THEN
    ALTER TABLE inbound_reply ADD CONSTRAINT inbound_reply_inbound_sequence_positive
      CHECK (inbound_sequence IS NULL OR inbound_sequence > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inbound_reply_control_metadata_check'
       AND conrelid = 'inbound_reply'::regclass
  ) THEN
    ALTER TABLE inbound_reply ADD CONSTRAINT inbound_reply_control_metadata_check
      CHECK (
        ((original_control IS NULL OR original_control = 'help')
          AND control_messaging_state_version IS NULL)
        OR (original_control IS NOT NULL
          AND original_control IN ('stop', 'start')
          AND control_messaging_state_version IS NOT NULL
          AND control_messaging_state_version > 0)
      ) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_reply_patient_sequence
  ON inbound_reply (patient_id, inbound_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_reply_patient_sequence_id
  ON inbound_reply (patient_id, inbound_sequence, id);

-- Frozen source provenance and bounded reviewed evidence.
CREATE TABLE IF NOT EXISTS source_release (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name       varchar(64)   NOT NULL,
  release_version   varchar(128)  NOT NULL,
  release_date      date,
  checksum_sha256   varchar(64)   NOT NULL
                      CONSTRAINT source_release_checksum_check
                      CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  source_url        varchar(2048) NOT NULL,
  licence_id        varchar(128)  NOT NULL,
  terms_url         varchar(2048),
  state             varchar(16)   NOT NULL
                      CONSTRAINT source_release_state_check
                      CHECK (state IN ('active', 'superseded', 'withdrawn')),
  is_complete       boolean       NOT NULL DEFAULT false,
  supersedes_id     uuid,
  retrieved_at      timestamptz   NOT NULL DEFAULT now(),
  fresh_until       timestamptz   NOT NULL DEFAULT (now() + interval '30 days'),
  activated_at      timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT source_release_source_version_key UNIQUE (source_name, release_version),
  CONSTRAINT source_release_source_id_key UNIQUE (source_name, id),
  CONSTRAINT source_release_not_self_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT source_release_source_supersedes_fkey
    FOREIGN KEY (source_name, supersedes_id)
    REFERENCES source_release (source_name, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_release_one_active
  ON source_release (source_name) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS source_release_file (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source_release_id   uuid          NOT NULL REFERENCES source_release (id) ON DELETE CASCADE,
  file_name           varchar(255)  NOT NULL,
  checksum_sha256     varchar(64)   NOT NULL
                        CONSTRAINT source_release_file_checksum_check
                        CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  row_count           bigint        NOT NULL
                        CONSTRAINT source_release_file_row_count_check CHECK (row_count >= 0),
  licence_boundary    varchar(320)  NOT NULL,
  import_complete     boolean       NOT NULL DEFAULT false,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT source_release_file_release_name_key UNIQUE (source_release_id, file_name)
);

CREATE TABLE IF NOT EXISTS medication_identity_bridge (
  source_release_id       uuid         NOT NULL REFERENCES source_release (id) ON DELETE CASCADE,
  din                     varchar(8)   NOT NULL
                                       CONSTRAINT medication_identity_bridge_din_check
                                       CHECK (din ~ '^\d{8}$'),
  ccdd_product_code       varchar(64)  NOT NULL,
  ingredient_order       smallint     NOT NULL
                                       CONSTRAINT medication_identity_bridge_order_check
                                       CHECK (ingredient_order BETWEEN 1 AND 32),
  ingredient_name        varchar(320) NOT NULL,
  ccdd_ingredient_code   varchar(64)  NOT NULL,
  rxcui                   varchar(32)  NOT NULL,
  reviewed_by            varchar(128) NOT NULL,
  reviewed_at            timestamptz  NOT NULL,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT medication_identity_bridge_pkey
    PRIMARY KEY (source_release_id, din, ingredient_order),
  CONSTRAINT medication_identity_bridge_product_order_key
    UNIQUE (source_release_id, ccdd_product_code, ingredient_order)
);

CREATE TABLE IF NOT EXISTS evidence_record (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source_release_id   uuid          NOT NULL REFERENCES source_release (id) ON DELETE CASCADE,
  evidence_code       varchar(128)  NOT NULL,
  evidence_kind       varchar(32)   NOT NULL
                        CONSTRAINT evidence_record_kind_check
                        CHECK (evidence_kind IN ('label', 'medlineplus', 'monograph', 'adverse_event_index')),
  language            varchar(35)   NOT NULL,
  passage             varchar(4000) NOT NULL,
  source_url          varchar(2048) NOT NULL,
  coverage_state      varchar(32)   NOT NULL
                        CONSTRAINT evidence_record_coverage_check
                        CHECK (coverage_state IN ('direct_evidence', 'candidate_only', 'coverage_unknown')),
  tags                text[]        NOT NULL DEFAULT '{}',
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT evidence_record_tags_check CHECK (cardinality(tags) <= 32),
  CONSTRAINT evidence_record_release_code_language_key
    UNIQUE (source_release_id, evidence_code, language)
);
CREATE INDEX IF NOT EXISTS idx_evidence_record_release_kind_language
  ON evidence_record (source_release_id, evidence_kind, language);

-- Doctor-confirmed medication history and deterministic ingredient/DDInter bridges.
CREATE TABLE IF NOT EXISTS patient_medication (
  id                            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                    uuid         NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  entered_name                  varchar(320) NOT NULL,
  identity_system               varchar(16)
                                  CONSTRAINT patient_medication_identity_system_check
                                  CHECK (identity_system IN ('ccdd', 'din', 'rxnorm', 'local')),
  identity_code                 varchar(64),
  dose_text                     varchar(160),
  form                          varchar(80),
  route                         varchar(80),
  valid_from                    date         NOT NULL DEFAULT CURRENT_DATE,
  valid_to                      date,
  status                        varchar(16)  NOT NULL
                                  CONSTRAINT patient_medication_status_check
                                  CHECK (status IN ('active', 'stopped', 'corrected')),
  confirmed_by_clinician_sub    varchar(36)  NOT NULL,
  confirmed_at                  timestamptz  NOT NULL,
  supersedes_id                 uuid,
  created_at                    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT patient_medication_dates_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT patient_medication_not_self_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT patient_medication_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT patient_medication_patient_supersedes_fkey
    FOREIGN KEY (patient_id, supersedes_id)
    REFERENCES patient_medication (patient_id, id)
);
CREATE INDEX IF NOT EXISTS idx_patient_medication_patient_status
  ON patient_medication (patient_id, status, valid_from);

CREATE TABLE IF NOT EXISTS patient_medication_ingredient (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              uuid         NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  patient_medication_id   uuid         NOT NULL,
  ingredient_order        smallint     NOT NULL
                            CONSTRAINT patient_medication_ingredient_order_check
                            CHECK (ingredient_order BETWEEN 1 AND 32),
  ingredient_name         varchar(320) NOT NULL,
  ccdd_ingredient_code    varchar(64),
  rxcui                    varchar(32),
  created_at              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT patient_medication_ingredient_med_order_key
    UNIQUE (patient_medication_id, ingredient_order),
  CONSTRAINT patient_medication_ingredient_patient_medication_fkey
    FOREIGN KEY (patient_id, patient_medication_id)
    REFERENCES patient_medication (patient_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_patient_medication_ingredient_patient
  ON patient_medication_ingredient (patient_id, patient_medication_id);

CREATE TABLE IF NOT EXISTS ingredient_ddinter_map (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  source_release_id   uuid         NOT NULL REFERENCES source_release (id) ON DELETE CASCADE,
  identity_system     varchar(16)  NOT NULL
                        CONSTRAINT ingredient_ddinter_map_identity_system_check
                        CHECK (identity_system IN ('ccdd', 'rxnorm')),
  identity_code       varchar(64)  NOT NULL,
  ddinter_drug_id     varchar(64),
  mapping_status      varchar(16)  NOT NULL
                        CONSTRAINT ingredient_ddinter_map_status_check
                        CHECK (mapping_status IN ('mapped', 'ambiguous', 'unmapped')),
  reviewed_by         varchar(128) NOT NULL,
  reviewed_at         timestamptz  NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ingredient_ddinter_map_value_check
    CHECK ((mapping_status = 'mapped') = (ddinter_drug_id IS NOT NULL)),
  CONSTRAINT ingredient_ddinter_map_release_identity_key
    UNIQUE (source_release_id, identity_system, identity_code)
);

CREATE TABLE IF NOT EXISTS ddinter_drug (
  source_release_id   uuid         NOT NULL REFERENCES source_release (id) ON DELETE CASCADE,
  ddinter_drug_id     varchar(64)  NOT NULL,
  display_name        varchar(320) NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ddinter_drug_pkey PRIMARY KEY (source_release_id, ddinter_drug_id)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ingredient_ddinter_map_release_drug_fkey'
       AND conrelid = 'ingredient_ddinter_map'::regclass
  ) THEN
    ALTER TABLE ingredient_ddinter_map
      ADD CONSTRAINT ingredient_ddinter_map_release_drug_fkey
      FOREIGN KEY (source_release_id, ddinter_drug_id)
      REFERENCES ddinter_drug (source_release_id, ddinter_drug_id) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS medication_interaction (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_release_id        uuid        NOT NULL REFERENCES source_release (id) ON DELETE CASCADE,
  low_ddinter_drug_id      varchar(64) NOT NULL,
  high_ddinter_drug_id     varchar(64) NOT NULL,
  interaction_level        varchar(16) NOT NULL
                             CONSTRAINT medication_interaction_level_check
                             CHECK (interaction_level IN ('contraindicated', 'major', 'moderate', 'minor', 'unknown')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medication_interaction_canonical_pair_check
    CHECK (low_ddinter_drug_id < high_ddinter_drug_id),
  CONSTRAINT medication_interaction_release_pair_key
    UNIQUE (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id),
  CONSTRAINT medication_interaction_low_drug_fkey
    FOREIGN KEY (source_release_id, low_ddinter_drug_id)
    REFERENCES ddinter_drug (source_release_id, ddinter_drug_id) ON DELETE CASCADE,
  CONSTRAINT medication_interaction_high_drug_fkey
    FOREIGN KEY (source_release_id, high_ddinter_drug_id)
    REFERENCES ddinter_drug (source_release_id, ddinter_drug_id) ON DELETE CASCADE
);

DO $$
DECLARE existing_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO existing_definition
    FROM pg_constraint
   WHERE conname = 'dose_schedule_patient_medication_fkey'
     AND conrelid = 'dose_schedule'::regclass;

  -- Repair the earlier CASCADE action (and any other wrong delete action) without disturbing an
  -- already-correct PostgreSQL-16 partial SET NULL constraint on repeated schema applies.
  IF existing_definition IS NOT NULL
     AND position(
       'ON DELETE SET NULL (patient_medication_id)' IN existing_definition
     ) = 0 THEN
    ALTER TABLE dose_schedule DROP CONSTRAINT dose_schedule_patient_medication_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dose_schedule_patient_medication_fkey'
       AND conrelid = 'dose_schedule'::regclass
  ) THEN
    ALTER TABLE dose_schedule ADD CONSTRAINT dose_schedule_patient_medication_fkey
      FOREIGN KEY (patient_id, patient_medication_id)
      REFERENCES patient_medication (patient_id, id)
      ON DELETE SET NULL (patient_medication_id) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_dose_schedule_patient_medication
  ON dose_schedule (patient_id, patient_medication_id);

-- Append-only clinician facts and per-message work/result records.
CREATE TABLE IF NOT EXISTS clinical_fact (
  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                  uuid          NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  fact_type                   varchar(16)   NOT NULL
                                CONSTRAINT clinical_fact_type_check
                                CHECK (fact_type IN ('condition', 'allergy', 'note')),
  fact_code                   varchar(128),
  statement_text              varchar(1000) NOT NULL,
  status                      varchar(16)   NOT NULL
                                CONSTRAINT clinical_fact_status_check
                                CHECK (status IN ('current', 'corrected', 'retracted')),
  authored_by_clinician_sub   varchar(36)   NOT NULL,
  supersedes_id               uuid,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT clinical_fact_not_self_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT clinical_fact_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT clinical_fact_patient_supersedes_fkey
    FOREIGN KEY (patient_id, supersedes_id)
    REFERENCES clinical_fact (patient_id, id)
);
CREATE INDEX IF NOT EXISTS idx_clinical_fact_patient_type_created
  ON clinical_fact (patient_id, fact_type, created_at DESC);

CREATE TABLE IF NOT EXISTS turn_job (
  id                                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                          uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  inbound_message_id                  uuid        NOT NULL,
  inbound_sequence                    bigint      NOT NULL CHECK (inbound_sequence > 0),
  interpretation_attempted_at         timestamptz,
  writer_attempted_at                 timestamptz,
  interpretation_reserved_input      integer     NOT NULL DEFAULT 0 CHECK (interpretation_reserved_input >= 0),
  interpretation_reserved_output     integer     NOT NULL DEFAULT 0 CHECK (interpretation_reserved_output >= 0),
  writer_reserved_input               integer     NOT NULL DEFAULT 0 CHECK (writer_reserved_input >= 0),
  writer_reserved_output              integer     NOT NULL DEFAULT 0 CHECK (writer_reserved_output >= 0),
  completed_at                        timestamptz,
  failure_kind                        varchar(32)
                                        CONSTRAINT turn_job_failure_kind_check
                                        CHECK (failure_kind IN ('provider_error', 'malformed_output', 'budget_exhausted', 'circuit_open', 'ambiguous_outcome', 'internal_error')),
  created_at                          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_job_inbound_key UNIQUE (inbound_message_id),
  CONSTRAINT turn_job_patient_sequence_key UNIQUE (patient_id, inbound_sequence),
  CONSTRAINT turn_job_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT turn_job_patient_inbound_sequence_fkey
    FOREIGN KEY (patient_id, inbound_sequence, inbound_message_id)
    REFERENCES inbound_reply (patient_id, inbound_sequence, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_turn (
  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                  uuid          NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  inbound_message_id          uuid          NOT NULL,
  turn_job_id                 uuid          NOT NULL,
  detected_language           varchar(35),
  normalized_english_meaning  varchar(2000),
  translated_text             varchar(2000),
  model_id                    varchar(128)  NOT NULL,
  prompt_version              varchar(64)   NOT NULL,
  schema_version              varchar(64)   NOT NULL,
  context_hash                varchar(64)   NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  input_tokens                integer       NOT NULL CHECK (input_tokens >= 0),
  output_tokens               integer       NOT NULL CHECK (output_tokens >= 0),
  latency_ms                  integer       NOT NULL CHECK (latency_ms >= 0),
  final_policy_tier           varchar(16)   NOT NULL
                                CONSTRAINT agent_turn_policy_tier_check
                                CHECK (final_policy_tier IN ('routine', 'important', 'emergency', 'stop')),
  failure_class               varchar(32),
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT agent_turn_inbound_key UNIQUE (inbound_message_id),
  CONSTRAINT agent_turn_job_key UNIQUE (turn_job_id),
  CONSTRAINT agent_turn_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT agent_turn_patient_inbound_fkey
    FOREIGN KEY (patient_id, inbound_message_id)
    REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_patient_job_fkey
    FOREIGN KEY (patient_id, turn_job_id)
    REFERENCES turn_job (patient_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_turn_patient_created
  ON agent_turn (patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_event (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            uuid          NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  agent_turn_id          uuid,
  source_inbound_id     uuid,
  event_type            varchar(24)   NOT NULL
                          CONSTRAINT clinical_event_type_check
                          CHECK (event_type IN ('patient_statement', 'observation', 'adherence', 'context', 'alert')),
  event_code            varchar(128),
  statement_text        varchar(2000),
  occurred_at           timestamptz   NOT NULL,
  local_date            date          NOT NULL,
  severity              smallint      CHECK (severity BETWEEN 1 AND 10),
  supersedes_id         uuid,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT clinical_event_not_self_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT clinical_event_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT clinical_event_patient_supersedes_fkey
    FOREIGN KEY (patient_id, supersedes_id)
    REFERENCES clinical_event (patient_id, id),
  CONSTRAINT clinical_event_patient_agent_turn_fkey
    FOREIGN KEY (patient_id, agent_turn_id)
    REFERENCES agent_turn (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT clinical_event_patient_inbound_fkey
    FOREIGN KEY (patient_id, source_inbound_id)
    REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clinical_event_patient_local_occurred
  ON clinical_event (patient_id, local_date, occurred_at DESC);

CREATE TABLE IF NOT EXISTS clinical_event_evidence (
  patient_id          uuid         NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  clinical_event_id   uuid         NOT NULL,
  evidence_record_id  uuid         NOT NULL REFERENCES evidence_record (id) ON DELETE CASCADE,
  template_id         varchar(128) NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT clinical_event_evidence_pkey
    PRIMARY KEY (clinical_event_id, evidence_record_id, template_id),
  CONSTRAINT clinical_event_evidence_patient_event_fkey
    FOREIGN KEY (patient_id, clinical_event_id)
    REFERENCES clinical_event (patient_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clinical_event_evidence_patient
  ON clinical_event_evidence (patient_id, clinical_event_id);

CREATE TABLE IF NOT EXISTS daily_summary (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid          NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  local_date          date          NOT NULL,
  version             integer       NOT NULL CHECK (version > 0),
  window_start        timestamptz   NOT NULL,
  window_end          timestamptz   NOT NULL,
  input_hash          varchar(64)   NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  event_count         integer       NOT NULL CHECK (event_count >= 0),
  highest_tier        varchar(16)   NOT NULL
                        CONSTRAINT daily_summary_highest_tier_check
                        CHECK (highest_tier IN ('none', 'routine', 'important', 'emergency')),
  structured_payload  jsonb         NOT NULL DEFAULT '{}'::jsonb,
  summary_text        varchar(4000) NOT NULL,
  supersedes_id       uuid,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT daily_summary_window_check CHECK (window_end > window_start),
  CONSTRAINT daily_summary_payload_check CHECK (jsonb_typeof(structured_payload) = 'object'),
  CONSTRAINT daily_summary_payload_size_check
    CHECK (octet_length(structured_payload::text) <= 100000),
  CONSTRAINT daily_summary_not_self_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT daily_summary_patient_date_version_key UNIQUE (patient_id, local_date, version),
  CONSTRAINT daily_summary_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT daily_summary_patient_supersedes_fkey
    FOREIGN KEY (patient_id, supersedes_id)
    REFERENCES daily_summary (patient_id, id)
);

CREATE TABLE IF NOT EXISTS clinician_review_draft (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              uuid          NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  local_date              date          NOT NULL,
  version                 integer       NOT NULL CHECK (version > 0),
  input_hash              varchar(64)   NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  patient_statements      jsonb         NOT NULL DEFAULT '[]'::jsonb,
  confirmed_facts         jsonb         NOT NULL DEFAULT '[]'::jsonb,
  model_inferences        jsonb         NOT NULL DEFAULT '[]'::jsonb,
  uncertainties           jsonb         NOT NULL DEFAULT '[]'::jsonb,
  evidence_references     jsonb         NOT NULL DEFAULT '[]'::jsonb,
  proposed_corrections    jsonb         NOT NULL DEFAULT '[]'::jsonb,
  draft_text              varchar(8000) NOT NULL,
  source_agent_turn_id    uuid,
  supersedes_id           uuid,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT clinician_review_draft_arrays_check CHECK (
    jsonb_typeof(patient_statements) = 'array'
    AND jsonb_typeof(confirmed_facts) = 'array'
    AND jsonb_typeof(model_inferences) = 'array'
    AND jsonb_typeof(uncertainties) = 'array'
    AND jsonb_typeof(evidence_references) = 'array'
    AND jsonb_typeof(proposed_corrections) = 'array'
  ),
  CONSTRAINT clinician_review_draft_payload_size_check CHECK (
    octet_length(patient_statements::text) <= 100000
    AND octet_length(confirmed_facts::text) <= 100000
    AND octet_length(model_inferences::text) <= 100000
    AND octet_length(uncertainties::text) <= 100000
    AND octet_length(evidence_references::text) <= 100000
    AND octet_length(proposed_corrections::text) <= 100000
  ),
  CONSTRAINT clinician_review_draft_not_self_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT clinician_review_draft_patient_date_version_key UNIQUE (patient_id, local_date, version),
  CONSTRAINT clinician_review_draft_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT clinician_review_draft_patient_supersedes_fkey
    FOREIGN KEY (patient_id, supersedes_id)
    REFERENCES clinician_review_draft (patient_id, id),
  CONSTRAINT clinician_review_draft_patient_agent_turn_fkey
    FOREIGN KEY (patient_id, source_agent_turn_id)
    REFERENCES agent_turn (patient_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clinician_review_draft_patient_date
  ON clinician_review_draft (patient_id, local_date, version DESC);

CREATE TABLE IF NOT EXISTS clinician_review_action (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  clinician_review_draft_id uuid        NOT NULL,
  clinician_sub             varchar(36) NOT NULL,
  decision                  varchar(16) NOT NULL
                              CONSTRAINT clinician_review_action_decision_check
                              CHECK (decision IN ('confirm', 'reject')),
  expected_version          integer     NOT NULL CHECK (expected_version > 0),
  selected_correction_ids   uuid[]      NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinician_review_action_selected_check CHECK (cardinality(selected_correction_ids) <= 30),
  CONSTRAINT clinician_review_action_draft_version_key
    UNIQUE (clinician_review_draft_id, expected_version),
  CONSTRAINT clinician_review_action_patient_draft_fkey
    FOREIGN KEY (patient_id, clinician_review_draft_id)
    REFERENCES clinician_review_draft (patient_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clinician_review_action_patient_created
  ON clinician_review_action (patient_id, created_at DESC);

-- Mutable fixed-window reservations and a single-row provider breaker.
CREATE TABLE IF NOT EXISTS usage_bucket (
  bucket_scope    varchar(24)  NOT NULL
                    CONSTRAINT usage_bucket_scope_check
                    CHECK (bucket_scope IN ('source_ip', 'patient_burst', 'patient_day', 'patient_tokens')),
  subject_key     varchar(128) NOT NULL,
  patient_id      uuid         REFERENCES patient (id) ON DELETE CASCADE,
  window_start    timestamptz  NOT NULL,
  window_end      timestamptz  NOT NULL,
  limit_units     integer      NOT NULL CHECK (limit_units > 0),
  reserved_units  integer      NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  consumed_units  integer      NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT usage_bucket_pkey PRIMARY KEY (bucket_scope, subject_key, window_start),
  CONSTRAINT usage_bucket_window_check CHECK (window_end > window_start),
  CONSTRAINT usage_bucket_capacity_check CHECK (reserved_units + consumed_units <= limit_units),
  CONSTRAINT usage_bucket_patient_scope_check CHECK (
    (bucket_scope = 'source_ip' AND patient_id IS NULL)
    OR (bucket_scope <> 'source_ip' AND patient_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_usage_bucket_patient_window
  ON usage_bucket (patient_id, window_start DESC) WHERE patient_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_circuit (
  provider_key                varchar(64) PRIMARY KEY,
  state                       varchar(16) NOT NULL
                                CONSTRAINT provider_circuit_state_check
                                CHECK (state IN ('closed', 'open', 'half_open')),
  consecutive_failures        integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_failure_kind           varchar(16)
                                CONSTRAINT provider_circuit_failure_kind_check
                                CHECK (last_failure_kind IN ('auth', 'transient', 'contract')),
  failure_window_started_at    timestamptz,
  opened_at                   timestamptz,
  cooldown_until              timestamptz,
  half_open_lease_id          uuid,
  half_open_lease_expires_at  timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_circuit_half_open_lease_check CHECK (
    (state = 'half_open' AND half_open_lease_id IS NOT NULL AND half_open_lease_expires_at IS NOT NULL)
    OR (state <> 'half_open' AND half_open_lease_id IS NULL AND half_open_lease_expires_at IS NULL)
  )
);

-- One shared function backs every append-only/versioned table. Only UPDATE is blocked; patient
-- cascade DELETE remains available for the test-cohort wipe and teardown.
CREATE OR REPLACE FUNCTION reject_immutable_row_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_NARGS = 1 AND TG_ARGV[0] = 'inbound_sequence' THEN
    IF OLD.inbound_sequence IS DISTINCT FROM NEW.inbound_sequence THEN
      RAISE EXCEPTION 'inbound_sequence is immutable once stored'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'row in table % is immutable; append a revision instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE immutable_table text;
BEGIN
  FOREACH immutable_table IN ARRAY ARRAY[
    'source_release_file',
    'evidence_record',
    'medication_identity_bridge',
    'patient_medication',
    'patient_medication_ingredient',
    'ingredient_ddinter_map',
    'ddinter_drug',
    'medication_interaction',
    'clinical_fact',
    'agent_turn',
    'clinical_event',
    'clinical_event_evidence',
    'daily_summary',
    'clinician_review_draft',
    'clinician_review_action'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'reject_immutable_update'
         AND tgrelid = immutable_table::regclass
         AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER reject_immutable_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()',
        immutable_table
      );
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'reject_inbound_sequence_update'
       AND tgrelid = 'inbound_reply'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER reject_inbound_sequence_update
      BEFORE UPDATE OF inbound_sequence ON inbound_reply
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update('inbound_sequence');
  END IF;
END $$;

-- 5.9 Denormalized child relationships must agree on patient_id. The original single-column
--     FKs remain for their established delete semantics; these composite FKs close the cross-
--     patient link path. NOT VALID preserves restored legacy rows but rejects every new mismatch.
--     The referenced composite indexes are non-partial UNIQUE indexes, satisfying PostgreSQL's
--     referenced-key requirement; id is already globally unique, so creating them cannot expose
--     a data-conflict upgrade failure.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dose_schedule_patient_id_id
  ON dose_schedule (patient_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_reply_patient_id_id
  ON inbound_reply (patient_id, id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_patient_dose_fkey'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_patient_dose_fkey
      FOREIGN KEY (patient_id, dose_id)
      REFERENCES dose_schedule (patient_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inbound_reply_patient_dose_fkey'
       AND conrelid = 'inbound_reply'::regclass
  ) THEN
    ALTER TABLE inbound_reply ADD CONSTRAINT inbound_reply_patient_dose_fkey
      FOREIGN KEY (patient_id, dose_id)
      REFERENCES dose_schedule (patient_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'adherence_record_patient_dose_fkey'
       AND conrelid = 'adherence_record'::regclass
  ) THEN
    ALTER TABLE adherence_record ADD CONSTRAINT adherence_record_patient_dose_fkey
      FOREIGN KEY (patient_id, dose_id)
      REFERENCES dose_schedule (patient_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'adherence_record_patient_inbound_fkey'
       AND conrelid = 'adherence_record'::regclass
  ) THEN
    ALTER TABLE adherence_record ADD CONSTRAINT adherence_record_patient_inbound_fkey
      FOREIGN KEY (patient_id, inbound_message_id)
      REFERENCES inbound_reply (patient_id, id)
      ON DELETE SET NULL (inbound_message_id) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'safety_events_patient_inbound_fkey'
       AND conrelid = 'safety_events'::regclass
  ) THEN
    ALTER TABLE safety_events ADD CONSTRAINT safety_events_patient_inbound_fkey
      FOREIGN KEY (patient_id, inbound_message_id)
      REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- 08-04b staged-model results stay on the mutable job marker until an immutable agent_turn is
-- committed. A result can exist only after its one-way attempt marker; writer work additionally
-- requires a completed interpretation. The native byte ceilings bound retained model text.
-- The nullable intake epoch deliberately leaves pre-migration jobs unknown rather than rebasing
-- them to a later patient state. New intake writes always provide the locked patient version.
ALTER TABLE turn_job ADD COLUMN IF NOT EXISTS messaging_state_version integer;
ALTER TABLE turn_job ADD COLUMN IF NOT EXISTS interpretation_result jsonb;
ALTER TABLE turn_job ADD COLUMN IF NOT EXISTS writer_result jsonb;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_messaging_state_version_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_messaging_state_version_check
      CHECK (messaging_state_version IS NULL OR messaging_state_version > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_interpretation_result_attempt_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_interpretation_result_attempt_check
      CHECK (interpretation_result IS NULL OR interpretation_attempted_at IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_writer_result_attempt_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_writer_result_attempt_check
      CHECK (writer_result IS NULL OR writer_attempted_at IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_writer_result_dependency_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    -- Wave 1b widened this directly on the fresh-install path (a654d9a lesson): a writer
    -- (composer) result is allowed when interpretation completed OR was never attempted (a
    -- bare yes/no turn skips extraction entirely). The near-identical guarded DROP+ADD block
    -- later in this file is the LIVE-DB migration path only — it is a no-op here because this
    -- definition already contains 'interpretation_attempted_at'.
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_writer_result_dependency_check
      CHECK (
        writer_result IS NULL
        OR interpretation_result IS NOT NULL
        OR interpretation_attempted_at IS NULL
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_interpretation_result_size_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_interpretation_result_size_check
      CHECK (interpretation_result IS NULL OR octet_length(interpretation_result::text) <= 100000)
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_interpretation_result_object_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_interpretation_result_object_check
      CHECK (interpretation_result IS NULL OR jsonb_typeof(interpretation_result) = 'object')
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_writer_result_size_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_writer_result_size_check
      CHECK (writer_result IS NULL OR octet_length(writer_result::text) <= 100000) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_writer_result_object_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_writer_result_object_check
      CHECK (writer_result IS NULL OR jsonb_typeof(writer_result) = 'object') NOT VALID;
  END IF;
END $$;

-- 08-04b outbound evidence and send-once linkage. Legacy rows migrate as check-ins while new agent
-- replies carry the exact stored body plus same-patient inbound/turn provenance. The partial unique
-- index is the durable one-send reservation key for one immutable agent turn.
ALTER TABLE outbound_message
  ADD COLUMN IF NOT EXISTS message_kind varchar(24) NOT NULL DEFAULT 'check_in';
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS in_reply_to_inbound_id uuid;
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS agent_turn_id uuid;
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS language varchar(35);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_message_agent_turn_id
  ON outbound_message (agent_turn_id) WHERE agent_turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_message_in_reply_to_inbound_id
  ON outbound_message (in_reply_to_inbound_id) WHERE in_reply_to_inbound_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_kind_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_kind_check
      CHECK (message_kind IN ('check_in', 'clarification', 'acknowledgement', 'reminder', 'safety', 'fallback'))
      NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_agent_metadata_check'
       AND conrelid = 'outbound_message'::regclass
       AND pg_get_constraintdef(oid) NOT ILIKE '%btrim%'
  ) THEN
    ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_agent_metadata_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_agent_metadata_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_agent_metadata_check
      CHECK (
        agent_turn_id IS NULL
        OR (
          body IS NOT NULL
          AND char_length(btrim(body)) BETWEEN 1 AND 320
          AND in_reply_to_inbound_id IS NOT NULL
          AND language IS NOT NULL
          AND message_kind <> 'check_in'
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_patient_in_reply_fkey'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_patient_in_reply_fkey
      FOREIGN KEY (patient_id, in_reply_to_inbound_id)
      REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_patient_agent_turn_fkey'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_patient_agent_turn_fkey
      FOREIGN KEY (patient_id, agent_turn_id)
      REFERENCES agent_turn (patient_id, id) ON DELETE SET NULL (agent_turn_id) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'label_match_patient_inbound_fkey'
       AND conrelid = 'label_match'::regclass
  ) THEN
    ALTER TABLE label_match ADD CONSTRAINT label_match_patient_inbound_fkey
      FOREIGN KEY (patient_id, inbound_message_id)
      REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- A resolved observation binds to at most one exact dose/medication. Ambiguous candidate sets
-- remain on the clarification outbound until resolved instead of being guessed into history.
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS normalized_value varchar(200);
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS patient_medication_id uuid;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS dose_id uuid;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS local_time varchar(5);
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS patient_timezone varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinical_event_supersedes_id
  ON clinical_event (supersedes_id) WHERE supersedes_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_local_time_check'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_local_time_check
      CHECK (local_time IS NULL OR local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_patient_medication_fkey'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_patient_medication_fkey
      FOREIGN KEY (patient_id, patient_medication_id)
      REFERENCES patient_medication (patient_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_patient_dose_fkey'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_patient_dose_fkey
      FOREIGN KEY (patient_id, dose_id)
      REFERENCES dose_schedule (patient_id, id) NOT VALID;
  END IF;
END $$;

-- One natural-language reply can report on multiple distinct doses. Keep dose_id as the
-- current-projection uniqueness key while replacing the legacy one-row-per-inbound constraint
-- with a plain replay-lookup index. The guarded DROP and IF NOT EXISTS index are apply-twice safe.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'adherence_record_inbound_message_id_key'
       AND conrelid = 'adherence_record'::regclass
  ) THEN
    ALTER TABLE adherence_record DROP CONSTRAINT adherence_record_inbound_message_id_key;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_adherence_record_inbound_message_id
  ON adherence_record (inbound_message_id);

-- =====================================================================================
-- PHASE 8 RECOVERY — PATIENT CLINICAL MEMORY ADDITIVE STORAGE
-- Pure-core semantics stay in the reducer; persistence stores prepared command batches,
-- semantic IDs, immutable need scopes, and append-only lifecycle transitions.
-- =====================================================================================

ALTER TABLE patient ADD COLUMN IF NOT EXISTS clinical_memory_version bigint NOT NULL DEFAULT 0;
ALTER TABLE patient ADD COLUMN IF NOT EXISTS routine_clarifications_paused boolean NOT NULL DEFAULT false;

ALTER TABLE turn_job ADD COLUMN IF NOT EXISTS clinical_context_hash varchar(64);

ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS prepared_command_batch jsonb;
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS prepared_command_hash varchar(64);
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS prepared_batch_hash varchar(64);
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS prepared_command_count integer;
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS prepared_response_plan jsonb;
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS prepared_result_receipt jsonb;
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS base_clinical_memory_version bigint;
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS result_clinical_memory_version bigint;
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS clinical_context_hash varchar(64);
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS extractor_version varchar(64);
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS resolver_version varchar(64);
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS reducer_version varchar(64);
ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS renderer_version varchar(64);

ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS semantic_event_id varchar(160);
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS semantic_event_version integer;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS authored_by varchar(16);
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS review_state varchar(16);
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS clinical_operation varchar(32);
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS is_canonical_patient_report boolean;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS recurrence_of_event_id uuid;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS contradiction_of_event_id uuid;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS source_spans jsonb;
ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS clinical_values jsonb;
ALTER TABLE clinical_event ALTER COLUMN occurred_at DROP NOT NULL;
ALTER TABLE clinical_event ALTER COLUMN local_date DROP NOT NULL;

-- Lane W (2026-08-17) — why 'symptom' STAYS in this list even though nothing writes it any more.
-- The conversational core's writer now projects the semantic kind 'symptom' onto the clinical
-- record's 'patient_statement' (clinical-memory/canonical-projections.ts storedEventType), so
-- only 'administration', 'safety' and 'contradiction' are still emitted verbatim from the
-- semantic vocabulary — those three keep this widen load-bearing. 'symptom' is now legacy-only:
-- rows committed before the projection.
-- Narrowing it away is deliberately NOT done here, and the decision is now PERMANENT rather than
-- transitional: clinical_event is append-only (the reject_immutable_update trigger installed
-- above), so NO backfill can rewrite those rows — any such UPDATE raises SQLSTATE 55000. (The
-- Wave-3 cleanup script that tried was deleted for exactly this reason.) The stale spelling
-- therefore stays in the table indefinitely and is instead projected to 'patient_statement' on
-- read, at the data-api seam (data-api/patient-record.ts READ_EVENT_TYPE_SQL), so the API still
-- emits only the canonical five-value vocabulary. A CHECK is enforced on UPDATE regardless of
-- NOT VALID, which is the second reason not to narrow. If the append-only rule ever changes
-- and a narrowing is wanted, it belongs in its own guarded statement gated on
-- `SELECT count(*) = 0 FROM clinical_event WHERE event_type = 'symptom'`, so a fresh install
-- narrows while a database still holding the legacy rows is left alone.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_type_check'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event DROP CONSTRAINT clinical_event_type_check;
  END IF;
  ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_type_check CHECK (
    event_type IN (
      'patient_statement', 'observation', 'adherence', 'context', 'alert',
      'administration', 'symptom', 'safety', 'contradiction'
    )
  ) NOT VALID;
END $$;

ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS asked_information_need_id uuid;
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS messaging_consent_epoch integer;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_clinical_context_hash_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_clinical_context_hash_check
      CHECK (clinical_context_hash IS NULL OR clinical_context_hash ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_clarification_topic_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_clarification_topic_check;
  END IF;
  ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_clarification_topic_check
    CHECK (
      clarification_topic IS NULL OR clarification_topic IN (
        'medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity', 'actual_time',
        'duration', 'body_site', 'frequency', 'medication_taking', 'dose_time', 'dose_day',
        'dose_meridiem', 'symptom', 'recurrence_comparison', 'sleep', 'context',
        'interaction_item_identity', 'clinical_history', 'other'
      )
    ) NOT VALID;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS clinical_event_patient_id_id_semantic_version_key
  ON clinical_event (patient_id, id, semantic_event_version);
CREATE UNIQUE INDEX IF NOT EXISTS clinical_event_patient_physical_semantic_version_key
  ON clinical_event (patient_id, id, semantic_event_id, semantic_event_version);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_patient_id_id_semantic_version_key'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_patient_id_id_semantic_version_key
      UNIQUE USING INDEX clinical_event_patient_id_id_semantic_version_key;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS clinical_event_source (
  patient_id          uuid    NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  clinical_event_id   uuid    NOT NULL,
  source_inbound_id   uuid    NOT NULL,
  source_order        integer NOT NULL CHECK (source_order >= 0 AND source_order < 128),
  CONSTRAINT clinical_event_source_pkey PRIMARY KEY (clinical_event_id, source_order),
  CONSTRAINT clinical_event_source_event_key UNIQUE (clinical_event_id, source_inbound_id),
  CONSTRAINT clinical_event_source_patient_event_fkey
    FOREIGN KEY (patient_id, clinical_event_id)
    REFERENCES clinical_event (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT clinical_event_source_patient_inbound_fkey
    FOREIGN KEY (patient_id, source_inbound_id)
    REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS information_need (
  id                              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                      uuid         NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  semantic_need_id                varchar(160) NOT NULL,
  origin_inbound_id               uuid         NOT NULL,
  origin_inbound_sequence         bigint       NOT NULL CHECK (origin_inbound_sequence > 0),
  target_clinical_event_id        uuid,
  target_event_semantic_id        varchar(160),
  target_event_version            integer      CHECK (target_event_version > 0),
  requested_field                 varchar(32)  NOT NULL,
  question_id                     varchar(160) NOT NULL,
  priority                        integer      NOT NULL CHECK (priority >= 0 AND priority <= 1000),
  supersedes_information_need_id uuid,
  created_by_agent_turn_id        uuid         NOT NULL,
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT information_need_field_check
    CHECK (requested_field IN ('medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity', 'actual_time', 'duration', 'body_site', 'frequency')),
  CONSTRAINT information_need_target_scope_check CHECK (
    (
      requested_field = 'event_identity'
      AND target_clinical_event_id IS NULL
      AND target_event_semantic_id IS NULL
      AND target_event_version IS NULL
    ) OR (
      requested_field <> 'event_identity'
      AND target_clinical_event_id IS NOT NULL
      AND target_event_semantic_id IS NOT NULL
      AND target_event_version IS NOT NULL
    )
  ),
  CONSTRAINT information_need_patient_semantic_key UNIQUE (patient_id, semantic_need_id),
  CONSTRAINT information_need_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT information_need_patient_origin_fkey
    FOREIGN KEY (patient_id, origin_inbound_sequence, origin_inbound_id)
    REFERENCES inbound_reply (patient_id, inbound_sequence, id) ON DELETE CASCADE,
  CONSTRAINT information_need_patient_event_fkey
    FOREIGN KEY (patient_id, target_clinical_event_id, target_event_semantic_id, target_event_version)
    REFERENCES clinical_event (patient_id, id, semantic_event_id, semantic_event_version) ON DELETE CASCADE,
  CONSTRAINT information_need_patient_supersedes_fkey
    FOREIGN KEY (patient_id, supersedes_information_need_id)
    REFERENCES information_need (patient_id, id),
  CONSTRAINT information_need_patient_agent_turn_fkey
    FOREIGN KEY (patient_id, created_by_agent_turn_id)
    REFERENCES agent_turn (patient_id, id) ON DELETE CASCADE
);

-- Existing installations created every need as event-targeted. Widen the three-column target
-- tuple atomically for the targetless event-identity clarification introduced by recovery.
ALTER TABLE information_need ALTER COLUMN target_clinical_event_id DROP NOT NULL;
ALTER TABLE information_need ALTER COLUMN target_event_semantic_id DROP NOT NULL;
ALTER TABLE information_need ALTER COLUMN target_event_version DROP NOT NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'information_need_field_check'
       AND conrelid = 'information_need'::regclass
  ) THEN
    ALTER TABLE information_need DROP CONSTRAINT information_need_field_check;
  END IF;
  ALTER TABLE information_need ADD CONSTRAINT information_need_field_check
    CHECK (requested_field IN (
      'medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity',
      'actual_time', 'duration', 'body_site', 'frequency'
    )) NOT VALID;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'information_need_target_scope_check'
       AND conrelid = 'information_need'::regclass
  ) THEN
    ALTER TABLE information_need ADD CONSTRAINT information_need_target_scope_check CHECK (
      (
        requested_field = 'event_identity'
        AND target_clinical_event_id IS NULL
        AND target_event_semantic_id IS NULL
        AND target_event_version IS NULL
      ) OR (
        requested_field <> 'event_identity'
        AND target_clinical_event_id IS NOT NULL
        AND target_event_semantic_id IS NOT NULL
        AND target_event_version IS NOT NULL
      )
    ) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS information_need_scope (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  information_need_id   uuid        NOT NULL,
  scope_payload          jsonb       NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT information_need_scope_payload_check
    CHECK (
      jsonb_typeof(scope_payload) = 'object'
      AND jsonb_typeof(scope_payload -> 'candidateMedicationIds') = 'array'
      AND jsonb_array_length(scope_payload -> 'candidateMedicationIds') <= 128
      AND jsonb_typeof(scope_payload -> 'candidateDoseIds') = 'array'
      AND jsonb_array_length(scope_payload -> 'candidateDoseIds') <= 128
      AND jsonb_typeof(scope_payload -> 'candidateSymptomEventIds') = 'array'
      AND jsonb_array_length(scope_payload -> 'candidateSymptomEventIds') <= 128
      AND jsonb_typeof(scope_payload -> 'candidateHistoricalEventIds') = 'array'
      AND jsonb_array_length(scope_payload -> 'candidateHistoricalEventIds') <= 128
      AND octet_length(scope_payload::text) <= 100000
    ),
  CONSTRAINT information_need_scope_one_per_need UNIQUE (information_need_id),
  CONSTRAINT information_need_scope_patient_need_fkey
    FOREIGN KEY (patient_id, information_need_id)
    REFERENCES information_need (patient_id, id) ON DELETE CASCADE
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'information_need_scope_recovery_payload_check'
       AND conrelid = 'information_need_scope'::regclass
  ) THEN
    ALTER TABLE information_need_scope
      ADD CONSTRAINT information_need_scope_recovery_payload_check CHECK (
        scope_payload ? 'candidateHistoricalEvents'
        AND jsonb_typeof(scope_payload -> 'candidateHistoricalEvents') = 'array'
        AND jsonb_array_length(scope_payload -> 'candidateHistoricalEvents') <= 128
        AND scope_payload ? 'pendingOperation'
        AND (
          scope_payload -> 'pendingOperation' = 'null'::jsonb
          OR jsonb_typeof(scope_payload -> 'pendingOperation') = 'object'
        )
      ) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS information_need_event_candidate (
  patient_id                  uuid         NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  information_need_id         uuid         NOT NULL,
  candidate_order             integer      NOT NULL CHECK (candidate_order >= 0 AND candidate_order < 128),
  clinical_event_id           uuid         NOT NULL,
  candidate_event_semantic_id varchar(160) NOT NULL,
  candidate_event_version     integer      NOT NULL CHECK (candidate_event_version > 0),
  CONSTRAINT information_need_event_candidate_pkey
    PRIMARY KEY (information_need_id, candidate_order),
  CONSTRAINT information_need_event_candidate_unique
    UNIQUE (information_need_id, clinical_event_id, candidate_event_version),
  CONSTRAINT information_need_event_candidate_patient_need_fkey
    FOREIGN KEY (patient_id, information_need_id)
    REFERENCES information_need (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT information_need_event_candidate_patient_event_fkey
    FOREIGN KEY (
      patient_id, clinical_event_id, candidate_event_semantic_id, candidate_event_version
    ) REFERENCES clinical_event (
      patient_id, id, semantic_event_id, semantic_event_version
    )
);

CREATE TABLE IF NOT EXISTS information_need_transition (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  information_need_id   uuid        NOT NULL,
  command_semantic_id   varchar(160) NOT NULL,
  source_inbound_id     uuid        NOT NULL,
  agent_turn_id         uuid        NOT NULL,
  transition_version     integer     NOT NULL CHECK (transition_version > 0),
  from_state            varchar(32),
  to_state              varchar(32) NOT NULL,
  clarification_attempt_used boolean NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT information_need_transition_state_check
    CHECK (
      (from_state IS NULL OR from_state IN ('open', 'asked', 'resolved', 'patient_does_not_know', 'declined', 'superseded', 'expired'))
      AND to_state IN ('open', 'asked', 'resolved', 'patient_does_not_know', 'declined', 'superseded', 'expired')
      AND ((transition_version = 1 AND from_state IS NULL) OR (transition_version > 1 AND from_state IS NOT NULL))
    ),
  CONSTRAINT information_need_transition_patient_need_fkey
    FOREIGN KEY (patient_id, information_need_id)
    REFERENCES information_need (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT information_need_transition_patient_inbound_fkey
    FOREIGN KEY (patient_id, source_inbound_id)
    REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT information_need_transition_patient_agent_turn_fkey
    FOREIGN KEY (patient_id, agent_turn_id)
    REFERENCES agent_turn (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT information_need_transition_need_version_key
    UNIQUE (information_need_id, transition_version)
);

-- Wave 1a deadlock expiry: marks a transition written by the STALE-QUESTION expiry of an asked
-- need (turn-distance / overnight), never by a consumed clarification attempt. It anchors the
-- short answer-grace window on reload. Idempotent add for databases created before this wave.
ALTER TABLE information_need_transition
  ADD COLUMN IF NOT EXISTS stale_question_expiry boolean NOT NULL DEFAULT false;

-- Wave 1a batch coherence: marks an outbound reply suppressed BECAUSE a newer inbound message
-- superseded it (record-only birth or the invoke-time race backstop). status='failed' with
-- sent_at NULL alone is ambiguous — consent-stale terminalizations and definitive provider
-- rejections share it — so burst aggregation keys on this stamp, never on status alone.
ALTER TABLE outbound_message
  ADD COLUMN IF NOT EXISTS suppressed_by_newer_inbound boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS clinical_review_item (
  id                              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                      uuid         NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  semantic_review_item_id         varchar(160) NOT NULL,
  semantic_unresolved_report_id   varchar(160),
  item_kind                       varchar(32)  NOT NULL,
  source_inbound_id               uuid         NOT NULL,
  target_clinical_event_id        uuid,
  reason                          varchar(1000) NOT NULL,
  source_spans                    jsonb        NOT NULL,
  candidate_scope                 jsonb        NOT NULL,
  created_by_agent_turn_id        uuid         NOT NULL,
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT clinical_review_item_kind_check
    CHECK (item_kind IN ('unresolved_report', 'contradiction', 'safety', 'unsupported_language')),
  CONSTRAINT clinical_review_item_source_spans_check CHECK (
    jsonb_typeof(source_spans) = 'array'
    AND jsonb_array_length(source_spans) <= 128
    AND octet_length(source_spans::text) <= 100000
  ),
  CONSTRAINT clinical_review_item_candidate_scope_check CHECK (
    jsonb_typeof(candidate_scope) = 'object'
    AND jsonb_typeof(candidate_scope -> 'candidateMedicationIds') = 'array'
    AND jsonb_array_length(candidate_scope -> 'candidateMedicationIds') <= 128
    AND jsonb_typeof(candidate_scope -> 'candidateDoseIds') = 'array'
    AND jsonb_array_length(candidate_scope -> 'candidateDoseIds') <= 128
    AND jsonb_typeof(candidate_scope -> 'candidateEventIds') = 'array'
    AND jsonb_array_length(candidate_scope -> 'candidateEventIds') <= 128
    AND octet_length(candidate_scope::text) <= 100000
  ),
  CONSTRAINT clinical_review_item_patient_semantic_key UNIQUE (patient_id, semantic_review_item_id),
  CONSTRAINT clinical_review_item_unresolved_key UNIQUE (patient_id, semantic_unresolved_report_id),
  CONSTRAINT clinical_review_item_patient_id_id_key UNIQUE (patient_id, id),
  CONSTRAINT clinical_review_item_patient_inbound_fkey
    FOREIGN KEY (patient_id, source_inbound_id)
    REFERENCES inbound_reply (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT clinical_review_item_patient_event_fkey
    FOREIGN KEY (patient_id, target_clinical_event_id)
    REFERENCES clinical_event (patient_id, id),
  CONSTRAINT clinical_review_item_patient_agent_turn_fkey
    FOREIGN KEY (patient_id, created_by_agent_turn_id)
    REFERENCES agent_turn (patient_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clinical_review_item_transition (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id               uuid        NOT NULL REFERENCES patient (id) ON DELETE CASCADE,
  clinical_review_item_id  uuid        NOT NULL,
  agent_turn_id            uuid        NOT NULL,
  transition_version       integer     NOT NULL CHECK (transition_version > 0),
  from_status              varchar(16),
  to_status                varchar(16) NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinical_review_item_transition_status_check CHECK (
    (from_status IS NULL OR from_status IN ('open', 'confirmed', 'rejected'))
    AND to_status IN ('open', 'confirmed', 'rejected')
    AND ((transition_version = 1 AND from_status IS NULL) OR (transition_version > 1 AND from_status IS NOT NULL))
  ),
  CONSTRAINT clinical_review_item_transition_version_key
    UNIQUE (clinical_review_item_id, transition_version),
  CONSTRAINT clinical_review_item_transition_patient_item_fkey
    FOREIGN KEY (patient_id, clinical_review_item_id)
    REFERENCES clinical_review_item (patient_id, id) ON DELETE CASCADE,
  CONSTRAINT clinical_review_item_transition_patient_agent_turn_fkey
    FOREIGN KEY (patient_id, agent_turn_id)
    REFERENCES agent_turn (patient_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinical_event_patient_semantic_event
  ON clinical_event (patient_id, semantic_event_id) WHERE semantic_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_event_source_inbound
  ON clinical_event_source (patient_id, source_inbound_id);
CREATE INDEX IF NOT EXISTS idx_clinical_event_patient_recurrence
  ON clinical_event (patient_id, recurrence_of_event_id) WHERE recurrence_of_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_event_patient_contradiction
  ON clinical_event (patient_id, contradiction_of_event_id) WHERE contradiction_of_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_information_need_patient_priority
  ON information_need (patient_id, priority DESC, origin_inbound_sequence);
CREATE INDEX IF NOT EXISTS idx_information_need_transition_need
  ON information_need_transition (patient_id, information_need_id, transition_version);
CREATE INDEX IF NOT EXISTS idx_information_need_patient_origin
  ON information_need (patient_id, origin_inbound_sequence);
CREATE INDEX IF NOT EXISTS idx_information_need_patient_target_event
  ON information_need (patient_id, target_clinical_event_id);
CREATE INDEX IF NOT EXISTS idx_information_need_patient_supersedes
  ON information_need (patient_id, supersedes_information_need_id);
CREATE INDEX IF NOT EXISTS idx_information_need_scope_need
  ON information_need_scope (patient_id, information_need_id);
CREATE INDEX IF NOT EXISTS idx_information_need_event_candidate_need
  ON information_need_event_candidate (patient_id, information_need_id, candidate_order);
CREATE INDEX IF NOT EXISTS idx_information_need_transition_source_inbound
  ON information_need_transition (patient_id, source_inbound_id);
CREATE INDEX IF NOT EXISTS idx_clinical_review_item_source_inbound
  ON clinical_review_item (patient_id, source_inbound_id);
CREATE INDEX IF NOT EXISTS idx_clinical_review_item_transition_item
  ON clinical_review_item_transition (patient_id, clinical_review_item_id, transition_version);
CREATE INDEX IF NOT EXISTS idx_outbound_message_patient_asked_need
  ON outbound_message (patient_id, asked_information_need_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'patient_clinical_memory_version_check'
       AND conrelid = 'patient'::regclass
  ) THEN
    ALTER TABLE patient ADD CONSTRAINT patient_clinical_memory_version_check
      CHECK (clinical_memory_version >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_turn_prepared_batch_check'
       AND conrelid = 'agent_turn'::regclass
  ) THEN
    ALTER TABLE agent_turn ADD CONSTRAINT agent_turn_prepared_batch_check
      CHECK (
        prepared_command_batch IS NULL OR (
          jsonb_typeof(prepared_command_batch) = 'array'
          AND prepared_command_count IS NOT NULL
          AND prepared_command_count BETWEEN 0 AND 128
          AND jsonb_array_length(prepared_command_batch) = prepared_command_count
          AND prepared_command_hash ~ '^[0-9a-f]{64}$'
          AND prepared_batch_hash ~ '^[0-9a-f]{64}$'
          AND prepared_response_plan IS NOT NULL
          AND jsonb_typeof(prepared_response_plan) = 'object'
          AND prepared_result_receipt IS NOT NULL
          AND jsonb_typeof(prepared_result_receipt) = 'object'
          AND clinical_context_hash IS NOT NULL
          AND clinical_context_hash ~ '^[0-9a-f]{64}$'
          AND base_clinical_memory_version IS NOT NULL
          AND result_clinical_memory_version IS NOT NULL
          AND result_clinical_memory_version = base_clinical_memory_version + 1
          AND extractor_version IS NOT NULL
          AND resolver_version IS NOT NULL
          AND reducer_version IS NOT NULL
          AND renderer_version IS NOT NULL
          AND octet_length(prepared_command_batch::text) <= 100000
          AND octet_length(prepared_response_plan::text) <= 100000
          AND octet_length(prepared_result_receipt::text) <= 100000
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_recovery_metadata_check'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_recovery_metadata_check
      CHECK (
        semantic_event_id IS NULL OR (
          semantic_event_version IS NOT NULL
          AND semantic_event_version > 0
          AND authored_by IN ('patient', 'clinician')
          AND review_state IN ('unreviewed', 'confirmed', 'rejected')
          AND clinical_operation IN ('create', 'refine', 'correct', 'recur', 'contradict', 'raise_safety')
          AND is_canonical_patient_report IS NOT NULL
          AND recurrence_of_event_id IS DISTINCT FROM id
          AND contradiction_of_event_id IS DISTINCT FROM id
          AND source_spans IS NOT NULL
          AND jsonb_typeof(source_spans) = 'array'
          AND jsonb_array_length(source_spans) <= 128
          AND octet_length(source_spans::text) <= 100000
          AND clinical_values IS NOT NULL
          AND jsonb_typeof(clinical_values) = 'object'
          AND octet_length(clinical_values::text) <= 100000
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_patient_asked_need_fkey'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_patient_asked_need_fkey
      FOREIGN KEY (patient_id, asked_information_need_id)
      REFERENCES information_need (patient_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_messaging_consent_epoch_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_messaging_consent_epoch_check
      CHECK (messaging_consent_epoch IS NULL OR messaging_consent_epoch >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_patient_recurrence_fkey'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_patient_recurrence_fkey
      FOREIGN KEY (patient_id, recurrence_of_event_id)
      REFERENCES clinical_event (patient_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'clinical_event_patient_contradiction_fkey'
       AND conrelid = 'clinical_event'::regclass
  ) THEN
    ALTER TABLE clinical_event ADD CONSTRAINT clinical_event_patient_contradiction_fkey
      FOREIGN KEY (patient_id, contradiction_of_event_id)
      REFERENCES clinical_event (patient_id, id) NOT VALID;
  END IF;
END $$;

DO $$
DECLARE immutable_table text;
BEGIN
  FOREACH immutable_table IN ARRAY ARRAY[
    'clinical_event_source',
    'information_need',
    'information_need_scope',
    'information_need_event_candidate',
    'information_need_transition',
    'clinical_review_item',
    'clinical_review_item_transition'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'reject_immutable_update'
         AND tgrelid = immutable_table::regclass
         AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER reject_immutable_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()',
        immutable_table
      );
    END IF;
  END LOOP;
END $$;

-- =====================================================================================
-- WAVE 1B — COMPOSED OUTBOUND BODY (compose plumbing, Lane C)
-- The template `body` column is append-only and is NEVER overwritten: the AI-composed text
-- lives in its own nullable column with provenance, and the sender transmits
-- composed_body ?? body. The compose checkpoint is the guarded one-shot UPDATE
-- (WHERE status = 'prepared' AND composition IS NULL). ADD COLUMN IF NOT EXISTS only —
-- never a create-then-drop pattern (the a654d9a lesson).
-- =====================================================================================

ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS composed_body text;
ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS composition jsonb;

DO $$ BEGIN
  -- Wave 1b fix wave: the composed-body CHECK also enforces the never-composed invariant at
  -- the column level — only routine acknowledgements and question clarifications may EVER
  -- carry composed text ('safety'/'fallback'/scheduled kinds ship exact templates). Guarded
  -- DROP+ADD sniffed by definition; apply-twice safe on the live database.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_composed_body_check'
       AND conrelid = 'outbound_message'::regclass
       AND pg_get_constraintdef(oid) NOT ILIKE '%message_kind%'
  ) THEN
    ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_composed_body_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_composed_body_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    -- char_length counts code points; the ceiling ERRORS, it never truncates.
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_composed_body_check
      CHECK (
        composed_body IS NULL OR (
          composition IS NOT NULL
          AND agent_turn_id IS NOT NULL
          AND message_kind IN ('acknowledgement', 'clarification')
          AND composed_body = btrim(composed_body)
          AND char_length(composed_body) BETWEEN 1 AND 320
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_composition_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_composition_check
      CHECK (
        composition IS NULL OR (
          jsonb_typeof(composition) = 'object'
          AND octet_length(composition::text) <= 100000
        )
      ) NOT VALID;
  END IF;
END $$;

-- Wave 1b LIVE-DB MIGRATION PATH ONLY: the fresh-install block above (turn_job_writer_result_
-- dependency_check, near the top of this file) already creates the widened definition directly,
-- so on a fresh install the sniff below finds nothing to drop and the constraint already exists
-- (both guards are no-ops). This block exists solely to widen a database that was created before
-- the fresh-install block was updated — the writer (composer) stage may run on turns that never
-- REQUIRED interpretation (a bare yes/no turn skips extraction entirely), so the old
-- writer_result => interpretation_result dependency aborted its compose checkpoint on those
-- turns. Widen: a writer result now requires EITHER a completed interpretation OR a turn that
-- never attempted one. A turn that attempted interpretation and failed (result NULL) is a
-- runtime-failure turn — those join the never-composed set, and the CHECK still rejects a
-- writer result there. Guarded DROP+ADD sniffed by definition; apply-twice safe.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_writer_result_dependency_check'
       AND conrelid = 'turn_job'::regclass
       AND pg_get_constraintdef(oid) NOT ILIKE '%interpretation_attempted_at%'
  ) THEN
    ALTER TABLE turn_job DROP CONSTRAINT turn_job_writer_result_dependency_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'turn_job_writer_result_dependency_check'
       AND conrelid = 'turn_job'::regclass
  ) THEN
    ALTER TABLE turn_job ADD CONSTRAINT turn_job_writer_result_dependency_check
      CHECK (
        writer_result IS NULL
        OR interpretation_result IS NOT NULL
        OR interpretation_attempted_at IS NULL
      ) NOT VALID;
  END IF;
END $$;

-- Wave 1b composer control — the pre-registered abort. One singleton row carries the durable
-- auto-disable flag and a rolling fallback window; a fallback share above 30% over the window
-- (with a minimum sample) flips `disabled`, templates ship, and the identifier-free metric
-- line says so. Operators clear `disabled` manually after investigating.
CREATE TABLE IF NOT EXISTS composer_control (
  singleton         boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  disabled          boolean     NOT NULL DEFAULT false,
  disabled_reason   varchar(64),
  window_started_at timestamptz,
  compose_count     integer     NOT NULL DEFAULT 0 CHECK (compose_count >= 0),
  fallback_count    integer     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT composer_control_fallback_bounds
    CHECK (fallback_count >= 0 AND fallback_count <= compose_count)
);

-- =====================================================================================
-- WAVE 1C — LATE_INTENT NEED FIELD (Lane C)
-- A missed OR still-pending administration report opens the late_intent question ("Do you
-- plan to take it later today?"). Widen the two CHECK constraints that enumerate NeedField —
-- information_need.requested_field and outbound_message.clarification_topic (repository.ts
-- writes the raw NeedField as the clarification_topic for a clinical-memory question turn) —
-- to admit the new value. The target-scope CHECK already accepts any non-event_identity field
-- as event-targeted, so late_intent needs no change there. Guarded DROP+ADD, apply-twice safe.
-- =====================================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'information_need_field_check'
       AND conrelid = 'information_need'::regclass
  ) THEN
    ALTER TABLE information_need DROP CONSTRAINT information_need_field_check;
  END IF;
  ALTER TABLE information_need ADD CONSTRAINT information_need_field_check
    CHECK (requested_field IN (
      'medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity',
      'actual_time', 'duration', 'body_site', 'frequency', 'late_intent'
    )) NOT VALID;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_clarification_topic_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_clarification_topic_check;
  END IF;
  ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_clarification_topic_check
    CHECK (
      clarification_topic IS NULL OR clarification_topic IN (
        'medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity', 'actual_time',
        'duration', 'body_site', 'frequency', 'late_intent', 'medication_taking', 'dose_time', 'dose_day',
        'dose_meridiem', 'symptom', 'recurrence_comparison', 'sleep', 'context',
        'interaction_item_identity', 'clinical_history', 'other'
      )
    ) NOT VALID;
END $$;

-- =====================================================================================
-- WAVE 1E — SYMPTOM CONTEXT-BATTERY NEED FIELDS (Lane E)
-- The AI-led context-gathering bank adds five NEW NeedField values (onset, quality, triggers,
-- associated_symptoms, recurrence_history) — strength/duration/location REUSE the existing
-- severity/duration/body_site fields and need no schema change. Same two CHECK constraints as
-- Wave 1c, widened the same way. The target-scope CHECK already accepts any non-event_identity
-- field as event-targeted, so these need no change there either. Guarded DROP+ADD, apply-twice
-- safe.
-- =====================================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'information_need_field_check'
       AND conrelid = 'information_need'::regclass
  ) THEN
    ALTER TABLE information_need DROP CONSTRAINT information_need_field_check;
  END IF;
  ALTER TABLE information_need ADD CONSTRAINT information_need_field_check
    CHECK (requested_field IN (
      'medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity',
      'actual_time', 'duration', 'body_site', 'frequency', 'late_intent',
      'onset', 'quality', 'triggers', 'associated_symptoms', 'recurrence_history'
    )) NOT VALID;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_message_clarification_topic_check'
       AND conrelid = 'outbound_message'::regclass
  ) THEN
    ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_clarification_topic_check;
  END IF;
  ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_clarification_topic_check
    CHECK (
      clarification_topic IS NULL OR clarification_topic IN (
        'medication_identity', 'dose_identity', 'event_identity', 'symptom_identity', 'severity', 'actual_time',
        'duration', 'body_site', 'frequency', 'late_intent', 'medication_taking', 'dose_time', 'dose_day',
        'dose_meridiem', 'symptom', 'recurrence_comparison', 'sleep', 'context',
        'interaction_item_identity', 'clinical_history', 'other',
        'onset', 'quality', 'triggers', 'associated_symptoms', 'recurrence_history'
      )
    ) NOT VALID;
END $$;
