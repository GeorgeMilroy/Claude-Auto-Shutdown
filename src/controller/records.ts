// The two small files the controller leaves for "the next start":
//
//   last-run.json  { testPassedOnce, lastResult, dismissed }  - what happened last time
//   watching.json  { armedAtMs, real, action, pid }           - exists exactly while watching
//
// A watching.json found at start means a window was watching and never got to end cleanly.
// Both files are read back as untrusted input: they are shown to the user and sent to every
// window, so every field is checked and anything unexpected is dropped.

import * as fs from 'node:fs';

import { POWER_ACTIONS } from '../shared/config';
import type { PowerAction } from '../shared/config';
import type { CancelReason, CancelVia, CountdownKind, LastResult, StopCause } from '../shared/protocol';
import type { StateDir } from '../shared/stateDir';

interface LastRunRecord {
  testPassedOnce: boolean;
  lastResult: LastResult | null;
  /** The user pressed "Got it" (or started watching again): keep the record, stop showing it. */
  dismissed: boolean;
}

export interface WatchRecord {
  armedAtMs: number | null;
  /** For real (not a test run). */
  real: boolean;
  action: PowerAction | null;
  pid: number | null;
}

const CANCEL_VIAS: readonly CancelVia[] = ['esc', 'button', 'statusBar', 'notification', 'osAlert', 'command'];
const COUNTDOWN_KINDS: readonly CountdownKind[] = ['real', 'test', 'preview'];
const STOP_CAUSES: readonly StopCause[] = [
  'user',
  'settingsChanged',
  'timeJump',
  'windowClosed',
  'lostControl',
  'editorRestarted',
  'afterAction',
];

export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** An unknown origin of a Cancel is still a Cancel: it becomes the generic 'command'. */
export function parseCancelVia(value: unknown): CancelVia {
  return oneOf(CANCEL_VIAS, value) ?? 'command';
}

export function parseCancelReason(raw: unknown): CancelReason | null {
  const source = asObject(raw);
  if (source === null) return null;
  const id = source.id;
  switch (id) {
    case 'user':
      return { id, via: parseCancelVia(source.via) };
    case 'sessionResumed':
      return typeof source.name === 'string' ? { id, name: source.name } : null;
    case 'checkFailed':
      return typeof source.check === 'string' ? { id, check: source.check } : null;
    case 'userCameBack':
    case 'settingsChanged':
    case 'timeJump':
    case 'leaderChanged':
    case 'emergencyStop':
    case 'stoppedWatching':
    case 'scanStale':
      return { id };
    default:
      return null;
  }
}

function parseHeldUpBy(raw: unknown): { name: string; seconds: number } | null {
  const source = asObject(raw);
  const seconds = finiteOrNull(source?.seconds);
  return source !== null && typeof source.name === 'string' && seconds !== null ? { name: source.name, seconds } : null;
}

export function parseLastResult(raw: unknown): LastResult | null {
  const source = asObject(raw);
  const atMs = finiteOrNull(source?.atMs);
  if (source === null || atMs === null) return null;
  const action = oneOf(POWER_ACTIONS, source.action);

  switch (source.kind) {
    case 'testPassed':
      if (action === null) return null;
      return {
        kind: 'testPassed',
        atMs,
        action,
        armedAtMs: finiteOrNull(source.armedAtMs),
        lastSessionFinishedAtMs: finiteOrNull(source.lastSessionFinishedAtMs),
        allClearAtMs: finiteOrNull(source.allClearAtMs),
        heldUpBy: parseHeldUpBy(source.heldUpBy),
      };
    case 'done':
      if (action === null) return null;
      return {
        kind: 'done',
        atMs,
        action,
        resumedAtMs: finiteOrNull(source.resumedAtMs),
        confirmed: typeof source.confirmed === 'boolean' ? source.confirmed : null,
      };
    case 'failed':
      if (action === null || typeof source.message !== 'string') return null;
      return { kind: 'failed', atMs, action, message: source.message };
    case 'cancelled': {
      const reason = parseCancelReason(source.reason);
      const countdownKind = oneOf(COUNTDOWN_KINDS, source.countdownKind);
      if (reason === null || countdownKind === null) return null;
      return { kind: 'cancelled', atMs, reason, stillWatching: source.stillWatching === true, countdownKind };
    }
    case 'stopped': {
      const cause = oneOf(STOP_CAUSES, source.cause);
      if (cause === null) return null;
      return {
        kind: 'stopped',
        atMs,
        cause,
        armedAtMs: finiteOrNull(source.armedAtMs),
        wasReal: source.wasReal === true,
      };
    }
    default:
      return null;
  }
}

function loadLastRun(stateDir: StateDir): LastRunRecord {
  const source = asObject(stateDir.readJson(stateDir.lastRunFile));
  return {
    testPassedOnce: source?.testPassedOnce === true,
    lastResult: parseLastResult(source?.lastResult),
    dismissed: source?.dismissed === true,
  };
}

const RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The last result, in memory and in last-run.json. Every change is written at once and
 * synchronously: the record of a shut down has to be on disk before the shut down happens.
 */
export class LastRunStore {
  private readonly stateDir: StateDir;
  private current: LastRunRecord = { testPassedOnce: false, lastResult: null, dismissed: false };

  constructor(stateDir: StateDir) {
    this.stateDir = stateDir;
  }

  /**
   * Reads last-run.json and returns the result exactly as it was stored. A result older than
   * 7 days is no longer shown. "Still watching" was true for the window that wrote it; it stays
   * true only when this window takes that watching over.
   */
  restore(nowMs: number, takingOver: boolean): LastResult | null {
    const stored = loadLastRun(this.stateDir);
    const result = stored.lastResult;
    this.current = stored;
    if (result === null) return null;
    const tooOld = !(nowMs - result.atMs < RESULT_MAX_AGE_MS);
    const lastResult: LastResult =
      result.kind === 'cancelled' && result.stillWatching && !takingOver ? { ...result, stillWatching: false } : result;
    this.current = { testPassedOnce: stored.testPassedOnce, lastResult, dismissed: stored.dismissed || tooOld };
    return result;
  }

  /** The result on show; a dismissed one stays in the file but is not displayed. */
  get shown(): LastResult | null {
    return this.current.dismissed ? null : this.current.lastResult;
  }

  /** The newest result, shown or not. */
  get latest(): LastResult | null {
    return this.current.lastResult;
  }

  get testPassedOnce(): boolean {
    return this.current.testPassedOnce;
  }

  record(result: LastResult): void {
    const testPassedOnce = this.current.testPassedOnce || result.kind === 'testPassed';
    this.current = { testPassedOnce, lastResult: result, dismissed: false };
    this.save();
  }

  dismiss(): void {
    if (this.shown === null) return;
    this.current = { ...this.current, dismissed: true };
    this.save();
  }

  private save(): void {
    this.stateDir.writeJson(this.stateDir.lastRunFile, this.current);
  }
}

/**
 * null = no watching.json. A file that exists but cannot be understood still proves that some
 * window was watching, so it comes back as a record with every field unknown.
 */
export function loadWatchRecord(stateDir: StateDir): WatchRecord | null {
  if (!fs.existsSync(stateDir.watchRecordFile)) return null;
  const source = asObject(stateDir.readJson(stateDir.watchRecordFile));
  return {
    armedAtMs: finiteOrNull(source?.armedAtMs),
    real: source?.real === true,
    action: oneOf(POWER_ACTIONS, source?.action),
    pid: finiteOrNull(source?.pid),
  };
}

export function saveWatchRecord(stateDir: StateDir, record: WatchRecord): void {
  stateDir.writeJson(stateDir.watchRecordFile, record);
}

export function removeWatchRecord(stateDir: StateDir): void {
  stateDir.remove(stateDir.watchRecordFile);
}
