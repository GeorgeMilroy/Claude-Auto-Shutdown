// Local time arithmetic. Messages carry DURATIONS (ms left, ms since the last scan), never wall
// clock deadlines; this window anchors each duration to its own monotonic clock (performance.now())
// at the moment the message arrived and counts from there.

import type { CountdownState } from '../shared/protocol';
import { countdownSeconds } from '../shared/text';
import { finite } from './guards';

export interface CountdownAnchor {
  id: string;
  /** Time left at `receivedAt`. */
  remainingAtReceiptMs: number;
  /** performance.now() when the state carrying it arrived. */
  receivedAt: number;
  /** Full length of the countdown; null when the leader did not say. */
  totalMs: number | null;
}

/** Milliseconds since `since`; never negative, and 0 when either clock value is unusable. */
export function elapsedMs(since: number, now: number): number {
  const elapsed = now - since;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/** Time left on this window's clock, clamped at 0. An unreadable value reads 0: "any moment now". */
export function remainingMs(anchor: CountdownAnchor, now: number): number {
  const left = anchor.remainingAtReceiptMs - elapsedMs(anchor.receivedAt, now);
  return Number.isFinite(left) && left > 0 ? left : 0;
}

/**
 * Anchors a published countdown to the local clock. While the SAME countdown keeps arriving the
 * display may only ever go down: a later message that claims more time than this window already
 * shows (network delay, a slow publish) is not allowed to hand seconds back.
 */
export function anchorCountdown(previous: CountdownAnchor | null, countdown: CountdownState, now: number): CountdownAnchor {
  const id = typeof countdown.id === 'string' ? countdown.id : '';
  const published = Math.max(0, finite(countdown.remainingMs) ?? 0);
  const total = finite(countdown.totalMs);
  const sameCountdown = previous !== null && previous.id === id;
  return {
    id,
    remainingAtReceiptMs: sameCountdown ? Math.min(published, remainingMs(previous, now)) : published,
    receivedAt: now,
    totalMs: total !== null && total > 0 ? total : null,
  };
}

/** Whole seconds shown on the digits, rounded like every other countdown surface (countdownSeconds). */
export function remainingSeconds(anchor: CountdownAnchor, now: number): number {
  return countdownSeconds(remainingMs(anchor, now));
}

/** Share of the countdown still left, 0..1, in whole-second steps; null when the length is unknown. */
export function remainingFraction(anchor: CountdownAnchor, now: number): number | null {
  if (anchor.totalMs === null) return null;
  return Math.min(1, (remainingSeconds(anchor, now) * 1000) / anchor.totalMs);
}

/** The digits turn to the error colour for the last seconds. */
export const URGENT_SECONDS = 10;

/** Screen readers get a polite update when the remaining time reaches one of these. */
export const ANNOUNCE_AT_SECONDS: readonly number[] = [60, 30, 10, 5];

/**
 * The announcement due when the clock moved from `previousSeconds` to `seconds`: the smallest mark
 * that was passed, so a tick that jumps several marks speaks only the most recent one. null = none.
 */
export function announcementDue(previousSeconds: number | null, seconds: number): number | null {
  if (previousSeconds === null || !Number.isFinite(previousSeconds) || !Number.isFinite(seconds)) return null;
  const passed = ANNOUNCE_AT_SECONDS.filter((mark) => previousSeconds > mark && seconds <= mark);
  return passed.length > 0 ? Math.min(...passed) : null;
}

/**
 * A duration published as "N ms from now" (time to the next check, cooldown left), on this
 * window's clock. null when the leader did not say.
 */
export function remainingOf(durationMs: unknown, receivedAt: number, now: number): number | null {
  const duration = finite(durationMs);
  if (duration === null) return null;
  return Math.max(0, duration - elapsedMs(receivedAt, now));
}

/**
 * A "seconds since" value from the last scan, brought forward to now. `sinceScanMs` is the age of
 * that scan. Unknown stays unknown.
 */
export function agedSeconds(seconds: unknown, sinceScanMs: number | null): number | null {
  const base = finite(seconds);
  if (base === null) return null;
  const extra = finite(sinceScanMs);
  return base + (extra !== null && extra > 0 ? extra / 1000 : 0);
}

/** Age of the last completed scan right now; null when no scan has completed. */
export function scanAgeMs(lastCompletedAgoMs: unknown, receivedAt: number, now: number): number | null {
  const atPublish = finite(lastCompletedAgoMs);
  if (atPublish === null) return null;
  return Math.max(0, atPublish) + elapsedMs(receivedAt, now);
}
