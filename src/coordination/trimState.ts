// The shared state has to fit in one message between windows (256 KB). A heavy user's state can
// outgrow that - dozens of sessions, each with subagents and child processes - and a state that is
// not sent at all leaves every other window at "can't tell" while the leader keeps watching. So the
// copy for the wire is trimmed, least useful detail first. Only display detail goes: the leader
// evaluates every check on the full scan, phase, countdown, contract, checks, stop and the last
// result always travel whole, and strays up to 20.

import type { Session } from '../core/types';
import type { UiState } from '../shared/protocol';
import { MAX_LINE_BYTES } from './framing';

/** Room left in a line for the message around the state (a welcome adds identity and proof). */
export const MAX_STATE_BYTES = MAX_LINE_BYTES - 16 * 1024;

const KEPT_SUBAGENTS = 3;
const KEPT_CHILDREN = 3;
const KEPT_STRAYS = 20;
const KEPT_ACTIVITY = 10;
const KEPT_ERRORS = 10;
const TEXT_CHARS = 300;

/** In order; each one only runs when the state still does not fit after the one before. */
const STEPS: readonly ((state: UiState) => UiState)[] = [capLists, capActivity, capErrors];

/**
 * `state` as it may go over the wire: unchanged when it fits in `maxBytes` of JSON, else the first
 * trimmed version that does. When not even that fits, the smallest one (no session rows at all),
 * which the caller may still find too large to send.
 */
export function trimForWire(state: UiState, maxBytes: number): UiState {
  if (sizeOf(state) <= maxBytes) return state;
  let trimmed = state;
  for (const step of STEPS) {
    trimmed = step(trimmed);
    if (sizeOf(trimmed) <= maxBytes) return trimmed;
  }
  return dropSessions(trimmed, maxBytes) ?? bareMinimum(trimmed);
}

/** Sessions and strays both list the busy processes below them as `children`. */
function capChildren<T extends object>(item: T): T {
  const { children } = item as { children?: unknown };
  return Array.isArray(children) && children.length > KEPT_CHILDREN
    ? { ...item, children: children.slice(0, KEPT_CHILDREN) }
    : item;
}

function capLists(state: UiState): UiState {
  const sessions = state.sessions.map((session) =>
    capChildren({ ...session, subagents: session.subagents.slice(0, KEPT_SUBAGENTS) }),
  );
  const strays = state.strays === null ? null : state.strays.slice(0, KEPT_STRAYS).map((stray) => capChildren(stray));
  return { ...state, sessions, strays };
}

function capActivity(state: UiState): UiState {
  const activity = state.activity.slice(-KEPT_ACTIVITY).map((entry) => ({ ...entry, text: cut(entry.text) }));
  return { ...state, activity };
}

function capErrors(state: UiState): UiState {
  return { ...state, scan: { ...state.scan, errors: state.scan.errors.slice(0, KEPT_ERRORS).map(cut) } };
}

/** The rows that explain why this PC stays on are the last to go. */
function isBlocking(session: Session): boolean {
  return !session.ignored && (session.working || session.status === 'working' || session.status === 'cantTell');
}

/** Sessions are dropped from the end of [blocking..., the rest...] until the state fits. */
function dropSessions(state: UiState, maxBytes: number): UiState | null {
  const ranked = [...state.sessions.filter(isBlocking), ...state.sessions.filter((session) => !isBlocking(session))];
  const total = state.sessions.length + state.sessionsOmitted;
  // Measured with the largest count it can carry, so the real one never adds a byte.
  let bytes = sizeOf({ ...state, sessions: [], sessionsOmitted: total });
  if (bytes > maxBytes) return null;
  const kept: Session[] = [];
  for (const session of ranked) {
    const more = sizeOf(session) + (kept.length > 0 ? 1 : 0);
    if (bytes + more > maxBytes) break;
    bytes += more;
    kept.push(session);
  }
  return { ...state, sessions: kept, sessionsOmitted: total - kept.length };
}

function bareMinimum(state: UiState): UiState {
  return {
    ...state,
    sessions: [],
    sessionsOmitted: state.sessions.length + state.sessionsOmitted,
    activity: [],
    remoteWindows: [],
    scan: { ...state.scan, roots: [] },
  };
}

function cut(text: string): string {
  return text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS - 1)}…` : text;
}

/** Bytes of JSON; a value that cannot be serialised never fits. */
function sizeOf(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
