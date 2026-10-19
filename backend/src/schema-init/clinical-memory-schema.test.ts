import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const handlerSource = readFileSync(join(__dirname, 'handler.ts'), 'utf8');
const sql = schemaSql.replace(/--.*$/gmu, ' ').replace(/\s+/gu, ' ');

const APPEND_ONLY_TABLES = [
  'agent_turn',
  'clinical_event',
  'information_need',
  'information_need_scope',
  'information_need_event_candidate',
  'information_need_transition',
  'clinical_event_source',
  'clinical_review_item',
  'clinical_review_item_transition',
] as const;

const LIFECYCLE_STATES = [
  'open',
  'asked',
  'resolved',
  'patient_does_not_know',
  'declined',
  'superseded',
  'expired',
] as const;

function tableBlock(table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table}`;
  const start = sql.indexOf(marker);
  if (start < 0) return '';
  return sql.slice(start, sql.indexOf(';', start) + 1);
}

function applicationTables(privilege: 'SELECT' | 'INSERT' | 'UPDATE'): Set<string> {
  const start = handlerSource.indexOf('username: DATABASE_ROLE_USERNAMES.application');
  const end = handlerSource.indexOf('username: DATABASE_ROLE_USERNAMES.inbound', start);
  const applicationBlock = handlerSource.slice(start, end);
  const match = new RegExp(
    `privileges:\\s*\\[\\s*'${privilege}'\\s*\\],[\\s\\S]*?tables:\\s*\\[([\\s\\S]*?)\\]`,
    'u',
  ).exec(applicationBlock);
  const tables = match?.[1] ?? '';
  return new Set(
    Array.from(tables.matchAll(/'([^']+)'/gu), (entry) => {
      const table = entry[1];
      if (table === undefined) throw new Error('grant_table_parse_failed');
      return table;
    }),
  );
}

describe('Phase 8 clinical-memory static DDL contract', () => {
  it('adds the exact patient clinical clock while denying it to the inbound writer', () => {
    expect(sql).toMatch(
      /ALTER TABLE patient ADD COLUMN IF NOT EXISTS clinical_memory_version bigint NOT NULL DEFAULT 0/iu,
    );
    expect(sql).toMatch(/CHECK \(clinical_memory_version >= 0\)/iu);
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS patient_clinical_state');

    const start = handlerSource.indexOf('username: DATABASE_ROLE_USERNAMES.inbound');
    const end = handlerSource.indexOf('username: DATABASE_ROLE_USERNAMES.statusCallback', start);
    const inboundBlock = handlerSource.slice(start, end);
    const patientUpdateGrant = Array.from(inboundBlock.matchAll(/\{[^{}]+\}/gu), ([block]) =>
      block.includes("'UPDATE'") && block.includes("'patient'") ? block : '',
    ).join(' ');
    const grantedColumns = /columns:\s*\[([^\]]+)\]/u.exec(patientUpdateGrant)?.[1];

    expect(patientUpdateGrant.trim()).not.toBe('');
    expect(grantedColumns, 'inbound patient UPDATE must be column-scoped').toBeDefined();
    expect(grantedColumns).not.toContain("'clinical_memory_version'");
  });

  it('stores one immutable, bounded candidate scope for every information need', () => {
    const need = tableBlock('information_need');
    const scope = tableBlock('information_need_scope');

    expect(need).toMatch(/origin_inbound_id uuid NOT NULL/iu);
    expect(need).toMatch(/origin_inbound_sequence bigint NOT NULL/iu);
    expect(need).toMatch(/target_clinical_event_id uuid(?:\s|,)/iu);
    expect(need).toMatch(/target_event_semantic_id varchar\(160\)(?:\s|,)/iu);
    expect(need).toMatch(/target_event_version integer CHECK/iu);
    expect(need).not.toMatch(/target_clinical_event_id uuid NOT NULL/iu);
    expect(need).not.toMatch(/target_event_version integer NOT NULL/iu);
    expect(need).toMatch(/requested_field varchar\(32\) NOT NULL/iu);
    expect(sql).toMatch(/requested_field IN \([^)]*'event_identity'/iu);
    expect(sql).toMatch(
      /requested_field = 'event_identity'[^;]*target_clinical_event_id IS NULL[^;]*target_event_semantic_id IS NULL[^;]*target_event_version IS NULL/iu,
    );
    expect(need).toMatch(/question_id varchar\(160\) NOT NULL/iu);
    expect(need).toMatch(
      /FOREIGN KEY \(patient_id, origin_inbound_sequence, origin_inbound_id\) REFERENCES inbound_reply \(patient_id, inbound_sequence, id\)/iu,
    );
    expect(need).toMatch(
      /FOREIGN KEY \(patient_id, target_clinical_event_id, target_event_semantic_id, target_event_version\) REFERENCES clinical_event \(patient_id, id, semantic_event_id, semantic_event_version\)/iu,
    );

    expect(scope).toMatch(/scope_payload jsonb NOT NULL/iu);
    expect(scope).toMatch(/UNIQUE \(information_need_id\)/iu);
    expect(scope).toMatch(
      /FOREIGN KEY \(patient_id, information_need_id\) REFERENCES information_need \(patient_id, id\)/iu,
    );
    expect(scope).toMatch(/jsonb_typeof\(scope_payload\) = 'object'/iu);
    expect(scope).toMatch(/octet_length\(scope_payload::text\) <= 100000/iu);
    for (const candidateKey of [
      'candidateMedicationIds',
      'candidateDoseIds',
      'candidateSymptomEventIds',
      'candidateHistoricalEventIds',
    ]) {
      expect(scope).toContain(`'${candidateKey}'`);
      expect(scope).toMatch(
        new RegExp(`jsonb_typeof\\(scope_payload -> '${candidateKey}'\\) = 'array'`, 'iu'),
      );
    }
    expect(scope).toMatch(/jsonb_array_length\(scope_payload -> '[^']+'\) <= 128/iu);
    expect(sql).toMatch(/jsonb_typeof\(scope_payload -> 'candidateHistoricalEvents'\) = 'array'/iu);
    expect(sql).toMatch(
      /scope_payload -> 'pendingOperation' = 'null'::jsonb[^;]*jsonb_typeof\(scope_payload -> 'pendingOperation'\) = 'object'/iu,
    );

    const eventCandidates = tableBlock('information_need_event_candidate');
    expect(eventCandidates).toMatch(/candidate_order integer NOT NULL/iu);
    expect(eventCandidates).toMatch(/candidate_event_semantic_id varchar\(160\) NOT NULL/iu);
    expect(eventCandidates).toMatch(/candidate_event_version integer NOT NULL/iu);
    expect(eventCandidates).toMatch(
      /FOREIGN KEY \(patient_id, information_need_id\) REFERENCES information_need \(patient_id, id\)/iu,
    );
    expect(eventCandidates).toMatch(
      /FOREIGN KEY \(\s*patient_id, clinical_event_id, candidate_event_semantic_id, candidate_event_version\s*\) REFERENCES clinical_event \(\s*patient_id, id, semantic_event_id, semantic_event_version\s*\)/iu,
    );
    expect(need).not.toMatch(/candidate_(?:medication|dose|symptom|historical)/iu);
    expect(tableBlock('clinical_event')).not.toMatch(
      /candidate_(?:medication|dose|symptom|historical)/iu,
    );
  });

  it('records the complete information-need lifecycle as an ordered append-only log', () => {
    const need = tableBlock('information_need');
    const transitions = tableBlock('information_need_transition');

    expect(transitions).toMatch(
      /transition_version integer NOT NULL CHECK \(transition_version > 0\)/iu,
    );
    expect(transitions).toMatch(/from_state varchar\(32\)/iu);
    expect(transitions).toMatch(/to_state varchar\(32\) NOT NULL/iu);
    for (const state of LIFECYCLE_STATES) expect(transitions).toContain(`'${state}'`);
    expect(transitions).toMatch(/UNIQUE \(information_need_id, transition_version\)/iu);
    expect(transitions).toMatch(
      /FOREIGN KEY \(patient_id, information_need_id\) REFERENCES information_need \(patient_id, id\)/iu,
    );
    expect(transitions).toMatch(/clarification_attempt_used boolean NOT NULL/iu);
    expect(need).not.toMatch(/lifecycle_state/iu);
    expect(need).not.toMatch(/clarification_attempt_used/iu);
    expect(sql).not.toMatch(
      /ON information_need \([^)]*\) WHERE lifecycle_state IN \('open', 'asked'\)/iu,
    );
  });

  it('persists the complete prepared command envelope on the immutable agent turn', () => {
    for (const column of [
      'prepared_command_batch',
      'prepared_command_hash',
      'prepared_batch_hash',
      'prepared_command_count',
      'prepared_response_plan',
      'prepared_result_receipt',
      'base_clinical_memory_version',
      'result_clinical_memory_version',
      'extractor_version',
      'resolver_version',
      'reducer_version',
      'renderer_version',
    ]) {
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE agent_turn ADD COLUMN IF NOT EXISTS ${column}`, 'iu'),
      );
    }
    expect(tableBlock('agent_turn')).toMatch(/context_hash varchar\(64\) NOT NULL/iu);
    expect(sql).toMatch(/jsonb_typeof\(prepared_command_batch\) = 'array'/iu);
    expect(sql).toMatch(/jsonb_array_length\(prepared_command_batch\) = prepared_command_count/iu);
    expect(sql).toMatch(/octet_length\(prepared_command_batch::text\) <= 100000/iu);
    expect(sql).toMatch(/prepared_batch_hash ~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(sql).toMatch(/prepared_command_hash ~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(sql).toMatch(/result_clinical_memory_version = base_clinical_memory_version \+ 1/iu);
    for (const required of [
      'clinical_context_hash',
      'extractor_version',
      'resolver_version',
      'reducer_version',
      'renderer_version',
    ]) {
      expect(sql).toMatch(new RegExp(`${required} IS NOT NULL`, 'iu'));
    }
  });

  it('makes clinical-event ownership, review, operation, source, and lineage explicit', () => {
    for (const column of [
      'semantic_event_version',
      'authored_by',
      'review_state',
      'clinical_operation',
      'recurrence_of_event_id',
      'contradiction_of_event_id',
      'source_spans',
    ]) {
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE clinical_event ADD COLUMN IF NOT EXISTS ${column}`, 'iu'),
      );
    }
    expect(sql).toMatch(/authored_by IN \('patient', 'clinician'\)/iu);
    expect(sql).toMatch(/review_state IN \('unreviewed', 'confirmed', 'rejected'\)/iu);
    expect(sql).toMatch(
      /clinical_operation IN \('create', 'refine', 'correct', 'recur', 'contradict', 'raise_safety'\)/iu,
    );
    expect(sql).toMatch(/jsonb_typeof\(source_spans\) = 'array'/iu);
    expect(sql).toMatch(/source_spans IS NOT NULL/iu);
    expect(sql).toMatch(/jsonb_array_length\(source_spans\) <= 128/iu);
    expect(sql).toMatch(/octet_length\(source_spans::text\) <= 100000/iu);
    expect(sql).toMatch(/octet_length\(clinical_values::text\) <= 100000/iu);
    expect(sql).toMatch(
      /FOREIGN KEY \(patient_id, recurrence_of_event_id\) REFERENCES clinical_event \(patient_id, id\)/iu,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(patient_id, contradiction_of_event_id\) REFERENCES clinical_event \(patient_id, id\)/iu,
    );
    expect(sql).toMatch(
      /recurrence_of_event_id (?:IS DISTINCT FROM id|IS NULL OR recurrence_of_event_id <> id)/iu,
    );
    expect(sql).toMatch(
      /contradiction_of_event_id (?:IS DISTINCT FROM id|IS NULL OR contradiction_of_event_id <> id)/iu,
    );
    expect(sql).not.toMatch(/is_current_clinical_leaf/iu);
    expect(sql).toMatch(
      /event_type IN \([^)]*'administration'[^)]*'symptom'[^)]*'safety'[^)]*'contradiction'/iu,
    );
    expect(sql).toMatch(/ALTER TABLE clinical_event ALTER COLUMN occurred_at DROP NOT NULL/iu);
    expect(sql).toMatch(/ALTER TABLE clinical_event ALTER COLUMN local_date DROP NOT NULL/iu);

    const source = tableBlock('clinical_event_source');
    expect(source).toMatch(/source_order integer NOT NULL/iu);
    expect(source).toMatch(
      /FOREIGN KEY \(patient_id, clinical_event_id\) REFERENCES clinical_event \(patient_id, id\)/iu,
    );
    expect(source).toMatch(
      /FOREIGN KEY \(patient_id, source_inbound_id\) REFERENCES inbound_reply \(patient_id, id\)/iu,
    );
  });

  it('persists unresolved content, clinician review, and the routine safety pause', () => {
    expect(sql).toMatch(
      /ALTER TABLE patient ADD COLUMN IF NOT EXISTS routine_clarifications_paused boolean NOT NULL DEFAULT false/iu,
    );
    const review = tableBlock('clinical_review_item');
    const transitions = tableBlock('clinical_review_item_transition');

    expect(review).toMatch(/semantic_review_item_id varchar\(160\) NOT NULL/iu);
    expect(review).toMatch(/semantic_unresolved_report_id varchar\(160\)/iu);
    expect(review).toMatch(/source_spans jsonb NOT NULL/iu);
    expect(review).toMatch(/candidate_scope jsonb NOT NULL/iu);
    expect(review).not.toMatch(/status varchar/iu);
    expect(transitions).toMatch(/transition_version integer NOT NULL/iu);
    expect(transitions).toMatch(/to_status varchar\(16\) NOT NULL/iu);
    expect(transitions).toMatch(/UNIQUE \(clinical_review_item_id, transition_version\)/iu);
  });

  it('pins consent and the single asked need on the existing outbound outbox row', () => {
    expect(sql).toMatch(
      /ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS messaging_consent_epoch integer/iu,
    );
    expect(sql).toMatch(
      /ALTER TABLE outbound_message ADD COLUMN IF NOT EXISTS asked_information_need_id uuid/iu,
    );
    expect(sql).toMatch(/messaging_consent_epoch >= 0/iu);
    expect(sql).toMatch(
      /FOREIGN KEY \(patient_id, asked_information_need_id\) REFERENCES information_need \(patient_id, id\)/iu,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS \w+ ON outbound_message \(patient_id, asked_information_need_id\)/iu,
    );
    expect(sql).not.toContain('clinical_memory_need_semantic_id');
    expect(sql).toMatch(
      /clarification_topic IS NULL OR clarification_topic IN \([^)]*'event_identity'/iu,
    );
  });

  it('does not add a parallel outbox, aggregate JSON blob, or duplicate candidate scope', () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS \w*outbox\w*/giu) ?? []).toEqual([]);
    expect(sql).not.toMatch(/clinical_memory_(?:json|payload|blob)\s+jsonb?/iu);
    expect(sql).not.toMatch(
      /(?:clinical_event|information_need)[^;]*candidate_(?:medication|dose|symptom|historical)/iu,
    );
  });

  it('grants the application role append-only read/append but never rewrite/delete access', () => {
    const selectable = applicationTables('SELECT');
    const insertable = applicationTables('INSERT');
    const updatable = applicationTables('UPDATE');

    for (const table of APPEND_ONLY_TABLES) {
      expect(selectable).toContain(table);
      expect(insertable).toContain(table);
      expect(updatable).not.toContain(table);
    }
    expect(handlerSource).not.toMatch(/privileges:\s*\[[^\]]*'DELETE'/u);
  });

  it('attaches immutable triggers only after every new append-only table exists', () => {
    for (const table of APPEND_ONLY_TABLES) {
      const triggerEntry = sql.indexOf(`'${table}'`);

      expect(triggerEntry).toBeGreaterThan(-1);
      if (table.startsWith('information_need')) {
        expect(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`)).toBeLessThan(triggerEntry);
      }
    }
  });

  it('indexes every new relationship and bounds hashes, versions, and JSON payloads', () => {
    for (const [table, columns] of [
      ['information_need', 'patient_id, origin_inbound_sequence'],
      ['information_need', 'patient_id, target_clinical_event_id'],
      ['information_need', 'patient_id, supersedes_information_need_id'],
      ['information_need_scope', 'patient_id, information_need_id'],
      ['information_need_event_candidate', 'patient_id, information_need_id, candidate_order'],
      ['information_need_transition', 'patient_id, information_need_id, transition_version'],
      ['information_need_transition', 'patient_id, source_inbound_id'],
      ['clinical_event_source', 'patient_id, source_inbound_id'],
      ['clinical_review_item', 'patient_id, source_inbound_id'],
      [
        'clinical_review_item_transition',
        'patient_id, clinical_review_item_id, transition_version',
      ],
      ['clinical_event', 'patient_id, recurrence_of_event_id'],
      ['clinical_event', 'patient_id, contradiction_of_event_id'],
      ['outbound_message', 'patient_id, asked_information_need_id'],
    ] as const) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \\w+ ON ${table} \\(${columns}[^)]*\\)`,
          'iu',
        ),
      );
    }
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON clinical_event \(patient_id, id, semantic_event_version\)/iu,
    );
    expect(sql).toMatch(/prepared_command_count BETWEEN 0 AND 128/iu);
    expect(sql).toMatch(/prepared_batch_hash ~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(sql).toMatch(/context_hash ~ '\^\[0-9a-f\]\{64\}\$'/iu);
    expect(sql).toMatch(/octet_length\(scope_payload::text\) <= 100000/iu);
    expect(sql).toMatch(/octet_length\(source_spans::text\) <= 100000/iu);
  });
});
