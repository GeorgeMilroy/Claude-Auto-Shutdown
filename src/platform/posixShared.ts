// What the Linux and macOS backends share: judging the result of a power command, holding a
// keep-awake child, countdown-alert text and sound timing, and a few validators.

import * as path from 'node:path';

import type { RunResult } from './exec';
import type { HeldProcess, PosixSystem } from './posixSystem';
import type {
  ActionResult,
  Capability,
  CountdownAlert,
  CountdownAlertOptions,
  HelperStatus,
  ProcDetail,
  ProcState,
} from './types';

export const APP_NAME = 'Claude Auto Shutdown';
export const QUERY_TIMEOUT_MS = 5_000;
export const ACTION_TIMEOUT_MS = 25_000;
/** A call that returns this much later than its own timeout allows was suspended in between. */
const SLEPT_MARGIN_MS = 5_000;
const KEEP_AWAKE_START_GRACE_MS = 500;
const KEEP_AWAKE_STOP_WAIT_MS = 2_000;
const FINAL_SOUNDS = 5;
const MAX_MESSAGE_CHARS = 300;

// ---------------------------------------------------------------------------------------------
// Small validators and text helpers
// ---------------------------------------------------------------------------------------------

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node errno code of a rejected fs call ('ENOENT', 'EACCES', ...); 'UNKNOWN' when there is none. */
export function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

/** Positive integer PIDs only, without duplicates. Anything else is dropped (= stays unknown). */
export function validPids(pids: unknown): number[] {
  if (!Array.isArray(pids)) return [];
  return [...new Set(pids.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0))];
}

/** ProcRow.name form: lower-case, no trailing '.exe'. */
export function normaliseProcessName(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

/** Lower-cased, non-empty detail names. An empty needle would match every process. */
export function detailNeedles(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  return names
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
}

export function containsAny(text: string | null, needles: readonly string[]): boolean {
  if (text === null) return false;
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

/** A detail with nothing readable in it. */
export function blankDetail(state: ProcState): ProcDetail {
  return { state, path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null };
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
  return line.trim().slice(0, MAX_MESSAGE_CHARS);
}

/** `fn` over `items` with at most `limit` running at once (a /proc scan must not exhaust file handles). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function helperStatusOf(state: {
  environmentProblem: string | null;
  processListProblem: string | null;
  idleProblem: string | null;
}): HelperStatus {
  const blocking = state.environmentProblem ?? state.processListProblem;
  if (blocking !== null) return { tier: 'unavailable', problem: blocking };
  if (state.idleProblem !== null) return { tier: 'limited', problem: state.idleProblem };
  return { tier: 'full', problem: null };
}

// ---------------------------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------------------------

export function exitedCleanly(result: RunResult): boolean {
  return result.started && !result.timedOut && result.code === 0;
}

export function describeRunFailure(tool: string, result: RunResult): string {
  if (!result.started) return `${tool} could not be started (${result.error ?? 'unknown error'})`;
  if (result.timedOut) return `${tool} did not answer in time`;
  const message = firstLine(result.stderr) || firstLine(result.stdout) || 'it gave no reason';
  return `${tool} failed with exit code ${result.code ?? 'none'}: ${message}`;
}

function quoteArgument(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/** The command line as it would be typed in a shell, for the activity log. */
export function formatCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteArgument).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Power actions
// ---------------------------------------------------------------------------------------------

export const NOTIFY_CAPABILITY: Capability = Object.freeze({ ok: true, detail: 'Nothing has to be run for a notification.' });

export const NOTIFY_RESULT: ActionResult = Object.freeze({
  ok: true,
  detail: 'Nothing to run: this mode only notifies.',
  command: null,
  exitCode: null,
  confirmed: null,
});

export const POWER_DISABLED_RESULT: ActionResult = Object.freeze({
  ok: false,
  detail: 'Power actions are switched off here (CLAUDE_AUTOSHUTDOWN_NO_POWER=1), so nothing was run.',
  command: null,
  exitCode: null,
  confirmed: null,
});

/** Tests and CI set this so that no code path can power off the machine it runs on. */
export function powerActionsDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_AUTOSHUTDOWN_NO_POWER === '1';
}

export function failedAction(detail: string, command: string | null = null, exitCode: number | null = null): ActionResult {
  return { ok: false, detail, command, exitCode, confirmed: null };
}

export function missingToolText(tool: string): string {
  return `${tool} was not found on this computer, so this can't be done from here.`;
}

export interface PowerCommand {
  file: string;
  args: readonly string[];
  /** The machine stops running while this takes effect (sleep, hibernate). */
  suspends: boolean;
  /** Plain-English result when it worked. */
  done: string;
  /** Even a clean exit does not show that the action happened (turning the display off is no lock). */
  neverConfirmed?: boolean;
}

export async function runPowerCommand(system: PosixSystem, command: PowerCommand, env: NodeJS.ProcessEnv): Promise<ActionResult> {
  const text = formatCommand(command.file, command.args);
  const result = await system.run(command.file, command.args, { timeoutMs: ACTION_TIMEOUT_MS, env });
  // The timeout stops the call after ACTION_TIMEOUT_MS of running time. A wall clock that moved
  // further than that means the machine was suspended in between: the action worked, whatever the
  // tool reports after waking up - the only case in which it is confirmed.
  if (command.suspends && result.started && result.elapsedMs > ACTION_TIMEOUT_MS + SLEPT_MARGIN_MS) {
    return { ok: true, detail: 'This computer went to sleep and has woken up again.', command: text, exitCode: result.code, confirmed: true };
  }
  if (exitedCleanly(result)) {
    return { ok: true, detail: command.done, command: text, exitCode: 0, confirmed: command.neverConfirmed === true ? false : null };
  }
  return failedAction(describeRunFailure(path.posix.basename(command.file), result), text, result.code);
}

// ---------------------------------------------------------------------------------------------
// Keep awake
// ---------------------------------------------------------------------------------------------

export type HoldCommand = { file: string; args: readonly string[] } | { problem: string };

export interface KeepAwakeOutcome {
  ok: boolean;
  detail: string;
}

/** One long-lived child that holds the OS's "don't sleep by yourself" request while it runs. */
export class KeepAwake {
  private readonly system: PosixSystem;
  private readonly command: () => HoldCommand;
  private readonly env: () => NodeJS.ProcessEnv;
  private held: HeldProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(system: PosixSystem, command: () => HoldCommand, env: () => NodeJS.ProcessEnv) {
    this.system = system;
    this.command = command;
    this.env = env;
  }

  /** Calls are applied one after another, so a quick on / off pair cannot leave a child behind. */
  set(on: boolean): Promise<KeepAwakeOutcome> {
    const outcome = this.queue
      .then(() => (on ? this.hold() : this.release()))
      .catch((error: unknown) => ({ ok: false, detail: `Keeping this computer awake failed: ${errorText(error)}` }));
    this.queue = outcome;
    return outcome;
  }

  private async hold(): Promise<KeepAwakeOutcome> {
    if (this.held !== null) return { ok: true, detail: 'Already keeping this computer awake.' };
    const command = this.command();
    if ('problem' in command) return { ok: false, detail: command.problem };
    const child = this.system.hold(command.file, command.args, this.env());
    // A refused inhibitor ends the child at once; one that is still running after the grace
    // period is holding the request.
    const early = await Promise.race([child.exited, this.system.delay(KEEP_AWAKE_START_GRACE_MS).then(() => null)]);
    if (early !== null) {
      const tool = path.posix.basename(command.file);
      const reason = firstLine(early.stderr) || `${tool} stopped at once (exit code ${early.code ?? 'none'})`;
      return { ok: false, detail: `Can't keep this computer awake: ${reason}` };
    }
    this.held = child;
    void child.exited.then(() => {
      if (this.held === child) this.held = null;
    });
    return { ok: true, detail: 'Keeping this computer awake while Claude works.' };
  }

  private async release(): Promise<KeepAwakeOutcome> {
    const child = this.held;
    if (child !== null) {
      this.held = null;
      child.stop();
      // Wait for the exit: the inhibitor is only gone once the child is, and a sleep requested
      // right after this must not be blocked by our own request.
      await Promise.race([child.exited, this.system.delay(KEEP_AWAKE_STOP_WAIT_MS)]);
    }
    return { ok: true, detail: 'This computer may go to sleep by itself again.' };
  }
}

// ---------------------------------------------------------------------------------------------
// Countdown alert
// ---------------------------------------------------------------------------------------------

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** 90 -> '1:30'. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${twoDigits(whole % 60)}`;
}

function formatTimeOfDay(epochMs: number): string {
  const time = new Date(epochMs);
  return `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}:${twoDigits(time.getSeconds())}`;
}

/** Whole seconds the alert runs for, rounded down: it never shows more time than remains. */
export function alertSeconds(options: CountdownAlertOptions): number {
  return Number.isFinite(options.seconds) && options.seconds > 0 ? Math.floor(options.seconds) : 0;
}

/**
 * When the countdown ends: fixed once, at the moment the alert is asked for. The time the
 * notification names, how long it stays and the warning sounds all work from this one deadline.
 */
export function alertDeadlineMs(options: CountdownAlertOptions, nowMs: number): number {
  return nowMs + alertSeconds(options) * 1000;
}

/**
 * A desktop notification cannot count down and may stay on screen after the countdown is over, so
 * it also names the wall-clock time: a stale one then explains itself.
 */
export function alertText(options: CountdownAlertOptions, nowMs: number): { title: string; body: string } {
  const deadlineMs = alertDeadlineMs(options, nowMs);
  return {
    title: `${options.title} ${formatClock((deadlineMs - nowMs) / 1000)}`,
    body: `${options.body}\nPlanned for ${formatTimeOfDay(deadlineMs)}. To cancel, go back to your editor.`,
  };
}

/** Milliseconds after the start at which the warning sound plays: at once, then each of the last 5 s. */
export function countdownSoundOffsetsMs(seconds: number): number[] {
  const offsets = [0];
  if (!Number.isFinite(seconds)) return offsets;
  for (let left = FINAL_SOUNDS; left >= 1; left--) {
    const at = Math.round((seconds - left) * 1000);
    if (at > 0) offsets.push(at);
  }
  return offsets;
}

/** Plays now and schedules the rest; the returned function cancels what has not played yet. */
export function scheduleCountdownSounds(seconds: number, play: () => void): () => void {
  const timers = countdownSoundOffsetsMs(seconds)
    .filter((at) => at > 0)
    .map((at) => {
      const timer = setTimeout(play, at);
      // A pending beep must never keep the extension host alive.
      if (typeof timer === 'object') timer.unref();
      return timer;
    });
  play();
  return () => timers.forEach((timer) => clearTimeout(timer));
}

/** An alert that shows nothing: its Cancel never fires. */
export function inertAlert(): CountdownAlert {
  return { onCancel: () => undefined, stop: () => undefined };
}
