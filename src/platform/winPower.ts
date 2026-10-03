// Windows power actions. Each one is a single one-shot system binary, started by absolute
// System32 path with an args array and no shell - never through the long-lived (read-only) helper.
//
// The command line of every action comes from a pure function and the process runner is injected,
// so all of this is tested without anything ever being run.

import * as path from 'node:path';
import { POWER_ACTIONS, type PowerAction } from '../shared/config';
import type { RunOptions, RunResult } from './exec';
import type { ActionResult } from './types';

export type RunFn = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

export type RealPowerAction = Exclude<PowerAction, 'notify'>;

export interface PowerCommand {
  file: string;
  args: string[];
}

export const NO_POWER_ENV = 'CLAUDE_AUTOSHUTDOWN_NO_POWER';

export const ACTION_TIMEOUT_MS = 25_000;
/** A sleep / hibernate command that fails does so at once; one that works returns after resume. */
export const EARLY_EXIT_MS = 5_000;
const LOCK_CONFIRM_ATTEMPTS = 6;
const LOCK_CONFIRM_INTERVAL_MS = 500;

/**
 * Sleep through the framework's own wrapper instead of `rundll32 powrprof.dll,SetSuspendState`:
 * rundll32 passes a window handle and a command-line pointer where the function expects three
 * booleans, which hibernates the PC whenever hibernation is enabled. This loads a framework
 * assembly (no compiler involved) and exits non-zero at once when Windows refuses.
 */
export const SLEEP_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false)) { exit 0 } else { exit 1 }";

/** Absolute path below <SystemRoot>\System32. Always Windows path rules, whatever OS runs the tests. */
export function system32Path(systemRoot: string, ...segments: string[]): string {
  return path.win32.join(systemRoot, 'System32', ...segments);
}

export function powershellPath(systemRoot: string): string {
  return system32Path(systemRoot, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function buildPowerCommand(action: RealPowerAction, options: { force: boolean }, systemRoot: string): PowerCommand {
  switch (action) {
    case 'shutdown':
      // "/t 0" does not imply "/f": without it one app with an unsaved document keeps the PC on.
      return { file: system32Path(systemRoot, 'shutdown.exe'), args: ['/s', '/t', '0', ...(options.force === true ? ['/f'] : [])] };
    case 'hibernate':
      return { file: system32Path(systemRoot, 'shutdown.exe'), args: ['/h'] };
    case 'sleep':
      return { file: powershellPath(systemRoot), args: ['-NoProfile', '-NonInteractive', '-Command', SLEEP_SCRIPT] };
    case 'lock':
      return { file: system32Path(systemRoot, 'rundll32.exe'), args: ['user32.dll,LockWorkStation'] };
    default:
      throw new Error(`no power command for action ${String(action)}`);
  }
}

/** The command as one line for the activity log. */
export function formatCommandLine(command: PowerCommand): string {
  return [command.file, ...command.args].map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ');
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line ? line.slice(0, 300) : '';
}

const ACTION_VERB: Record<RealPowerAction, string> = {
  shutdown: 'shut down',
  hibernate: 'hibernate',
  sleep: 'sleep',
  lock: 'lock',
};

/**
 * Reads the outcome of a power command. Pure.
 *
 * Sleep and hibernate return only after the PC wakes up, and Node's timers keep counting while it
 * sleeps - so on resume the timeout has always "expired". For those two actions only an immediate
 * non-zero exit is a failure; a timeout, or an exit long after the start, means the PC slept.
 *
 * `confirmed`: only a call that ran longer than its own timeout allows shows that the PC was
 * suspended meanwhile (true). A suspend still running at the timeout without that gap was watched
 * by a PC that stayed awake (false). Anything else proves nothing either way (null).
 */
export function interpretPowerResult(action: RealPowerAction, result: RunResult, commandLine: string): ActionResult {
  const verb = ACTION_VERB[action];
  const suspends = action === 'sleep' || action === 'hibernate';
  const state = action === 'sleep' ? 'sleep' : 'hibernation';
  const slept = suspends && result.elapsedMs > ACTION_TIMEOUT_MS + EARLY_EXIT_MS;
  const failure = (detail: string): ActionResult => ({ ok: false, detail, command: commandLine, exitCode: result.code, confirmed: null });
  const success = (detail: string, confirmed: boolean | null = slept ? true : null): ActionResult => ({
    ok: true,
    detail,
    command: commandLine,
    exitCode: result.code,
    confirmed,
  });
  const seconds = Math.round(result.elapsedMs / 1000);

  if (!result.started) {
    return { ok: false, detail: `Couldn't start the command to ${verb} this PC: ${result.error ?? 'unknown error'}.`, command: commandLine, exitCode: null, confirmed: null };
  }
  if (result.timedOut) {
    if (!suspends) return failure(`Windows didn't answer the command to ${verb} this PC within ${ACTION_TIMEOUT_MS / 1000} seconds.`);
    return slept
      ? success(`This PC went to ${state} and has woken up again.`)
      : success(`The command to ${verb} this PC was still running after ${seconds} seconds, and nothing showed that this PC went to ${state}.`, false);
  }
  if (result.code === 0) {
    return success(suspends && result.elapsedMs > EARLY_EXIT_MS ? `This PC went to ${state} and has woken up again.` : `Windows accepted the command to ${verb} this PC.`);
  }
  if (result.code === null) {
    return failure(`The command to ${verb} this PC stopped unexpectedly${result.error ? `: ${result.error}` : ''}.`);
  }
  if (suspends && result.elapsedMs > EARLY_EXIT_MS) {
    return success(`The command to ${verb} this PC ended with code ${result.code} after ${seconds} seconds. Only an immediate refusal counts as a failure, so this PC most likely slept.`);
  }
  const message = firstLine(result.stderr) || firstLine(result.stdout) || 'no message';
  return failure(`Windows refused to ${verb} this PC: ${message} (exit code ${result.code}).`);
}

export interface PowerDeps {
  /** Read at call time; CLAUDE_AUTOSHUTDOWN_NO_POWER=1 refuses everything. */
  env: NodeJS.ProcessEnv;
  /** %SystemRoot%; null = unknown, nothing can be run. */
  systemRoot: string | null;
  run: RunFn;
  /** Lower-case names of the running processes (no '.exe'); null = the list could not be read. */
  processNames(): Promise<string[] | null>;
  delay(ms: number): Promise<void>;
}

/** rundll32 exits 0 whatever happens, so a lock is confirmed by the lock screen's own process. */
async function confirmLock(deps: PowerDeps): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_CONFIRM_ATTEMPTS; attempt++) {
    await deps.delay(LOCK_CONFIRM_INTERVAL_MS);
    const names = await deps.processNames();
    if (names?.includes('logonui')) return true;
  }
  return false;
}

function isPowerAction(value: unknown): value is PowerAction {
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value);
}

/** Performs `action`. Never rejects; refuses when power actions are disabled for this process. */
export async function executePowerAction(action: PowerAction, options: { force: boolean }, deps: PowerDeps): Promise<ActionResult> {
  const refused = (detail: string): ActionResult => ({ ok: false, detail, command: null, exitCode: null, confirmed: null });
  if (!isPowerAction(action)) return refused('Unknown action; nothing was done.');
  if (action === 'notify') return { ok: true, detail: 'Nothing was done to this PC.', command: null, exitCode: null, confirmed: null };
  if (deps.env[NO_POWER_ENV] === '1') return refused(`Power actions are switched off for this process (${NO_POWER_ENV}=1); nothing was done.`);
  if (!deps.systemRoot) return refused("Windows didn't say where it is installed (SystemRoot is not set); nothing was done.");

  const command = buildPowerCommand(action, { force: options?.force === true }, deps.systemRoot);
  const commandLine = formatCommandLine(command);
  try {
    const result = await deps.run(command.file, command.args, { timeoutMs: ACTION_TIMEOUT_MS });
    const outcome = interpretPowerResult(action, result, commandLine);
    if (action !== 'lock' || !outcome.ok) return outcome;
    const confirmed = await confirmLock(deps);
    return { ...outcome, detail: confirmed ? 'This PC is locked.' : "The lock command was sent, but Windows didn't confirm that this PC locked.", confirmed };
  } catch (error) {
    return { ok: false, detail: `Couldn't ${ACTION_VERB[action]} this PC: ${error instanceof Error ? error.message : String(error)}.`, command: commandLine, exitCode: null, confirmed: null };
  }
}
