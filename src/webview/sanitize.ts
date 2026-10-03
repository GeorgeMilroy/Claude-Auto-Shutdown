// Shape guard for everything the host posts into the webview.
//
// The view context comes from this window's own extension host. The STATE may come from a leader
// running another version of the extension (`view.limited`): the coordinator passes it on as soon
// as it is an object with a `phase`. A missing or ill-typed container must therefore never crash
// the dashboard - a crashed dashboard has no Cancel button. Containers are forced into the right
// shape here; leaves stay as they came and are read through guards.ts / shared/text.ts, which
// print "unknown" rather than trust them.

import type { Check, RootStatus, Session, StrayProcess, TranscriptEvent } from '../core/types';
import { toArmContract, validateConfig } from '../shared/config';
import type { ActivityEntry, RemoteWindow, Role, UiState, ViewContext } from '../shared/protocol';
import { finite, isRecord, recordsIn, stringsIn, text } from './guards';

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sanitizeCheck(raw: Record<string, unknown>): Check {
  return { ...raw, data: recordOrEmpty(raw.data) } as unknown as Check;
}

function sanitizeSession(raw: Record<string, unknown>, index: number): Session {
  return {
    ...raw,
    // The list key must be a usable string even when the leader sent none.
    key: text(raw.key) ?? `unnamed-${index}`,
    name: text(raw.name) ?? '',
    subagents: recordsIn(raw.subagents),
    children: recordsIn(raw.children),
    why: recordOrEmpty(raw.why),
  } as unknown as Session;
}

function sanitizeStray(raw: Record<string, unknown>): StrayProcess {
  return { ...raw, children: recordsIn(raw.children) } as unknown as StrayProcess;
}

function sanitizeScan(raw: unknown): UiState['scan'] {
  const source = recordOrEmpty(raw);
  return {
    engineActive: source.engineActive === true,
    lastCompletedAgoMs: finite(source.lastCompletedAgoMs),
    // Only an explicit `false` says the last scan can be trusted.
    stale: source.stale !== false,
    errors: stringsIn(source.errors),
    roots: recordsIn(source.roots) as unknown as RootStatus[],
  };
}

function sanitizePlatform(raw: unknown): UiState['platform'] {
  const source = recordOrEmpty(raw);
  return {
    ...source,
    osName: text(source.osName) ?? '',
    experimental: source.experimental === true,
    problem: text(source.problem),
    capability: isRecord(source.capability) ? source.capability : null,
    capabilities: recordOrEmpty(source.capabilities),
  } as unknown as UiState['platform'];
}

function sanitizeStop(raw: unknown): UiState['stop'] {
  const source = recordOrEmpty(raw);
  return { present: source.present === true, dir: text(source.dir) ?? '', auto: source.auto === true };
}

/** Sessions the leader counted but left out of the list to fit the wire. An older leader leaves none out. */
function omittedCount(raw: unknown): number {
  const count = finite(raw);
  return count === null ? 0 : Math.max(0, Math.floor(count));
}

/** null = nothing that can be rendered as a state (shown as "lost contact"). */
export function sanitizeState(raw: unknown): UiState | null {
  if (!isRecord(raw) || typeof raw.phase !== 'string') return null;
  const state = {
    ...raw,
    leader: recordOrEmpty(raw.leader),
    contract: recordOrEmpty(raw.contract),
    confirm: recordOrEmpty(raw.confirm),
    countdown: isRecord(raw.countdown) ? raw.countdown : null,
    checks: recordsIn(raw.checks).map(sanitizeCheck),
    sessions: recordsIn(raw.sessions).map(sanitizeSession),
    sessionsOmitted: omittedCount(raw.sessionsOmitted),
    // null and "not a list" both mean the process list is unknown.
    strays: Array.isArray(raw.strays) ? recordsIn(raw.strays).map(sanitizeStray) : null,
    remoteWindows: recordsIn(raw.remoteWindows) as unknown as RemoteWindow[],
    scan: sanitizeScan(raw.scan),
    platform: sanitizePlatform(raw.platform),
    stop: sanitizeStop(raw.stop),
    lastResult: isRecord(raw.lastResult) && typeof raw.lastResult.kind === 'string' ? raw.lastResult : null,
    activity: recordsIn(raw.activity) as unknown as ActivityEntry[],
  };
  return state as unknown as UiState;
}

const ROLES: readonly Role[] = ['electing', 'leader', 'follower', 'isolated'];

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * A view context that is safe to render whatever arrived. A broken plan becomes the validated
 * defaults (never a made-up action: validateConfig turns an unknown one into 'notify').
 */
export function sanitizeView(raw: unknown): ViewContext {
  const source = recordOrEmpty(raw);
  return {
    role: isRole(source.role) ? source.role : 'electing',
    limited: source.limited === true,
    plan: toArmContract(validateConfig(isRecord(source.plan) ? source.plan : {}).config),
    windowLabel: text(source.windowLabel) ?? '',
    unsavedFiles: Math.max(0, Math.floor(finite(source.unsavedFiles) ?? 0)),
    pending: source.pending === 'cancel' || source.pending === 'disarm' ? source.pending : null,
    autoStopSet: source.autoStopSet === true,
  };
}

const EVENT_SPEAKERS: readonly TranscriptEvent['who'][] = ['claude', 'you', 'system', 'other'];
const EVENT_KINDS: readonly TranscriptEvent['kind'][] = ['text', 'tool', 'result', 'thinking', 'other'];

function sanitizeEvent(raw: Record<string, unknown>): TranscriptEvent {
  const who = EVENT_SPEAKERS.find((speaker) => speaker === raw.who) ?? 'other';
  const kind = EVENT_KINDS.find((known) => known === raw.kind) ?? 'other';
  return {
    time: typeof raw.time === 'string' ? raw.time : '',
    who,
    sidechain: raw.sidechain === true,
    text: typeof raw.text === 'string' ? raw.text : '',
    kind,
  };
}

export function sanitizeEvents(raw: unknown): TranscriptEvent[] {
  return recordsIn(raw).map(sanitizeEvent);
}
