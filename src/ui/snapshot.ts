// What this window may show right now, and the few values every surface reads out of it.
//
// A state can come from a leader running another version of the extension (`limited`): the
// coordinator passes it on as soon as it is an object with a `phase`. Nothing deeper than that is
// taken on trust, so the readers here check each field, and an unreadable value is null.

import type { CountdownKind, LastResult, Role, UiState } from '../shared/protocol';
import { countdownSeconds } from '../shared/text';

export interface WindowSnapshot {
  role: Role;
  /**
   * Leader: its own controller's state. Follower: the state the leader pushed on the CURRENT
   * connection. null = no trustworthy state (electing, lost contact, isolated) - the previous one
   * is never kept.
   */
  state: UiState | null;
  /** The leader runs another protocol version: only Cancel and Stop watching work from here. */
  limited: boolean;
  /** performance.now() at which `state` was produced or received (anchors countdown.remainingMs). */
  receivedAtMono: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface CountdownView {
  id: string;
  kind: CountdownKind;
  /** Time left when the state was published; null = the state does not say. */
  remainingMs: number | null;
  totalMs: number | null;
  /** The final check after the countdown elapsed. */
  finalCheck: boolean;
}

/**
 * A countdown whose kind is missing is judged by the contract; any other kind - including one
 * this version does not know - is treated as the real thing.
 */
function countdownKind(kind: unknown, contract: unknown): CountdownKind {
  if (kind === 'test' || kind === 'preview') return kind;
  return kind === undefined && isRecord(contract) && contract.testMode === true ? 'test' : 'real';
}

/**
 * The countdown (or final check) this state says is running; null when there is none.
 * A phase that says "countdown" without the details still counts: its Cancel must stay reachable.
 */
export function countdownOf(state: UiState | null): CountdownView | null {
  if (state === null) return null;
  const raw: unknown = state.countdown;
  const finalCheck = state.phase === 'committing';
  if (!isRecord(raw) && state.phase !== 'countdown' && !finalCheck) return null;
  const source = isRecord(raw) ? raw : {};
  return {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : `phase:${String(state.phase)}`,
    kind: countdownKind(source.kind, state.contract),
    remainingMs: finite(source.remainingMs),
    totalMs: finite(source.totalMs),
    finalCheck,
  };
}

/** A countdown worth a notification: one with a deadline, not the final check of "just notify me". */
export function announcedCountdown(state: UiState | null): CountdownView | null {
  const countdown = countdownOf(state);
  if (countdown === null || state === null) return null;
  return isRecord(state.countdown) || state.phase === 'countdown' ? countdown : null;
}

/**
 * Whole seconds left on this window's clock: the published remainder minus the time since it
 * arrived, rounded the way every countdown surface rounds (countdownSeconds).
 * null = no countdown, or the state does not say how long is left.
 */
export function remainingSeconds(snapshot: WindowSnapshot, nowMono: number): number | null {
  const remainingMs = countdownOf(snapshot.state)?.remainingMs ?? null;
  if (remainingMs === null || !Number.isFinite(nowMono)) return null;
  const elapsedMs = Math.max(0, nowMono - snapshot.receivedAtMono);
  return countdownSeconds(remainingMs - elapsedMs);
}

function sooner(durationMs: unknown, ageMs: number): unknown {
  const duration = finite(durationMs);
  return duration === null ? durationMs : Math.max(0, duration - ageMs);
}

function longerAgo(agoMs: unknown, ageMs: number): unknown {
  const ago = finite(agoMs);
  return ago === null ? agoMs : ago + ageMs;
}

/**
 * The snapshot's state with its durations brought forward to `nowMono`.
 *
 * A state carries durations ("87 s left", "checked 3 s ago") that were true when it was published,
 * and whoever receives it anchors them to the moment of receipt. The dashboard page is a second
 * receiver, behind this window: handing it a state that has been waiting here for a while would
 * make it show more time than really remains. So the time the state spent in this window is
 * taken off before it is passed on.
 */
export function stateForNow(snapshot: WindowSnapshot, nowMono: number): UiState | null {
  const { state } = snapshot;
  if (state === null) return null;
  const ageMs = nowMono - snapshot.receivedAtMono;
  if (!(ageMs > 0)) return state;
  const countdown: unknown = state.countdown;
  const confirm: unknown = state.confirm;
  const scan: unknown = state.scan;
  const aged = {
    ...state,
    countdown: isRecord(countdown) ? { ...countdown, remainingMs: sooner(countdown.remainingMs, ageMs) } : countdown,
    cooldownRemainingMs: sooner(state.cooldownRemainingMs, ageMs),
    confirm: isRecord(confirm) ? { ...confirm, nextCheckInMs: sooner(confirm.nextCheckInMs, ageMs) } : confirm,
    scan: isRecord(scan) ? { ...scan, lastCompletedAgoMs: longerAgo(scan.lastCompletedAgoMs, ageMs) } : scan,
  };
  return aged as UiState;
}

/** The result on show, when it is at least an object that names its kind and time. */
export function resultOf(state: UiState | null): LastResult | null {
  const raw: unknown = state?.lastResult;
  if (!isRecord(raw) || typeof raw.kind !== 'string' || finite(raw.atMs) === null) return null;
  return raw as unknown as LastResult;
}

/** Only an explicit `false` says "not watching". Anything else may be watching. */
export function mayBeWatching(state: UiState | null): boolean {
  return state === null || state.armed !== false;
}
