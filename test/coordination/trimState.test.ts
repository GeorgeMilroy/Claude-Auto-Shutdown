import { describe, expect, it } from 'vitest';

import { MAX_STATE_BYTES, trimForWire } from '../../src/coordination/trimState';
import { readState } from '../../src/coordination/wire';
import { activity, bytes, hugeState, session } from './bigState';
import { armedState } from './harness';

describe('trimForWire', () => {
  it('leaves a state that fits alone, object and all', () => {
    const state = armedState({ sessions: [session(1)] });

    expect(trimForWire(state, MAX_STATE_BYTES)).toBe(state);
  });

  it('fits 300 sessions of 20 subagents into one message, and keeps everything that decides', () => {
    const state = hugeState();
    expect(bytes(state)).toBeGreaterThan(4 * MAX_STATE_BYTES);

    const wire = trimForWire(state, MAX_STATE_BYTES);

    expect(bytes(wire)).toBeLessThanOrEqual(MAX_STATE_BYTES);
    const decisive = ['phase', 'armed', 'countdown', 'contract', 'checks', 'stop', 'lastResult', 'seq'] as const;
    for (const field of decisive) expect(wire[field]).toEqual(state[field]);
    expect(wire.strays).toHaveLength(20);
    expect(wire.sessions.length).toBeGreaterThan(0);
    expect(wire.sessions.length + wire.sessionsOmitted).toBe(300);
    for (const kept of wire.sessions) {
      expect(kept.subagents).toHaveLength(3);
      expect(kept.children).toHaveLength(3);
    }
    expect(wire.activity).toHaveLength(10);
    expect(wire.activity.map((entry) => entry.atMs)).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
    expect(wire.activity.every((entry) => entry.text.length <= 300)).toBe(true);
    expect(wire.scan.errors).toHaveLength(10);
    // What the other windows read: a complete state of this version.
    expect(readState(JSON.parse(JSON.stringify(wire)), false)).not.toBeNull();
    // The original is untouched: the leader's own window still shows every row.
    expect(state.sessions).toHaveLength(300);
    expect(state.sessions[0]!.subagents).toHaveLength(20);
  });

  it('keeps the sessions that hold this PC on, wherever they were in the list', () => {
    const sessions = Array.from({ length: 300 }, (_, n) => session(n));
    const blocking = [297, 298, 299];
    sessions[297] = session(297, { status: 'working', working: true, why: { id: 'turnOpen' } });
    sessions[298] = session(298, { status: 'cantTell', working: true, why: { id: 'turnUnknown' } });
    sessions[299] = session(299, { status: 'working', working: true });
    sessions[0] = session(0, { status: 'working', working: true, ignored: true });

    const wire = trimForWire(hugeState({ sessions }), MAX_STATE_BYTES);

    expect(wire.sessionsOmitted).toBeGreaterThan(0);
    expect(wire.sessions.slice(0, 3).map((kept) => kept.key)).toEqual(blocking.map((n) => `session-${n}`));
  });

  it('trims only as much as it has to: subagent and process lists first', () => {
    // Over the limit only because of the subagent lists.
    const sessions = Array.from({ length: 60 }, (_, n) => session(n, { children: [] }));
    const state = armedState({ sessions, activity: activity(40, 10) });
    expect(bytes(state)).toBeGreaterThan(MAX_STATE_BYTES);

    const wire = trimForWire(state, MAX_STATE_BYTES);

    expect(wire.sessions).toHaveLength(60);
    expect(wire.sessionsOmitted).toBe(0);
    expect(wire.sessions[0]!.subagents.map((agent) => agent.name)).toEqual(
      state.sessions[0]!.subagents.slice(0, 3).map((agent) => agent.name),
    );
    expect(wire.activity).toEqual(state.activity);
  });

  it('sends no session rows at all, counted, when nothing else can make it fit', () => {
    const bulky = { id: 'registry' as const, state: 'cantTell' as const, data: { names: ['n'.repeat(300_000)] } };
    const state = hugeState({ checks: [bulky] });

    const wire = trimForWire(state, MAX_STATE_BYTES);

    expect(wire.sessions).toEqual([]);
    expect(wire.sessionsOmitted).toBe(300);
    expect(wire.checks).toEqual([bulky]);
    expect(wire.countdown).toEqual(state.countdown);
    expect(wire.strays).toHaveLength(20);
  });

  it('adds to a count of sessions that were already left out', () => {
    const wire = trimForWire(hugeState({ sessionsOmitted: 5 }), MAX_STATE_BYTES);

    expect(wire.sessions.length + wire.sessionsOmitted).toBe(305);
  });
});
