import { describe, expect, it } from 'vitest';
import { computeCensus } from './day-census';
import type { ThreadItem } from './thread-merge';

function messageItem(
  id: string,
  eventPriorities: Array<'emergency' | 'important' | 'routine' | 'none'>,
): ThreadItem {
  return {
    kind: 'message',
    id,
    at: '2026-08-11T12:00:00.000Z',
    // Only `.events[].priority` and `.event.id` are read by computeCensus.
    message: {} as never,
    events: eventPriorities.map((priority, index) => ({
      event: { id: `${id}-e${index}` } as never,
      priority,
      evidence: [],
    })),
  };
}

function eventItem(
  id: string,
  priority: 'emergency' | 'important' | 'routine' | 'none',
): ThreadItem {
  return {
    kind: 'event',
    id,
    at: '2026-08-11T12:00:00.000Z',
    event: { event: { id } as never, priority, evidence: [] },
  };
}

describe('computeCensus', () => {
  it('counts messages, all events (tethered + standalone), and each escalated tier', () => {
    const counts = computeCensus([
      messageItem('m1', ['important', 'none']),
      messageItem('m2', []),
      eventItem('e1', 'emergency'),
      eventItem('e2', 'routine'),
    ]);

    expect(counts).toEqual({ emergency: 1, important: 1, messages: 2, events: 4 });
  });

  it('returns all-zero counts for an empty day', () => {
    expect(computeCensus([])).toEqual({ emergency: 0, important: 0, messages: 0, events: 0 });
  });

  it('never counts the draft item as a message or an event', () => {
    const counts = computeCensus([
      { kind: 'draft', id: 'd1', at: '2026-08-11T01:00:00.000Z', draft: {} as never },
    ]);

    expect(counts).toEqual({ emergency: 0, important: 0, messages: 0, events: 0 });
  });

  it('ignores "none" and "fallback" priorities in the escalated tier counts', () => {
    const counts = computeCensus([eventItem('e1', 'none'), messageItem('m1', ['none'])]);

    expect(counts.emergency).toBe(0);
    expect(counts.important).toBe(0);
  });
});

describe('server/client boundary (2026-08-17 production incident)', () => {
  // The patient page (a Server Component) calls computeCensus() during render. Calling a
  // function exported from a 'use client' module on the server throws at runtime in
  // production ("Attempted to call computeCensus() from the server") — jsdom cannot catch
  // it, so these pins hold the boundary statically.
  it('keeps the census math in a server-safe module (thread-merge has no use client)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./thread-merge.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^['"]use client['"]/);
    expect(source).toContain('export function computeCensus');
  });

  it('the patient page imports computeCensus from thread-merge, never from day-census', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../app/patients/[id]/page.tsx', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain("from '@/components/day-thread/day-census'");
    expect(source).toContain("from '@/components/day-thread/thread-merge'");
  });
});
