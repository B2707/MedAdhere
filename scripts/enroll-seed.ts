// scripts/enroll-seed.ts
//
// The SC4 seed/invoke path — a ONE-TIME, PRIVILEGED OFFLINE operator script that direct-invokes the
// deployed Enroll Lambda to enroll a developer-owned phone with ONE dose ~2 minutes in the future, for
// the live end-to-end SMS smoke (enroll → schedule → fire → send). This requires operator AWS IAM
// permission to invoke Enroll directly. It is NEVER a clinician/browser path, NOT a dashboard form
// (that is Phase 6, DASH-05), and NOT a Lambda — it is an offline operator script (tsx-runnable, like
// scripts/freeze-drug-profiles.ts).
//
// It builds the Enroll payload (a configurable day horizon, with a single localTime ~2 min out in the
// developer's timezone) and invokes the deployed Enroll function by NAME via the AWS CLI
// (`aws lambda invoke`) using the operator's ambient AWS credentials/region. The AWS CLI is already the
// operator's tool for the deploy/secret-population steps in the Task-3 runbook, so this adds NO new npm
// dependency (the @aws-sdk/client-lambda SDK is intentionally not a project dep).
//
// Usage (after `cdk deploy`): discover the exact Enroll Lambda name and copy --owner-sub from the
// verified Cognito user with scripts/ops-runbook-06.md §3, then run:
//   npx tsx scripts/enroll-seed.ts --fn "$FN" --owner-sub "$CLINICIAN_SUB" \
//     --phone +15145550123 --med Metformin \
//     [--tz America/Toronto] [--in-min 2 | --at 08:00,14:00,20:00] [--days 1]
//     [--is-test|--no-test]
//
// Without --at, the dose fires ~--in-min minutes out (default 2). With --at, every chosen local
// wall-clock time is scheduled on each day in the horizon. The script PRINTS the computed payload +
// the Lambda response so the operator can confirm the patientId/doseCount before watching the handset.
//
// Module mode: CommonJS-compatible (no `import.meta`); tsx/NodeNext resolve the deps natively.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DateTime, IANAZone } from 'luxon';

/** The Enroll Lambda payload shape (mirrors EnrollEvent in backend/src/enroll/handler.ts). */
export interface EnrollSeedPayload {
  owner_clinician_sub: string;
  phone: string;
  medication_name: string;
  display_name?: string;
  timezone: string;
  startDate: string;
  days: number;
  localTimes: string[];
  /** D14 — mark this as a removable test/dev row. Seed default is true because there are no real patients. */
  is_test: boolean;
}

export interface SeedArgs {
  /** Verified Cognito clinician subject that owns the seeded patient. */
  ownerSub: string;
  /** Developer-owned recipient phone in E.164. */
  phone: string;
  /** The medication name (PIPE-08). */
  med: string;
  /** IANA timezone (default America/Toronto). */
  tz?: string;
  /** Minutes from now the single dose should fire (default 2). */
  inMin?: number;
  /** Explicit patient-local dose times; mutually exclusive with inMin. */
  at?: readonly string[];
  /** Number of consecutive local days to schedule (default 1; maximum 14). */
  days?: number;
  /** Optional display name. */
  name?: string;
  /**
   * D14 — set the patient's is_test flag. Defaults true because this project has no real patients and
   * every normal seed row must be removable by the pre-cohort wipe. `--no-test` is the explicit opt-out.
   */
  isTest?: boolean;
}

export const MAX_ENROLL_DAYS = 14;
/** Keep this bounded to the Enroll API's existing MAX_LOCAL_TIMES contract. */
export const MAX_LOCAL_TIMES = 4;
/** A relative seed must remain within one day of the operator invocation. */
export const MAX_IN_MINUTES = 1440;
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateLocalTimes(localTimes: readonly string[]): string[] {
  if (localTimes.length < 1 || localTimes.length > MAX_LOCAL_TIMES) {
    throw new Error(
      `enroll-seed: --at must contain from 1 to ${MAX_LOCAL_TIMES} comma-separated times`,
    );
  }
  const invalid = localTimes.find((localTime) => !HHMM_PATTERN.test(localTime));
  if (invalid !== undefined) {
    throw new Error(
      `enroll-seed: --at time "${invalid}" must use 24-hour HH:MM (00:00 through 23:59)`,
    );
  }
  const duplicate = localTimes.find((localTime, index) => localTimes.indexOf(localTime) !== index);
  if (duplicate !== undefined) {
    throw new Error(`enroll-seed: duplicate --at time "${duplicate}"`);
  }
  return [...localTimes];
}

/**
 * Build the Enroll payload. By default, one local dose time `inMin` minutes from now is repeated
 * across the requested day horizon. With explicit `at` times, those patient-local wall-clock times
 * replace the relative default on every day, starting on the current local date. The Enroll handler
 * turns the date/time pairs into offset-less at() expressions + tz. Pure (clock injected).
 */
export function buildSeedPayload(args: SeedArgs, now: DateTime): EnrollSeedPayload {
  if (!UUID_PATTERN.test(args.ownerSub)) {
    throw new Error('enroll-seed: --owner-sub must be a UUID');
  }
  const tz = args.tz ?? 'America/Toronto';
  const days = args.days ?? 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_ENROLL_DAYS) {
    throw new Error(`enroll-seed: --days must be an integer from 1 to ${MAX_ENROLL_DAYS}`);
  }
  if (args.at !== undefined && args.inMin !== undefined) {
    throw new Error('enroll-seed: --at and --in-min are mutually exclusive');
  }
  if (
    args.inMin !== undefined &&
    (!Number.isInteger(args.inMin) || args.inMin < 1 || args.inMin > MAX_IN_MINUTES)
  ) {
    throw new Error(`enroll-seed: --in-min must be an integer from 1 to ${MAX_IN_MINUTES}`);
  }
  const nowLocal = now.setZone(tz);
  const explicitLocalTimes = args.at === undefined ? undefined : validateLocalTimes(args.at);
  const everyExplicitTimeIsFuture =
    explicitLocalTimes?.every((localTime) => localTime > nowLocal.toFormat('HH:mm')) ?? false;
  const fireLocal =
    explicitLocalTimes === undefined
      ? nowLocal.plus({ minutes: args.inMin ?? 2 })
      : everyExplicitTimeIsFuture
        ? nowLocal
        : nowLocal.plus({ days: 1 });
  const startDate = fireLocal.toISODate();
  if (startDate === null) {
    throw new Error(`enroll-seed: could not compute a local fire date in zone ${tz}`);
  }
  const localTimes = explicitLocalTimes ?? [fireLocal.toFormat('HH:mm')];
  return {
    owner_clinician_sub: args.ownerSub,
    phone: args.phone,
    medication_name: args.med,
    display_name: args.name,
    timezone: tz,
    startDate,
    days,
    localTimes,
    // D14 — all normal seeds are removable dev/test noise; --no-test is the explicit escape hatch.
    is_test: args.isTest ?? true,
  };
}

/** Parse a `--flag value` option from argv; reject a missing or next-flag value loudly. */
export function argValue(flag: string, argv: readonly string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`enroll-seed: ${flag} requires a value`);
  }
  return value;
}

/** The seed options whose CLI precedence/validation must stay unit-testable without spawning AWS. */
export interface SeedCliOptions {
  readonly isTest: boolean | undefined;
  readonly timezone: string;
  readonly days: number;
  readonly inMin: number | undefined;
  readonly at: readonly string[] | undefined;
}

/** Parse the bounded day horizon, dose-time mode, and symmetrical is_test flags from argv. */
export function parseSeedCliOptions(argv: readonly string[]): SeedCliOptions {
  const rawAt = argValue('--at', argv);
  const rawInMin = argValue('--in-min', argv);
  const at =
    rawAt === undefined
      ? undefined
      : validateLocalTimes(rawAt.split(',').map((localTime) => localTime.trim()));
  const inMin = rawInMin === undefined ? (at === undefined ? 2 : undefined) : Number(rawInMin);

  const rawDays = argValue('--days', argv);
  const days = Number(rawDays ?? '1');

  const timezone = argValue('--tz', argv) ?? 'America/Toronto';
  if (!IANAZone.isValidZone(timezone)) {
    throw new Error('enroll-seed: --tz must be a valid IANA timezone');
  }

  // Explicit opt-out wins if a malformed invocation supplies both flags.
  const isTest = argv.includes('--no-test') ? false : argv.includes('--is-test') ? true : undefined;
  return { isTest, timezone, days, inMin, at };
}

export interface EnrollSeedCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable I/O boundaries for the operator CLI; tests never touch AWS or the real filesystem. */
export interface EnrollSeedCliDeps {
  readonly now: () => DateTime;
  readonly tempDirectory: string;
  readonly makeTempDir: (prefix: string) => string;
  readonly writeFile: (path: string, data: string, encoding: 'utf8') => void;
  readonly readFile: (path: string, encoding: 'utf8') => string;
  readonly removeDirectory: (path: string, options: { recursive: true; force: true }) => void;
  readonly invokeAws: (args: readonly string[]) => EnrollSeedCommandResult;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

class EnrollSeedCliError extends Error {}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new EnrollSeedCliError(`[seed] invalid ${label} JSON${detail}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnrollSeedCliError(`[seed] invalid ${label}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validateEnrollResponse(
  response: Record<string, unknown>,
  expectedDoseCount: number,
): void {
  if (response.enrolled !== true) {
    throw new EnrollSeedCliError('[seed] invalid Enroll response: enrolled must be true');
  }
  if (typeof response.patientId !== 'string' || response.patientId.trim().length === 0) {
    throw new EnrollSeedCliError(
      '[seed] invalid Enroll response: patientId must be a nonempty string',
    );
  }
  if (response.doseCount !== expectedDoseCount) {
    throw new EnrollSeedCliError(
      `[seed] invalid Enroll response: doseCount expected ${expectedDoseCount}, received ${String(
        response.doseCount,
      )}`,
    );
  }
}

const USAGE =
  'usage: npx tsx scripts/enroll-seed.ts --fn <EnrollFnName> --owner-sub <clinician-sub-uuid> ' +
  '--phone <+E164> --med <name> ' +
  '[--tz America/Toronto] [--in-min 2 | --at 08:00,14:00,20:00] ' +
  '[--days 1] [--name <display>] [--is-test|--no-test]';

/** Import-testable CLI seam — invokes AWS only through the supplied dependency. */
export function runEnrollSeedCli(argv: readonly string[], deps: EnrollSeedCliDeps): number {
  let fnName: string | undefined;
  let ownerSub: string | undefined;
  let phone: string | undefined;
  let med: string | undefined;
  let name: string | undefined;
  let cliOptions: SeedCliOptions;
  try {
    fnName = argValue('--fn', argv);
    ownerSub = argValue('--owner-sub', argv);
    phone = argValue('--phone', argv);
    med = argValue('--med', argv);
    name = argValue('--name', argv);
    cliOptions = parseSeedCliOptions(argv);
  } catch (error: unknown) {
    deps.error(error instanceof Error ? error.message : 'enroll-seed: invalid CLI options');
    return 1;
  }
  if (!fnName || !ownerSub || !phone || !med) {
    deps.error(USAGE);
    return 1;
  }
  let payload: EnrollSeedPayload;
  try {
    payload = buildSeedPayload(
      {
        ownerSub,
        phone,
        med,
        tz: cliOptions.timezone,
        inMin: cliOptions.inMin,
        at: cliOptions.at,
        days: cliOptions.days,
        name,
        isTest: cliOptions.isTest,
      },
      deps.now(),
    );
  } catch (error: unknown) {
    deps.error(error instanceof Error ? error.message : 'enroll-seed: could not build payload');
    return 1;
  }

  deps.log('='.repeat(72));
  const timingDescription =
    cliOptions.at === undefined
      ? `one daily dose time across ${payload.days} day(s) ` +
        `(first fires ~${cliOptions.inMin} min out)`
      : `${payload.localTimes.length} daily dose time(s) across ${payload.days} day(s) ` +
        `in ${payload.timezone}`;
  deps.log(`SC4 enroll-seed — invoking ${fnName} with ${timingDescription}:`);
  deps.log(JSON.stringify(payload, null, 2));
  deps.log('='.repeat(72));

  // Keep the real phone-bearing payload inside a per-run private directory (mkdtemp mode 0700).
  let privateTempDirectory: string | undefined;
  let exitCode = 1;
  try {
    privateTempDirectory = deps.makeTempDir(join(deps.tempDirectory, 'enroll-seed-'));
    const payloadPath = join(privateTempDirectory, 'payload.json');
    const outPath = join(privateTempDirectory, 'response.json');
    deps.writeFile(payloadPath, JSON.stringify(payload), 'utf8');
    const res = deps.invokeAws([
      'lambda',
      'invoke',
      '--function-name',
      fnName,
      '--payload',
      `fileb://${payloadPath}`,
      '--cli-binary-format',
      'raw-in-base64-out',
      outPath,
    ]);
    if (res.status !== 0) {
      throw new EnrollSeedCliError(
        `[seed] aws lambda invoke failed: ${res.stderr || res.stdout || 'unknown error'}`,
      );
    }
    deps.log(`[seed] invoke metadata: ${res.stdout.trim()}`);
    const metadata = parseJsonObject(res.stdout, 'invoke metadata');
    const out = deps.readFile(outPath, 'utf8');
    deps.log(`[seed] Enroll response: ${out.trim()}`);
    const hasFunctionError = Object.prototype.hasOwnProperty.call(metadata, 'FunctionError');
    if (hasFunctionError || metadata.StatusCode !== 200) {
      const functionError = hasFunctionError
        ? `, FunctionError=${String(metadata.FunctionError)}`
        : '';
      throw new EnrollSeedCliError(
        `[seed] Lambda invocation failed: StatusCode=${String(
          metadata.StatusCode,
        )}${functionError}; response: ${out.trim()}`,
      );
    }
    const response = parseJsonObject(out, 'Enroll response');
    validateEnrollResponse(response, payload.days * payload.localTimes.length);

    const watchMessage =
      cliOptions.at === undefined
        ? `[seed] watch the handset for ~${cliOptions.inMin} min, then query outbound_message for the dose`
        : `[seed] watch the handset at ${payload.localTimes.join(', ')} ${payload.timezone}, then query outbound_message`;
    deps.log(`${watchMessage} (twilio_sid set, status sent→delivered).`);
    exitCode = 0;
  } catch (error: unknown) {
    deps.error(
      error instanceof EnrollSeedCliError
        ? error.message
        : error instanceof Error
          ? `[seed] internal error: ${error.message}`
          : '[seed] internal error',
    );
  } finally {
    if (privateTempDirectory !== undefined) {
      try {
        deps.removeDirectory(privateTempDirectory, { recursive: true, force: true });
      } catch (error: unknown) {
        deps.error(
          error instanceof Error
            ? `[seed] cleanup error: ${error.message}`
            : '[seed] cleanup error',
        );
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

function invokeAwsCommand(args: readonly string[]): EnrollSeedCommandResult {
  const result = spawnSync('aws', [...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** CLI entrypoint — invokes the deployed Enroll Lambda by name. */
function main(): void {
  const exitCode = runEnrollSeedCli(process.argv.slice(2), {
    now: DateTime.now,
    tempDirectory: tmpdir(),
    makeTempDir: mkdtempSync,
    writeFile: writeFileSync,
    readFile: readFileSync,
    removeDirectory: rmSync,
    invokeAws: invokeAwsCommand,
    log: console.log,
    error: console.error,
  });
  process.exitCode = exitCode;
}

// Run main() only when executed directly (tsx/node), not when imported by a test module.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  main();
}
