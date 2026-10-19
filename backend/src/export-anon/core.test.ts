// core.test.ts — the DASH-06 `export-anon` DI-core unit contract (D6/D7/D14).
//
// Pure, node-env, no AWS, no DB, no network. Drives the injected-query-client + injected-S3-putter
// core with fakes. Proves:
//   - D7 the EMITTED column set is EXACTLY the allowlist (set-equality — U-14, not a denylist), and
//     the forbidden PII/absolute-timestamp columns can never leak even if a query row carries them
//     (the CSV projects strictly onto the allowlist);
//   - RFC-4180 CSV: header row, CRLF records, comma/quote/newline quoting, boolean/null formatting;
//   - D14 polarity: the default (excludeTest=false) INCLUDES the is_test cohort — the SQL param is
//     false — and a 0-row result is a LOUD FAILURE (EmptyExportError), never a silent empty CSV;
//   - the completion metric is id-only (no phone/body/row values).

import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWLIST_COLUMNS,
  EXPORT_ANON_SQL,
  EmptyExportError,
  runExportAnon,
  toCsv,
  type ExportPutter,
  type QueryClient,
} from './core.js';

// The columns that must NEVER appear in the anonymized artifact (D7 "Excluded by construction").
const FORBIDDEN_COLUMNS = [
  'phone',
  'display_name',
  'raw_body',
  'auto_reply_error',
  'matched_phrase',
  'meddra_pt',
  'twilio_sid',
  'twilio_message_sid',
  'drug_profile_json',
  'medication_name',
  'timezone',
  'received_at',
  'sent_at',
  'scheduled_at',
  'created_at',
  'dose_date',
  'patient_id',
  'inbound_message_id',
  'dose_id',
  'id',
];

/** A fake query client that returns a fixed row set and records the SQL + params it was called with. */
function fakeClient(rows: Record<string, unknown>[]): QueryClient & {
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows };
    },
  };
}

/** A fake S3 putter that records the CSV it was handed. */
function fakePutter(destination = 's3://bucket/exports/x.csv'): ExportPutter & {
  puts: string[];
} {
  const puts: string[] = [];
  return {
    puts,
    async put(csv: string) {
      puts.push(csv);
      return { destination };
    },
  };
}

/** One well-formed export row (all allowlist keys present) plus deliberately-injected PII keys. */
function rowWithPii(): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of ALLOWLIST_COLUMNS) row[c] = c === 'is_test' ? true : `v_${c}`;
  // Inject forbidden columns a careless SELECT * would carry — the CSV must drop every one.
  row.phone = '+15005550006';
  row.raw_body = 'I felt dizzy after my dose';
  row.medication_name = 'metformin';
  row.received_at = '2026-08-24T13:00:00Z';
  return row;
}

describe('export-anon core — D7 column allowlist (set-equality, not a denylist)', () => {
  it('pins EXACTLY 14 columns and none of the forbidden PII/timestamp columns', () => {
    expect(ALLOWLIST_COLUMNS).toHaveLength(14);
    // Set-equality anchor: the D7 semantic set, verbatim.
    expect(new Set(ALLOWLIST_COLUMNS)).toEqual(
      new Set([
        'patient_pseudonym',
        'is_test',
        'adherence_state',
        'reason_code',
        'safety_flag',
        'decided_by',
        'dose_status',
        'is_late',
        'is_unattributed',
        'study_day',
        'local_dose_time',
        'dose_weekday',
        'outbound_status',
        'response_latency_seconds',
      ]),
    );
    for (const forbidden of FORBIDDEN_COLUMNS) {
      expect(ALLOWLIST_COLUMNS).not.toContain(forbidden);
    }
  });

  it('the pinned SELECT never names medication_name, timezone, phone, or an absolute timestamp column', () => {
    // The exported SQL is the SSOT the real-PG contract test drives; guard the obvious PII leaks here
    // too (a fast, DB-less regression tripwire) — the anonymized artifact is pseudonymized (D7/U-29).
    for (const banned of ['medication_name', 'p.phone', 'display_name', 'raw_body', 'drug_profile_json', 'p.timezone']) {
      expect(EXPORT_ANON_SQL).not.toContain(banned);
    }
    // It anchors on adherence_record (U-25) and joins inbound_reply on the OUTCOME reply (no dose fan-out).
    expect(EXPORT_ANON_SQL).toContain('FROM adherence_record');
    expect(EXPORT_ANON_SQL).toContain('ar.inbound_message_id');
  });
});

describe('export-anon core — RFC-4180 CSV projection', () => {
  it('emits a header row of exactly the allowlist and drops every non-allowlist (PII) key', () => {
    const csv = toCsv([rowWithPii()]);
    const lines = csv.split('\r\n');
    const header = lines[0]!;
    expect(header).toBe(ALLOWLIST_COLUMNS.join(','));
    // set-equality of the emitted header vs the allowlist.
    expect(new Set(header.split(','))).toEqual(new Set(ALLOWLIST_COLUMNS));
    // The injected PII values are nowhere in the serialized artifact.
    expect(csv).not.toContain('+15005550006');
    expect(csv).not.toContain('dizzy');
    expect(csv).not.toContain('metformin');
    expect(csv).not.toContain('2026-08-24T13:00:00Z');
    // A data record exists and has exactly 14 comma-separated fields.
    expect(lines[1]!.split(',')).toHaveLength(14);
  });

  it('quotes fields containing comma / quote / newline (RFC-4180), doubles embedded quotes, formats bool + null', () => {
    const row: Record<string, unknown> = {};
    for (const c of ALLOWLIST_COLUMNS) row[c] = null;
    row.patient_pseudonym = 'patient_1';
    row.is_test = false;
    row.local_dose_time = 'a,b';
    row.reason_code = 'she said "ran out"';
    row.adherence_state = 'line1\nline2';
    row.study_day = 0;
    const csv = toCsv([row]);
    const record = csv.split('\r\n')[1]!;
    expect(csv.endsWith('\r\n')).toBe(true); // CRLF-terminated records
    expect(record).toContain('"a,b"'); // comma → quoted
    expect(record).toContain('"she said ""ran out"""'); // embedded quote doubled
    expect(record).toContain('"line1\nline2"'); // newline → quoted
    expect(record).toContain('false'); // boolean literal
    expect(record).toContain('patient_1');
    // A null field renders as an empty field (two adjacent commas somewhere), never the string "null".
    expect(csv).not.toContain('null');
  });
});

describe('export-anon core — D14 polarity + 0-row loud-fail', () => {
  it('DEFAULT excludeTest=false passes SQL param [false] — the is_test cohort is INCLUDED', async () => {
    const client = fakeClient([rowWithPii()]);
    const putter = fakePutter();
    await runExportAnon({ client, putter, options: { excludeTest: false } });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.text).toBe(EXPORT_ANON_SQL);
    expect(client.calls[0]!.params).toEqual([false]); // include test rows (D14 — the cohort IS is_test=true)
  });

  it('--exclude-test inverts to SQL param [true] (the rare dev-noise run)', async () => {
    const client = fakeClient([rowWithPii()]);
    await runExportAnon({ client, putter: fakePutter(), options: { excludeTest: true } });
    expect(client.calls[0]!.params).toEqual([true]);
  });

  it('a 0-row result throws EmptyExportError and NEVER writes an (empty) object', async () => {
    const client = fakeClient([]);
    const putter = fakePutter();
    await expect(
      runExportAnon({ client, putter, options: { excludeTest: false } }),
    ).rejects.toBeInstanceOf(EmptyExportError);
    expect(putter.puts).toHaveLength(0); // no silent empty CSV
  });
});

describe('export-anon core — happy path + id-only metric', () => {
  it('hands the projected CSV to the putter and returns rowCount + destination + allowlist columns', async () => {
    const client = fakeClient([rowWithPii(), rowWithPii()]);
    const putter = fakePutter('s3://medadhere-export/exports/adherence-anon-20260824.csv');
    const result = await runExportAnon({ client, putter, options: { excludeTest: false } });
    expect(result.rowCount).toBe(2);
    expect(result.destination).toBe('s3://medadhere-export/exports/adherence-anon-20260824.csv');
    expect(new Set(result.columns)).toEqual(new Set(ALLOWLIST_COLUMNS));
    expect(putter.puts).toHaveLength(1);
    expect(putter.puts[0]!.split('\r\n')[0]).toBe(ALLOWLIST_COLUMNS.join(','));
  });

  it('emits an id-only completion metric — no phone / body / row values (PII-safe logMetric)', async () => {
    const client = fakeClient([rowWithPii()]);
    const logMetric = vi.fn();
    await runExportAnon({ client, putter: fakePutter(), options: { excludeTest: false }, logMetric });
    expect(logMetric).toHaveBeenCalled();
    const serialized = JSON.stringify(logMetric.mock.calls);
    expect(serialized).not.toContain('+15005550006');
    expect(serialized).not.toContain('dizzy');
    expect(serialized).not.toContain('metformin');
    // The metric carries counts/flags only.
    const entry = logMetric.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(entry.rowCount).toBe(1);
    expect(entry.excludeTest).toBe(false);
  });
});
