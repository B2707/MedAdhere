import { describe, expect, it } from 'vitest';
import {
  adherenceProjection,
  deriveAdministrationTiming,
  ON_WINDOW_GRACE_MINUTES,
} from './adherence-mapping.js';

const SCHEDULED_AT = new Date('2026-08-13T13:00:00Z');
// RESPONSE_WINDOW_MINUTES (120) + grace (15) => boundary 15:15:00Z inclusive.
const BOUNDARY = new Date('2026-08-13T15:15:00Z');

describe('deriveAdministrationTiming', () => {
  it('pins the grace band at 15 minutes', () => {
    expect(ON_WINDOW_GRACE_MINUTES).toBe(15);
  });

  it('derives on_time for a reply at or before scheduled + window + grace', () => {
    expect(
      deriveAdministrationTiming({
        claimedTiming: undefined,
        receivedAt: new Date('2026-08-13T14:00:00Z'),
        scheduledAt: SCHEDULED_AT,
      }),
    ).toBe('on_time');
    expect(
      deriveAdministrationTiming({
        claimedTiming: undefined,
        receivedAt: BOUNDARY,
        scheduledAt: SCHEDULED_AT,
      }),
    ).toBe('on_time');
  });

  it('derives late one millisecond past the boundary', () => {
    expect(
      deriveAdministrationTiming({
        claimedTiming: undefined,
        receivedAt: new Date(BOUNDARY.getTime() + 1),
        scheduledAt: SCHEDULED_AT,
      }),
    ).toBe('late');
  });

  it('keeps the resolver late signal even inside the window', () => {
    expect(
      deriveAdministrationTiming({
        claimedTiming: 'late',
        receivedAt: new Date('2026-08-13T13:05:00Z'),
        scheduledAt: SCHEDULED_AT,
      }),
    ).toBe('late');
  });

  it('never trusts an asserted on_time outside the window', () => {
    expect(
      deriveAdministrationTiming({
        claimedTiming: 'on_time',
        receivedAt: new Date('2026-08-13T16:30:00Z'),
        scheduledAt: SCHEDULED_AT,
      }),
    ).toBe('late');
  });

  it('treats a reply before the scheduled time as on_time', () => {
    expect(
      deriveAdministrationTiming({
        claimedTiming: undefined,
        receivedAt: new Date('2026-08-13T12:00:00Z'),
        scheduledAt: SCHEDULED_AT,
      }),
    ).toBe('on_time');
  });
});

describe('adherenceProjection', () => {
  it('maps taken on-window to taken', () => {
    expect(adherenceProjection('taken', 'on_time')).toEqual({
      adherenceState: 'taken',
      reasonCode: 'none',
      safetyFlag: 'none',
      decidedBy: 'classifier',
      status: 'recorded',
    });
  });

  it('maps taken late to delayed', () => {
    expect(adherenceProjection('taken', 'late')).toMatchObject({ adherenceState: 'delayed' });
  });

  it('maps missed to skipped regardless of timing, status recorded', () => {
    expect(adherenceProjection('missed', 'on_time')).toMatchObject({
      adherenceState: 'skipped',
      status: 'recorded',
      decidedBy: 'classifier',
    });
    expect(adherenceProjection('missed', 'late')).toMatchObject({ adherenceState: 'skipped' });
  });

  it('returns the explicit pending row (null) for an undefined adherence', () => {
    expect(adherenceProjection(undefined, 'on_time')).toBeNull();
  });

  it('throws loudly for partial (human-review lane, unreachable from the agent path)', () => {
    expect(() => adherenceProjection('partial', 'on_time')).toThrow(
      'clinical_projection_policy_unresolved',
    );
  });
});
