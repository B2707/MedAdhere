// scripts/enroll-seed.test.ts
//
// Pure unit test of the SC4/P7 enroll-seed payload builder (clock injected) and its small argv parser.
// Every seed row defaults to is_test=true so the pre-cohort wipe can remove all normal dev noise; the
// explicit --no-test escape hatch is the only way to opt out.

import { describe, it, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { computeScheduledAtUtc, generateDoseSchedule } from '@medadhere/shared';
import {
  MAX_ENROLL_DAYS as API_MAX_ENROLL_DAYS,
  MAX_LOCAL_TIMES as API_MAX_LOCAL_TIMES,
} from '../backend/src/enroll-api/core.js';
import {
  MAX_ENROLL_DAYS,
  MAX_IN_MINUTES,
  MAX_LOCAL_TIMES,
  argValue,
  buildSeedPayload,
  parseSeedCliOptions,
  runEnrollSeedCli,
  type EnrollSeedCliDeps,
} from './enroll-seed.js';

const NOW = DateTime.fromISO('2026-08-20T12:00:00', { zone: 'America/Toronto' });
const OWNER_SUB = '8f6e7138-fd21-4b31-8ac3-934cfc610f44';

describe('enroll-seed buildSeedPayload — D14 is_test', () => {
  it('requires the owner clinician UUID and threads it to the direct Enroll payload', () => {
    const payload = buildSeedPayload(
      { ownerSub: OWNER_SUB, phone: '+15145550123', med: 'Metformin' },
      NOW,
    );
    expect(payload.owner_clinician_sub).toBe(OWNER_SUB);
  });

  it.each(['', 'not-a-uuid', '8f6e7138-fd21-4b31-8ac3-934cfc610f4'])(
    'rejects invalid ownerSub=%j before building an Enroll payload',
    (ownerSub) => {
      expect(() =>
        buildSeedPayload({ ownerSub, phone: '+15145550123', med: 'Metformin' }, NOW),
      ).toThrow(/--owner-sub.*UUID/i);
    },
  );

  it('defaults is_test to TRUE so normal seed rows are removable dev noise', () => {
    const payload = buildSeedPayload(
      { ownerSub: OWNER_SUB, phone: '+15145550123', med: 'Metformin' },
      NOW,
    );
    expect(payload.is_test).toBe(true);
  });

  it('keeps explicit isTest=false as the dev-only opt-out', () => {
    const payload = buildSeedPayload(
      { ownerSub: OWNER_SUB, phone: '+15145550123', med: 'Metformin', isTest: false },
      NOW,
    );
    expect(payload.is_test).toBe(false);
  });

  it('sets is_test TRUE when the operator seeds the validation cohort (--is-test)', () => {
    const payload = buildSeedPayload(
      { ownerSub: OWNER_SUB, phone: '+15145550123', med: 'Metformin', isTest: true },
      NOW,
    );
    expect(payload.is_test).toBe(true);
  });

  it('--no-test wins over --is-test when both flags are present', () => {
    expect(parseSeedCliOptions(['--is-test', '--no-test']).isTest).toBe(false);
    expect(parseSeedCliOptions(['--no-test']).isTest).toBe(false);
    expect(parseSeedCliOptions(['--is-test']).isTest).toBe(true);
  });
});

describe('enroll-seed buildSeedPayload — bounded days', () => {
  it('keeps the SC4 one-day horizon by default', () => {
    const payload = buildSeedPayload(
      { ownerSub: OWNER_SUB, phone: '+15145550123', med: 'Metformin', isTest: true },
      NOW,
    );
    expect(payload.days).toBe(1);
    expect(payload.localTimes).toHaveLength(1);
    expect(payload.medication_name).toBe('Metformin');
    expect(payload.is_test).toBe(true);
  });

  it('threads --days 3 into the payload for the Phase-7 cohort', () => {
    const cli = parseSeedCliOptions(['--days', '3']);
    const payload = buildSeedPayload(
      { ownerSub: OWNER_SUB, phone: '+15145550123', med: 'Metformin', days: cli.days },
      NOW,
    );
    expect(payload.days).toBe(3);
  });

  it.each(['0', '15', '2.5', 'not-a-number'])(
    'keeps --days bounds in the pure payload builder for value %s',
    (days) => {
      expect(() =>
        buildSeedPayload(
          {
            ownerSub: OWNER_SUB,
            phone: '+15145550123',
            med: 'Metformin',
            days: Number(days),
          },
          NOW,
        ),
      ).toThrow(/--days/);
    },
  );

  it.each([['--days'], ['--days', '--is-test']])(
    'rejects a missing --days value loudly (%j)',
    (...argv) => {
      expect(() => parseSeedCliOptions(argv)).toThrow(/--days/);
    },
  );

  it.each(['--fn', '--phone', '--med', '--tz', '--in-min', '--days', '--name'])(
    'rejects a missing value for %s in the shared argument parser',
    (flag) => {
      expect(() => argValue(flag, [flag])).toThrow(new RegExp(flag));
      expect(() => argValue(flag, [flag, '--is-test'])).toThrow(new RegExp(flag));
    },
  );

  it('keeps the script enrollment-day cap aligned with the API boundary', () => {
    expect(MAX_ENROLL_DAYS).toBe(API_MAX_ENROLL_DAYS);
  });

  it('derives startDate and localTimes from the same post-midnight fire time', () => {
    const beforeMidnight = DateTime.fromISO('2026-08-20T23:59:00', {
      zone: 'America/Toronto',
    });
    const payload = buildSeedPayload(
      {
        ownerSub: OWNER_SUB,
        phone: '+15145550123',
        med: 'Metformin',
        tz: 'America/Toronto',
        inMin: 2,
      },
      beforeMidnight,
    );

    expect(payload.startDate).toBe('2026-08-21');
    expect(payload.localTimes).toEqual(['00:01']);
  });
});

describe('enroll-seed timezone and relative-time validation', () => {
  it('accepts a valid IANA timezone at CLI parse time', () => {
    expect(parseSeedCliOptions(['--tz', 'America/Toronto']).timezone).toBe('America/Toronto');
  });

  it('rejects an invalid IANA timezone at CLI parse time', () => {
    expect(() => parseSeedCliOptions(['--tz', 'Invalid/Zone'])).toThrow(/--tz.*IANA timezone/i);
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_IN_MINUTES + 1])(
    'keeps --in-min bounds in the pure payload builder for value %s',
    (inMin) => {
      expect(() =>
        buildSeedPayload(
          {
            ownerSub: OWNER_SUB,
            phone: '+15145550123',
            med: 'Metformin',
            inMin,
          },
          NOW,
        ),
      ).toThrow(/--in-min/);
    },
  );

  it.each([1, MAX_IN_MINUTES])('accepts bounded positive integer --in-min value %s', (inMin) => {
    expect(
      buildSeedPayload(
        {
          ownerSub: OWNER_SUB,
          phone: '+15145550123',
          med: 'Metformin',
          inMin,
        },
        NOW,
      ).localTimes,
    ).toHaveLength(1);
  });
});

describe('enroll-seed --at local dose times', () => {
  it('parses one or more comma-separated HH:mm values and preserves their order', () => {
    const cli = parseSeedCliOptions(['--at', '08:00,14:00,20:00', '--days', '4']);

    expect(cli.at).toEqual(['08:00', '14:00', '20:00']);
    expect(cli.inMin).toBeUndefined();
    expect(cli.days).toBe(4);
  });

  it('accepts the inclusive 24-hour boundaries', () => {
    expect(parseSeedCliOptions(['--at', '00:00,23:59']).at).toEqual(['00:00', '23:59']);
  });

  it.each(['', ',', '08:00,', ',08:00', '8:00', '24:00', '12:60', 'noon'])(
    'rejects invalid --at value %j',
    (at) => {
      expect(() => parseSeedCliOptions(['--at', at])).toThrow(/--at/);
    },
  );

  it('rejects duplicate local times', () => {
    expect(() => parseSeedCliOptions(['--at', '08:00,14:00,08:00'])).toThrow(/duplicate.*08:00/i);
  });

  it('rejects more local times than the enrollment API accepts', () => {
    const tooMany = Array.from(
      { length: API_MAX_LOCAL_TIMES + 1 },
      (_, index) => `${String(index).padStart(2, '0')}:00`,
    ).join(',');

    expect(() => parseSeedCliOptions(['--at', tooMany])).toThrow(/--at/);
    expect(MAX_LOCAL_TIMES).toBe(API_MAX_LOCAL_TIMES);
  });

  it('keeps --at/--in-min exclusivity in the pure payload builder', () => {
    expect(() =>
      buildSeedPayload(
        {
          ownerSub: OWNER_SUB,
          phone: '+15145550123',
          med: 'Metformin',
          at: ['08:00', '20:00'],
          inMin: 5,
        },
        NOW,
      ),
    ).toThrow(/--at.*--in-min|--in-min.*--at/);
  });

  it.each([['--at'], ['--at', '--days']])('rejects a missing --at value loudly (%j)', (...argv) => {
    expect(() => parseSeedCliOptions(argv)).toThrow(/--at/);
  });

  it('builds every chosen local time across multiple days and maps DST-correctly to UTC', () => {
    const beforeDstFallback = DateTime.fromISO('2026-10-31T07:30:00', {
      zone: 'America/Toronto',
    });
    const cli = parseSeedCliOptions(['--at', '08:00,20:00', '--days', '2']);
    const payload = buildSeedPayload(
      {
        ownerSub: OWNER_SUB,
        phone: '+15145550123',
        med: 'Metformin',
        tz: 'America/Toronto',
        days: cli.days,
        at: cli.at,
      },
      beforeDstFallback,
    );

    expect(payload.startDate).toBe('2026-10-31');
    expect(payload.localTimes).toEqual(['08:00', '20:00']);

    const slots = generateDoseSchedule({
      startDate: payload.startDate,
      days: payload.days,
      localTimes: payload.localTimes,
      timezone: payload.timezone,
    });
    expect(slots).toEqual([
      { doseDate: '2026-10-31', localDoseTime: '08:00' },
      { doseDate: '2026-10-31', localDoseTime: '20:00' },
      { doseDate: '2026-11-01', localDoseTime: '08:00' },
      { doseDate: '2026-11-01', localDoseTime: '20:00' },
    ]);
    expect(
      slots.map((slot) =>
        computeScheduledAtUtc({
          ...slot,
          timezone: payload.timezone,
        }),
      ),
    ).toEqual([
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
      '2026-11-02T01:00:00.000Z',
    ]);
  });

  it('starts explicit times tomorrow when any chosen time has already passed today', () => {
    const payload = buildSeedPayload(
      {
        ownerSub: OWNER_SUB,
        phone: '+15145550123',
        med: 'Metformin',
        tz: 'America/Toronto',
        days: 4,
        at: ['08:00', '14:00', '20:00'],
      },
      NOW,
    );

    expect(payload.startDate).toBe('2026-08-21');
    expect(payload.days * payload.localTimes.length).toBe(12);
  });

  it('starts tomorrow when an explicit time equals the current local minute', () => {
    const payload = buildSeedPayload(
      {
        ownerSub: OWNER_SUB,
        phone: '+15145550123',
        med: 'Metformin',
        tz: 'America/Toronto',
        at: ['12:00'],
      },
      NOW,
    );

    expect(payload.startDate).toBe('2026-08-21');
  });

  it('keeps the now-plus-in-min default behavior when --at is absent', () => {
    const cli = parseSeedCliOptions(['--days', '2']);
    const payload = buildSeedPayload(
      {
        ownerSub: OWNER_SUB,
        phone: '+15145550123',
        med: 'Metformin',
        tz: 'America/Toronto',
        days: cli.days,
        inMin: cli.inMin,
        at: cli.at,
      },
      NOW,
    );

    expect(cli.inMin).toBe(2);
    expect(payload.startDate).toBe('2026-08-20');
    expect(payload.localTimes).toEqual(['12:02']);
  });
});

describe('enroll-seed import-testable CLI', () => {
  const DEFAULT_CLI_ARGS = [
    '--fn',
    'EnrollFn',
    '--phone',
    '+15145550123',
    '--med',
    'Metformin',
    '--owner-sub',
    OWNER_SUB,
  ] as const;
  const MULTI_DOSE_CLI_ARGS = [
    ...DEFAULT_CLI_ARGS,
    '--tz',
    'America/Toronto',
    '--at',
    '08:00,14:00,20:00',
    '--days',
    '4',
  ] as const;

  function makeCliDeps(overrides: Partial<EnrollSeedCliDeps> = {}): EnrollSeedCliDeps {
    return {
      now: () => NOW,
      tempDirectory: '/tmp',
      makeTempDir: vi.fn(() => '/tmp/enroll-seed-private-AbCd'),
      writeFile: vi.fn(),
      readFile: vi.fn(() => '{"enrolled":true,"patientId":"patient-1","doseCount":12}'),
      removeDirectory: vi.fn(),
      invokeAws: vi.fn(() => ({
        status: 0,
        stdout: '{"StatusCode":200}',
        stderr: '',
      })),
      log: vi.fn(),
      error: vi.fn(),
      ...overrides,
    };
  }

  it('invokes AWS with a 3-times/day x 4-days payload and explicit-time operator wording', () => {
    const deps = makeCliDeps();

    const exitCode = runEnrollSeedCli(MULTI_DOSE_CLI_ARGS, deps);

    expect(exitCode).toBe(0);
    expect(deps.makeTempDir).toHaveBeenCalledWith('/tmp/enroll-seed-');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/enroll-seed-private-AbCd/payload.json',
      expect.stringContaining('"localTimes":["08:00","14:00","20:00"]'),
      'utf8',
    );
    expect(deps.invokeAws).toHaveBeenCalledWith([
      'lambda',
      'invoke',
      '--function-name',
      'EnrollFn',
      '--payload',
      'fileb:///tmp/enroll-seed-private-AbCd/payload.json',
      '--cli-binary-format',
      'raw-in-base64-out',
      '/tmp/enroll-seed-private-AbCd/response.json',
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('3 daily dose time(s) across 4 day(s)'),
    );
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('08:00, 14:00, 20:00 America/Toronto'),
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
    expect(deps.removeDirectory).toHaveBeenCalledOnce();
    expect(deps.removeDirectory).toHaveBeenCalledWith('/tmp/enroll-seed-private-AbCd', {
      recursive: true,
      force: true,
    });
  });

  it('returns a usage error before writing or invoking when required args are missing', () => {
    const deps = makeCliDeps();

    expect(runEnrollSeedCli(['--at', '08:00'], deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/^usage:/));
    expect(deps.makeTempDir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.invokeAws).not.toHaveBeenCalled();
  });

  it('requires --owner-sub before creating temp files or invoking AWS', () => {
    const deps = makeCliDeps();

    expect(
      runEnrollSeedCli(['--fn', 'EnrollFn', '--phone', '+15145550123', '--med', 'Metformin'], deps),
    ).toBe(1);

    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/^usage:.*--owner-sub/s));
    expect(deps.makeTempDir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.invokeAws).not.toHaveBeenCalled();
  });

  it('rejects invalid --owner-sub before creating temp files or invoking AWS', () => {
    const deps = makeCliDeps();

    expect(
      runEnrollSeedCli(
        [
          '--fn',
          'EnrollFn',
          '--phone',
          '+15145550123',
          '--med',
          'Metformin',
          '--owner-sub',
          'not-a-uuid',
        ],
        deps,
      ),
    ).toBe(1);

    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/--owner-sub.*UUID/i));
    expect(deps.makeTempDir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.invokeAws).not.toHaveBeenCalled();
  });

  it('returns a parsing error before writing or invoking for mutually exclusive time modes', () => {
    const deps = makeCliDeps();

    expect(
      runEnrollSeedCli(
        [
          '--fn',
          'EnrollFn',
          '--phone',
          '+15145550123',
          '--med',
          'Metformin',
          '--owner-sub',
          OWNER_SUB,
          '--at',
          '08:00',
          '--in-min',
          '2',
        ],
        deps,
      ),
    ).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/mutually exclusive/));
    expect(deps.invokeAws).not.toHaveBeenCalled();
  });

  it('returns non-zero on AWS invoke process failure and removes the private temp directory', () => {
    const deps = makeCliDeps({
      invokeAws: vi.fn(() => ({
        status: 1,
        stdout: '',
        stderr: 'invoke failed',
      })),
    });

    expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('[seed] aws lambda invoke failed: invoke failed');
    expect(deps.removeDirectory).toHaveBeenCalledOnce();
  });

  it('fails when AWS exits zero but Lambda metadata carries FunctionError, including the response', () => {
    const deps = makeCliDeps({
      invokeAws: vi.fn(() => ({
        status: 0,
        stdout: '{"StatusCode":200,"FunctionError":"Unhandled"}',
        stderr: '',
      })),
      readFile: vi.fn(() => '{"errorMessage":"Enroll exploded"}'),
    });

    expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
    expect(deps.log).toHaveBeenCalledWith(
      '[seed] Enroll response: {"errorMessage":"Enroll exploded"}',
    );
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringMatching(/FunctionError.*Unhandled.*Enroll exploded/i),
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
    expect(deps.removeDirectory).toHaveBeenCalledOnce();
  });

  it('fails when Lambda metadata StatusCode is not 200, including the response', () => {
    const deps = makeCliDeps({
      invokeAws: vi.fn(() => ({
        status: 0,
        stdout: '{"StatusCode":202}',
        stderr: '',
      })),
      readFile: vi.fn(() => '{"message":"unexpected status"}'),
    });

    expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringMatching(/StatusCode.*202.*unexpected status/i),
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
  });

  it('fails on malformed Enroll response JSON and does not print the handset success message', () => {
    const deps = makeCliDeps({
      readFile: vi.fn(() => '{not-json'),
    });

    expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/Enroll response.*JSON/i));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
    expect(deps.removeDirectory).toHaveBeenCalledOnce();
  });

  it('fails when the Enroll response has an empty patientId', () => {
    const deps = makeCliDeps({
      readFile: vi.fn(() => '{"enrolled":true,"patientId":"  ","doseCount":1}'),
    });

    expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/patientId/i));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
  });

  it('fails when the Enroll response doseCount does not match days x localTimes', () => {
    const deps = makeCliDeps({
      readFile: vi.fn(() => '{"enrolled":true,"patientId":"patient-1","doseCount":11}'),
    });

    expect(runEnrollSeedCli(MULTI_DOSE_CLI_ARGS, deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringMatching(/doseCount.*12.*11/i));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
  });

  it.each(['writeFile', 'invokeAws', 'readFile'] as const)(
    'catches a thrown %s boundary, exits one, and still cleans up without throwing',
    (boundary) => {
      const thrownBoundary = vi.fn(() => {
        throw new Error(`${boundary} failed`);
      });
      const overrides: Partial<EnrollSeedCliDeps> =
        boundary === 'writeFile'
          ? { writeFile: thrownBoundary }
          : boundary === 'invokeAws'
            ? { invokeAws: thrownBoundary }
            : { readFile: thrownBoundary };
      const deps = makeCliDeps(overrides);

      expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
      expect(deps.error).toHaveBeenCalledWith(`[seed] internal error: ${boundary} failed`);
      expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('watch the handset'));
      expect(deps.removeDirectory).toHaveBeenCalledOnce();
    },
  );

  it('catches private-directory creation failure without attempting cleanup', () => {
    const deps = makeCliDeps({
      makeTempDir: vi.fn(() => {
        throw new Error('mkdtemp failed');
      }),
    });

    expect(runEnrollSeedCli(DEFAULT_CLI_ARGS, deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('[seed] internal error: mkdtemp failed');
    expect(deps.removeDirectory).not.toHaveBeenCalled();
  });
});
