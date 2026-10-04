import { describe, expect, it } from 'vitest';

import { plausibleStatusTime, turnFromStatus, type StatusFacts, type StatusRules } from '../../src/core/scannerSession';
import type { TurnActivity, TurnInfo, TurnReading, TurnReason, TurnState } from '../../src/core/types';

const NOW = 1_791_116_700_000;
const SINCE = NOW - 600_000; // the status changed ten minutes ago
const STARTED = NOW - 3_600_000;

function turn(state: TurnState, reason: TurnReason, wakeup: number | null = null): TurnInfo {
  return { state, reason, detail: null, scheduledWakeupSeconds: wakeup };
}

function reading(
  transcriptTurn: TurnInfo = turn('CLOSED', 'turnEnded'),
  activity: TurnActivity = { kind: 'at', ms: SINCE - 1000 },
  wakeupSeconds: number | null = null,
): TurnReading {
  return { turn: transcriptTurn, activity, wakeupSeconds };
}

function status(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return { kind: 'interactive', claudeStatus: 'idle', waitingFor: null, statusUpdatedAtMs: SINCE, startedAtMs: STARTED, ...overrides };
}

const RULES: StatusRules = { nowMs: NOW, waitForAnswers: true };
const INTERRUPTED = turn('OPEN', 'thinking'); // what an old Claude Code's Esc looks like to the transcript

describe('turnFromStatus: what each status says', () => {
  it('no status: the transcript decides', () => {
    for (const transcriptTurn of [turn('OPEN', 'thinking'), turn('CLOSED', 'turnEnded'), turn('UNKNOWN', 'cannotRead')]) {
      expect(turnFromStatus(status({ claudeStatus: null }), reading(transcriptTurn), RULES)).toEqual({
        turn: transcriptTurn,
        source: 'transcript',
      });
    }
  });

  it('idle closes a turn the transcript still reads as open', () => {
    expect(turnFromStatus(status(), reading(INTERRUPTED), RULES)).toEqual({ turn: turn('CLOSED', 'claudeIdle'), source: 'claude' });
  });

  it('shell is idle with a background command', () => {
    expect(turnFromStatus(status({ claudeStatus: 'shell' }), reading(INTERRUPTED), RULES).turn).toEqual(turn('CLOSED', 'claudeShell'));
  });

  it('busy opens a turn the transcript reads as closed, whatever else is known', () => {
    for (const facts of [status(), status({ kind: 'bg' }), status({ statusUpdatedAtMs: null }), status({ statusUpdatedAtMs: NOW * 2 })]) {
      expect(turnFromStatus({ ...facts, claudeStatus: 'busy' }, reading(), RULES)).toEqual({
        turn: turn('OPEN', 'claudeBusy'),
        source: 'claude',
      });
    }
  });

  it('waiting keeps the turn open and says what for', () => {
    expect(turnFromStatus(status({ claudeStatus: 'waiting', waitingFor: 'permission prompt' }), reading(), RULES)).toEqual({
      turn: { ...turn('OPEN', 'claudeWaiting'), detail: 'permission prompt' },
      source: 'claude',
    });
  });

  it('waiting closes it only when the user said so, and then like idle', () => {
    const waiting = status({ claudeStatus: 'waiting', waitingFor: 'input needed' });
    expect(turnFromStatus(waiting, reading(turn('OPEN', 'toolInFlight')), { ...RULES, waitForAnswers: false })).toEqual({
      turn: { ...turn('CLOSED', 'claudeWaiting'), detail: 'input needed' },
      source: 'claude',
    });
    for (const waitForAnswers of [true, undefined, 'false', 0, null]) {
      const rules = { ...RULES, waitForAnswers } as unknown as StatusRules;
      expect(turnFromStatus(waiting, reading(), rules).turn.state, String(waitForAnswers)).toBe('OPEN');
    }
    const stale = reading(turn('OPEN', 'toolInFlight'), { kind: 'at', ms: SINCE + 60_000 });
    expect(turnFromStatus(waiting, stale, { ...RULES, waitForAnswers: false }).source).toBe('transcript');
  });

  it('a status word this version does not know is "can\'t tell", never finished', () => {
    for (const word of ['paused', 'IDLE', 'Idle', 'done', 'finished', 'idle ']) {
      expect(turnFromStatus(status({ claudeStatus: word }), reading(), RULES)).toEqual({
        turn: { ...turn('UNKNOWN', 'claudeStatusUnknown'), detail: word },
        source: 'claude',
      });
    }
  });
});

describe('turnFromStatus: idle closes only what nothing contradicts', () => {
  const closes = (facts: StatusFacts, read: TurnReading, rules = RULES): boolean =>
    turnFromStatus(facts, read, rules).source === 'claude';

  it('a turn record written after the status proves it stale (2 s slack)', () => {
    const at = (ms: number) => reading(INTERRUPTED, { kind: 'at', ms });
    expect(closes(status(), at(SINCE + 2000))).toBe(true);
    expect(closes(status(), at(SINCE + 2001))).toBe(false);
    expect(turnFromStatus(status(), at(SINCE + 60_000), RULES)).toEqual({ turn: INTERRUPTED, source: 'transcript' });
  });

  it('a turn record whose time cannot be read is not proof of anything: the transcript decides', () => {
    expect(closes(status(), reading(INTERRUPTED, { kind: 'untimed' }))).toBe(false);
  });

  it('no turn record at all leaves nothing to contradict it', () => {
    expect(closes(status(), reading(turn('CLOSED', 'localCommand'), { kind: 'none' }))).toBe(true);
  });

  it('a panel that was never used: no transcript, or no conversation in it yet', () => {
    for (const reason of ['noTranscript', 'noConversationRecord'] as const) {
      expect(turnFromStatus(status(), reading(turn('UNKNOWN', reason), { kind: 'none' }), RULES).turn).toEqual(turn('CLOSED', 'claudeIdle'));
    }
  });

  it('a transcript that could not be read, or several at once, keeps blocking', () => {
    for (const reason of ['cannotRead', 'ambiguousTranscripts', 'unknownRecord'] as const) {
      const unknown = turn('UNKNOWN', reason);
      expect(turnFromStatus(status(), reading(unknown, { kind: 'none' }), RULES), reason).toEqual({ turn: unknown, source: 'transcript' });
    }
  });

  it('a record being written right now keeps blocking', () => {
    expect(closes(status(), reading(turn('OPEN', 'recordBeingWritten'), { kind: 'untimed' }))).toBe(false);
    expect(closes(status(), reading(turn('OPEN', 'recordBeingWritten'), { kind: 'none' }))).toBe(false);
  });

  it('only interactive sessions (or entries without a kind) are judged by their status', () => {
    expect(closes(status({ kind: '' }), reading(INTERRUPTED))).toBe(true);
    for (const kind of ['bg', 'daemon', 'daemon-worker', 'something-new']) {
      expect(closes(status({ kind }), reading(INTERRUPTED)), kind).toBe(false);
    }
  });

  it('a status time that is missing, in the future or from before the process started', () => {
    expect(closes(status({ statusUpdatedAtMs: null }), reading(INTERRUPTED))).toBe(false);
    expect(closes(status({ statusUpdatedAtMs: NOW + 60_000 }), reading(INTERRUPTED))).toBe(true);
    expect(closes(status({ statusUpdatedAtMs: NOW + 60_001 }), reading(INTERRUPTED))).toBe(false);
    expect(closes(status({ statusUpdatedAtMs: STARTED - 60_000 }), reading(INTERRUPTED, { kind: 'none' }))).toBe(true);
    expect(closes(status({ statusUpdatedAtMs: STARTED - 60_001 }), reading(INTERRUPTED, { kind: 'none' }))).toBe(false);
    expect(closes(status({ startedAtMs: null }), reading(INTERRUPTED))).toBe(true);
    expect(closes(status(), reading(INTERRUPTED), { ...RULES, nowMs: NaN })).toBe(false);
  });

  it("carries the final turn's wake-up into the closed turn, whatever the transcript made of it", () => {
    expect(turnFromStatus(status(), reading(INTERRUPTED, undefined, 600), RULES).turn).toEqual(turn('CLOSED', 'claudeIdle', 600));
    expect(turnFromStatus(status(), reading(turn('CLOSED', 'turnEnded', 90), undefined, 90), RULES).turn.scheduledWakeupSeconds).toBe(90);
    expect(turnFromStatus(status(), reading(), RULES).turn.scheduledWakeupSeconds).toBeNull();
  });
});

describe('plausibleStatusTime', () => {
  it('passes a time between the process start and now', () => {
    expect(plausibleStatusTime({ statusUpdatedAtMs: SINCE, startedAtMs: STARTED }, NOW)).toBe(SINCE);
  });

  it('refuses one it cannot place', () => {
    expect(plausibleStatusTime({ statusUpdatedAtMs: null, startedAtMs: STARTED }, NOW)).toBeNull();
    expect(plausibleStatusTime({ statusUpdatedAtMs: NaN, startedAtMs: STARTED }, NOW)).toBeNull();
    expect(plausibleStatusTime({ statusUpdatedAtMs: Infinity, startedAtMs: STARTED }, NOW)).toBeNull();
    expect(plausibleStatusTime({ statusUpdatedAtMs: SINCE, startedAtMs: STARTED }, NaN)).toBeNull();
  });
});
