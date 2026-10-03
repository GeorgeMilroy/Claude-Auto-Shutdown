import { describe, expect, it } from 'vitest';
import type { CountdownState } from '../../src/shared/protocol';
import {
  agedSeconds,
  anchorCountdown,
  announcementDue,
  elapsedMs,
  remainingFraction,
  remainingMs,
  remainingOf,
  remainingSeconds,
  scanAgeMs,
} from '../../src/webview/clock';
import type { CountdownAnchor } from '../../src/webview/clock';

function countdown(overrides: Partial<CountdownState> = {}): CountdownState {
  return { id: 'cd-1', kind: 'real', action: 'shutdown', totalMs: 90_000, remainingMs: 87_000, ...overrides };
}

/** A countdown state as another version (or a bug) might send it. */
function foreignCountdown(fields: Record<string, unknown>): CountdownState {
  return { id: 'cd-1', kind: 'real', action: 'shutdown', totalMs: 90_000, remainingMs: 87_000, ...fields } as unknown as CountdownState;
}

describe('anchoring a countdown to the local clock', () => {
  it('counts down from the published value, starting at the moment of receipt', () => {
    const anchor = anchorCountdown(null, countdown(), 1_000);
    expect(remainingMs(anchor, 1_000)).toBe(87_000);
    expect(remainingMs(anchor, 11_000)).toBe(77_000);
    expect(remainingMs(anchor, 87_999)).toBe(1);
  });

  it('clamps at zero and stays there', () => {
    const anchor = anchorCountdown(null, countdown({ remainingMs: 2_000 }), 0);
    expect(remainingMs(anchor, 2_000)).toBe(0);
    expect(remainingMs(anchor, 500_000)).toBe(0);
    expect(remainingSeconds(anchor, 500_000)).toBe(0);
  });

  it('never runs backwards when the clock value is earlier than the receipt', () => {
    const anchor = anchorCountdown(null, countdown(), 5_000);
    expect(remainingMs(anchor, 4_000)).toBe(87_000);
  });

  it('reads 0 when the published value is unusable: never more time than may be left', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, '87000', -5, {}]) {
      const anchor = anchorCountdown(null, foreignCountdown({ remainingMs: bad }), 0);
      expect(remainingMs(anchor, 0)).toBe(0);
    }
  });

  it('reads 0 when the local clock is unusable', () => {
    const anchor: CountdownAnchor = { id: 'x', remainingAtReceiptMs: NaN, receivedAt: 0, totalMs: null };
    expect(remainingMs(anchor, 0)).toBe(0);
    expect(remainingSeconds(anchor, 0)).toBe(0);
  });

  it('does not hand time back when a later message of the same countdown claims more', () => {
    const first = anchorCountdown(null, countdown({ remainingMs: 87_000 }), 0);
    // 5 s later this window shows 82 s; a delayed publish still says 86 s.
    const second = anchorCountdown(first, countdown({ remainingMs: 86_000 }), 5_000);
    expect(remainingMs(second, 5_000)).toBe(82_000);
  });

  it('follows the leader when it says less than this window shows', () => {
    const first = anchorCountdown(null, countdown({ remainingMs: 87_000 }), 0);
    const second = anchorCountdown(first, countdown({ remainingMs: 40_000 }), 5_000);
    expect(remainingMs(second, 5_000)).toBe(40_000);
  });

  it('starts afresh for a different countdown', () => {
    const first = anchorCountdown(null, countdown({ id: 'a', remainingMs: 3_000 }), 0);
    const second = anchorCountdown(first, countdown({ id: 'b', remainingMs: 87_000 }), 2_000);
    expect(remainingMs(second, 2_000)).toBe(87_000);
  });

  it('treats a missing id as its own countdown rather than crashing', () => {
    const anchor = anchorCountdown(null, foreignCountdown({ id: 7 }), 0);
    expect(anchor.id).toBe('');
  });
});

describe('what the digits and the bar show', () => {
  it('rounds the seconds up, so 0:00 appears exactly when no time is left', () => {
    const anchor = anchorCountdown(null, countdown({ remainingMs: 87_000 }), 0);
    expect(remainingSeconds(anchor, 0)).toBe(87);
    expect(remainingSeconds(anchor, 1)).toBe(87);
    expect(remainingSeconds(anchor, 1_000)).toBe(86);
    expect(remainingSeconds(anchor, 86_999)).toBe(1);
    expect(remainingSeconds(anchor, 87_000)).toBe(0);
  });

  it('gives the share that is left in whole-second steps', () => {
    const anchor = anchorCountdown(null, countdown({ totalMs: 90_000, remainingMs: 45_000 }), 0);
    expect(remainingFraction(anchor, 0)).toBe(0.5);
    expect(remainingFraction(anchor, 400)).toBe(0.5);
    expect(remainingFraction(anchor, 45_000)).toBe(0);
  });

  it('never shows more than a full bar, and no bar when the length is unknown', () => {
    expect(remainingFraction(anchorCountdown(null, countdown({ totalMs: 10_000, remainingMs: 60_000 }), 0), 0)).toBe(1);
    for (const bad of [0, -1, NaN, undefined, 'long']) {
      expect(remainingFraction(anchorCountdown(null, foreignCountdown({ totalMs: bad }), 0), 0)).toBeNull();
    }
  });
});

describe('screen-reader marks', () => {
  it('speaks when the clock reaches 60, 30, 10 and 5 seconds', () => {
    expect(announcementDue(61, 60)).toBe(60);
    expect(announcementDue(31, 30)).toBe(30);
    expect(announcementDue(11, 10)).toBe(10);
    expect(announcementDue(6, 5)).toBe(5);
  });

  it('stays silent between marks and on the first tick', () => {
    expect(announcementDue(59, 58)).toBeNull();
    expect(announcementDue(60, 60)).toBeNull();
    expect(announcementDue(4, 3)).toBeNull();
    expect(announcementDue(null, 30)).toBeNull();
  });

  it('speaks only the latest mark when a tick jumps over several', () => {
    expect(announcementDue(70, 8)).toBe(10);
    expect(announcementDue(70, 2)).toBe(5);
  });

  it('stays silent on unusable numbers', () => {
    expect(announcementDue(NaN, 30)).toBeNull();
    expect(announcementDue(40, NaN)).toBeNull();
  });
});

describe('durations and ages', () => {
  it('measures elapsed time, never negative', () => {
    expect(elapsedMs(1_000, 1_250)).toBe(250);
    expect(elapsedMs(1_000, 900)).toBe(0);
    expect(elapsedMs(NaN, 900)).toBe(0);
  });

  it('counts a published duration down, and keeps unknown unknown', () => {
    expect(remainingOf(6_000, 0, 2_000)).toBe(4_000);
    expect(remainingOf(6_000, 0, 9_000)).toBe(0);
    expect(remainingOf(null, 0, 1)).toBeNull();
    expect(remainingOf(NaN, 0, 1)).toBeNull();
    expect(remainingOf('6000', 0, 1)).toBeNull();
  });

  it('ages a "seconds since" value by the age of the scan it came from', () => {
    expect(agedSeconds(18, 5_000)).toBe(23);
    expect(agedSeconds(18, null)).toBe(18);
    expect(agedSeconds(18, -400)).toBe(18);
  });

  it('never turns an unknown silence into a number', () => {
    expect(agedSeconds(null, 5_000)).toBeNull();
    expect(agedSeconds(undefined, 5_000)).toBeNull();
    expect(agedSeconds(NaN, 5_000)).toBeNull();
    expect(agedSeconds('18', 5_000)).toBeNull();
  });

  it('gives the age of the last scan now, or null when there was none', () => {
    expect(scanAgeMs(3_000, 100, 1_100)).toBe(4_000);
    expect(scanAgeMs(null, 100, 1_100)).toBeNull();
    expect(scanAgeMs(NaN, 100, 1_100)).toBeNull();
    expect(scanAgeMs(-50, 100, 100)).toBe(0);
  });
});
