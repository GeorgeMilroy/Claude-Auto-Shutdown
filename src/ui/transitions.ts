// One-shot things a window does when what it shows CHANGES: the countdown notification, the
// reveal of the dashboard, and the messages about a result. They are derived by comparing each
// snapshot with the one before - in every window alike, leader or follower - so a window that
// never saw a transition never announces it. Pure; notifications.ts shows the effects.

import type { PowerAction } from '../shared/config';
import type { CountdownKind, LastResult } from '../shared/protocol';
import { countdownToast, describeResult } from '../shared/text';
import { copy } from './copy';
import type { CommandId } from './ids';
import { announcedCountdown, isRecord, resultOf } from './snapshot';
import type { WindowSnapshot } from './snapshot';

export interface ToastAction {
  label: string;
  command: CommandId;
}

export type Effect =
  /** Show the cancellable countdown notification and reveal the dashboard (without taking focus). */
  | { kind: 'countdownStarted'; id: string; countdownKind: CountdownKind; message: string }
  /** Withdraw the countdown notification. */
  | { kind: 'countdownEnded' }
  /** A preview countdown ran and ended (walkthrough step). */
  | { kind: 'previewDone' }
  | { kind: 'toast'; level: 'info' | 'warning' | 'error'; message: string; action: ToastAction | null };

type Toast = Extract<Effect, { kind: 'toast' }>;

/** A result this fresh is news even to a window that has only just started. */
const RECENT_RESULT_MS = 30_000;

const SHOW_DASHBOARD: ToastAction = { label: copy.show, command: 'claudeAutoShutdown.open' };

/** Stops nobody needs explained: the user asked for it, or it followed the action. */
const QUIET_STOP_CAUSES: readonly string[] = ['user', 'afterAction'];

function resultKey(result: LastResult): string {
  // "Not confirmed" arrives as an update of a result already announced, and is worth a second message.
  const unconfirmed = result.kind === 'done' && result.confirmed === false;
  return `${result.kind}:${result.atMs}${unconfirmed ? ':unconfirmed' : ''}`;
}

function resultToast(result: LastResult, osName: string): Toast | null {
  const message = describeResult(result, osName).oneLine;
  switch (result.kind) {
    case 'testPassed':
      return { kind: 'toast', level: 'info', message, action: SHOW_DASHBOARD };
    case 'done':
      return { kind: 'toast', level: result.confirmed === false ? 'warning' : 'info', message, action: SHOW_DASHBOARD };
    case 'failed':
      return { kind: 'toast', level: 'error', message, action: { label: copy.showLog, command: 'claudeAutoShutdown.showLog' } };
    case 'cancelled':
      return { kind: 'toast', level: 'info', message, action: null };
    case 'stopped':
      if (QUIET_STOP_CAUSES.includes(result.cause)) return null;
      return { kind: 'toast', level: 'warning', message, action: SHOW_DASHBOARD };
    default:
      // A kind this version does not know: the dashboard says what can be said.
      return null;
  }
}

function osNameOf(snapshot: WindowSnapshot): string {
  const platform: unknown = snapshot.state?.platform;
  return isRecord(platform) && typeof platform.osName === 'string' ? platform.osName : '';
}

interface StartupRun {
  /** Identity of this run, so that it is announced once. */
  key: string;
  action: PowerAction;
}

/**
 * "Watching for real, started by the editor itself"; null when that is not the case.
 * A mode or action that cannot be read counts as real: the warning is the safe side.
 */
function startupRun(snapshot: WindowSnapshot): StartupRun | null {
  const { state } = snapshot;
  if (state === null || state.armed !== true || state.armedBy !== 'startup') return null;
  const contract: unknown = state.contract;
  const rules = isRecord(contract) ? contract : {};
  if (rules.testMode === true || rules.action === 'notify') return null;
  // An action this version does not know is worded by shared/text as one that acts on this PC.
  return { key: `${String(state.epoch)}:${String(state.armedAtMs)}`, action: rules.action as PowerAction };
}

export class TransitionTracker {
  private countdownId: string | null = null;
  private countdownKind: CountdownKind | null = null;
  private resultKey: string | null = null;
  private startupKey: string | null = null;
  private sawState = false;

  /** Effects of moving to `snapshot`. `nowMs` (wall clock) only decides what is shown, never logic. */
  next(snapshot: WindowSnapshot, nowMs: number): Effect[] {
    const effects: Effect[] = [...this.countdownEffects(snapshot, nowMs)];
    // Without a state nothing is known, so nothing is announced and nothing is forgotten: the
    // same result must not be announced again when contact comes back.
    if (snapshot.state === null) return effects;
    const result = this.resultEffect(snapshot, nowMs);
    if (result !== null) effects.push(result);
    const startup = this.startupEffect(snapshot);
    if (startup !== null) effects.push(startup);
    this.sawState = true;
    return effects;
  }

  private countdownEffects(snapshot: WindowSnapshot, nowMs: number): Effect[] {
    const { state } = snapshot;
    const countdown = announcedCountdown(state);
    const id = countdown?.id ?? null;
    if (id === this.countdownId) return [];
    const effects: Effect[] = [];
    if (this.countdownId !== null) {
      effects.push({ kind: 'countdownEnded' });
      // Losing contact is not the end of the preview; only a state that says so is.
      if (this.countdownKind === 'preview' && state !== null) effects.push({ kind: 'previewDone' });
    }
    if (countdown !== null && state !== null) {
      effects.push({
        kind: 'countdownStarted',
        id: countdown.id,
        countdownKind: countdown.kind,
        message: countdownToast(state, nowMs).message,
      });
    }
    this.countdownId = id;
    this.countdownKind = countdown?.kind ?? null;
    return effects;
  }

  private resultEffect(snapshot: WindowSnapshot, nowMs: number): Toast | null {
    const result = resultOf(snapshot.state);
    const key = result === null ? null : resultKey(result);
    const previousKey = this.resultKey;
    this.resultKey = key;
    if (result === null || key === previousKey) return null;
    // The first state a window gets may carry last night's result: that is the dashboard's to
    // show, not something that just happened.
    const happenedNow = this.sawState || Math.abs(nowMs - result.atMs) <= RECENT_RESULT_MS;
    return happenedNow ? resultToast(result, osNameOf(snapshot)) : null;
  }

  private startupEffect(snapshot: WindowSnapshot): Toast | null {
    const run = startupRun(snapshot);
    const previousKey = this.startupKey;
    this.startupKey = run?.key ?? null;
    if (run === null || run.key === previousKey) return null;
    return {
      kind: 'toast',
      level: 'warning',
      message: copy.watchingSinceStartup(run.action),
      action: { label: copy.stopWatching, command: 'claudeAutoShutdown.stop' },
    };
  }
}
