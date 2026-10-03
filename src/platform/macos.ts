// macOS backend: processes from /bin/ps, idle time from ioreg, power through pmset and System
// Events. Marked `experimental`.
//
// NOT RUN ON REAL HARDWARE. This backend was written and unit-tested on Windows, with no Mac
// available at any point. Every spawned tool goes through PosixSystem, and test/platform-posix
// drives the whole backend with fakes built from the documented output formats of ps, ioreg, pmset
// and osascript. Those formats, the Automation consent flow and the notification call are unverified
// until someone runs this on a Mac.

import * as path from 'node:path';

import type { PowerAction } from '../shared/config';
import type { PlatformOptions } from './index';
import {
  KeepAwake,
  NOTIFY_CAPABILITY,
  NOTIFY_RESULT,
  POWER_DISABLED_RESULT,
  QUERY_TIMEOUT_MS,
  alertDeadlineMs,
  alertText,
  blankDetail,
  containsAny,
  describeRunFailure,
  detailNeedles,
  errorText,
  exitedCleanly,
  failedAction,
  helperStatusOf,
  inertAlert,
  missingToolText,
  normaliseProcessName,
  powerActionsDisabled,
  runPowerCommand,
  scheduleCountdownSounds,
  validPids,
  type HoldCommand,
  type PowerCommand,
} from './posixShared';
import { createPosixSystem, sanitiseToolEnv, type PosixSystem } from './posixSystem';
import type {
  ActionResult,
  Capability,
  CountdownAlert,
  CountdownAlertOptions,
  ForeignRoot,
  HelperStatus,
  Platform,
  ProcDetail,
  ProcRow,
  SnapshotRequest,
  SystemSnapshot,
} from './types';

const PS = '/bin/ps';
const IOREG = '/usr/sbin/ioreg';
const PMSET = '/usr/bin/pmset';
const OSASCRIPT = '/usr/bin/osascript';
const CAFFEINATE = '/usr/bin/caffeinate';
const AFPLAY = '/usr/bin/afplay';
const ALERT_SOUND = '/System/Library/Sounds/Sosumi.aiff';

/**
 * pid, ppid, lstart, time, comm - without a header line. lstart is exactly five tokens; comm is last
 * because it is a path that may contain spaces. One -o per column on purpose: BSD ps may read
 * everything after the first '=' of a comma list ("pid=,ppid=,...") as the header text of pid.
 */
const PS_COLUMNS = ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'time=', '-o', 'comm='] as const;
const PS_MAX_BYTES = 8 * 1024 * 1024;
/** macOS PIDs stay below 100000, and ps refuses a whole -p list that contains a larger number. */
const MAC_PID_LIMIT = 99_999;
/** The consent dialog waits for the user; the answer is "not allowed yet" until they have clicked. */
const CONSENT_TIMEOUT_MS = 20_000;
const ALERT_TOOL_TIMEOUT_MS = 10_000;

const IDLE_PROBLEM = "Can't tell how long you've been away: macOS didn't report the idle time.";
const HIBERNATE_REFUSAL = 'macOS decides between sleep and hibernate itself; use Sleep.';
const SHUTDOWN_SCRIPT = 'tell application "System Events" to shut down';
/** Harmless: it only makes macOS ask for (or confirm) the Automation permission that shutting down needs. */
const CONSENT_SCRIPT = 'tell application "System Events" to get name';

// ---------------------------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------------------------

export interface PsRow {
  pid: number;
  ppid: number;
  /** null = the start time could not be parsed. */
  startEpochMs: number | null;
  /** null = the CPU time could not be parsed. */
  cpuSeconds: number | null;
  /** The comm column: the executable's path, or a bare name (or nothing) when ps could not read it. */
  command: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `lstart` under LC_ALL=C TZ=UTC: "Sat Oct  3 09:15:02 2026". Without those two variables the text
 * is localised and in local time, which is why ps is always run with both.
 */
export function parseLstartUtc(text: string): number | null {
  const match = /^\S+\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1] ?? '');
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  if (month < 0 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(Number(match[6]), month, day, hour, minute, second);
  // Date.UTC rolls an impossible day over into the next month; that is a parse error, not a date.
  return Number.isFinite(ms) && new Date(ms).getUTCDate() === day ? ms : null;
}

/** CPU time `[dd-][hh:]mm:ss[.cc]`: "0:00.03", "1:02:03.45", "2-03:04:05". Minutes may exceed 59. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const total = Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4]);
  return Number.isFinite(total) ? total : null;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)(?:\s+(\S.*?))?\s*$/;

/**
 * One row of `ps -o pid= -o ppid= -o lstart= -o time= -o comm=`. A start or CPU time that does not parse
 * leaves that field null (the process still counts as running); a line without a PID, a parent
 * PID, five date tokens and a CPU time is not a row at all.
 */
export function parsePsLine(line: string): PsRow | null {
  const match = PS_LINE.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) return null;
  return {
    pid,
    ppid,
    startEpochMs: parseLstartUtc(match[3] ?? ''),
    cpuSeconds: parseCpuTime(match[4] ?? ''),
    command: match[5] ?? '',
  };
}

/** `unparsed` counts non-empty lines that are not a process row: the list is then incomplete. */
export function parsePsOutput(stdout: string): { rows: PsRow[]; unparsed: number } {
  const rows: PsRow[] = [];
  let unparsed = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const row = parsePsLine(line);
    if (row === null) unparsed++;
    else rows.push(row);
  }
  return { rows, unparsed };
}

/** ProcRow.name: the file name of the command; a login shell shows as "-zsh". */
export function macProcessName(command: string): string {
  return normaliseProcessName(path.posix.basename(command).replace(/^-/, ''));
}

/**
 * The path is known only when ps printed an absolute one. startRaw and ioBytes do not exist on
 * macOS (nothing here is comparable with the registry's procStart), so they are null by design and
 * do not make a process 'partial'.
 */
export function macDetail(row: PsRow): ProcDetail {
  const exePath = row.command.startsWith('/') ? row.command : null;
  const complete = exePath !== null && row.startEpochMs !== null && row.cpuSeconds !== null;
  return {
    state: complete ? 'ok' : 'partial',
    path: exePath,
    startRaw: null,
    startEpochMs: row.startEpochMs,
    cpuSeconds: row.cpuSeconds,
    ioBytes: null,
  };
}

/**
 * `ioreg -r -c IOHIDSystem -k HIDIdleTime -d 1` prints `"HIDIdleTime" = <nanoseconds>`. BigInt:
 * the value passes 2^53 after 104 days. Several entries -> the smallest (the most recent input).
 */
export function parseHidIdleSeconds(stdout: string): number | null {
  let smallest: bigint | null = null;
  for (const match of stdout.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)) {
    const nanoseconds = BigInt(match[1] ?? '0');
    if (smallest === null || nanoseconds < smallest) smallest = nanoseconds;
  }
  return smallest === null ? null : Number(smallest / 1_000_000n) / 1000;
}

export type MacAction = 'shutdown' | 'sleep' | 'lock';

/**
 * macOS has no "force": System Events asks every app to quit, and an app with unsaved changes can
 * still refuse. Hibernate is absent on purpose (macOS chooses between sleep and hibernate itself).
 */
export function macPowerCommand(action: MacAction): PowerCommand {
  switch (action) {
    case 'shutdown':
      return { file: OSASCRIPT, args: ['-e', SHUTDOWN_SCRIPT], suspends: false, done: 'macOS accepted the shutdown request.' };
    case 'sleep':
      return { file: PMSET, args: ['sleepnow'], suspends: true, done: 'macOS accepted the sleep request.' };
    case 'lock':
      return {
        file: PMSET,
        args: ['displaysleepnow'],
        suspends: false,
        done: 'The display was turned off. macOS locks it only if it is set to ask for the password right away.',
        // Nothing here can see whether macOS asked for the password, so a lock is never confirmed.
        neverConfirmed: true,
      };
  }
}

/** `-w <pid>`: caffeinate ends by itself when the extension host does, so it can never be left behind. */
export function caffeinateArgs(pid: number): string[] {
  return ['-i', '-w', String(pid)];
}

/**
 * Title and body are handed over as arguments of the script's run handler instead of being pasted
 * into AppleScript source, so no text can break out of a string literal.
 */
export function notificationArgs(options: CountdownAlertOptions, nowMs: number): string[] {
  const text = alertText(options, nowMs);
  // osascript would read an argument that starts with '-' as one of its own options.
  const literal = (value: string): string => (value.startsWith('-') ? ` ${value}` : value);
  return [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e',
    'end run',
    literal(text.title),
    literal(text.body),
  ];
}

// ---------------------------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------------------------

interface ProcessTable {
  processes: ProcRow[] | null;
  details: Record<number, ProcDetail>;
  problem: string | null;
}

class MacPlatform implements Platform {
  readonly id = 'macos' as const;
  readonly osName = 'macOS';
  readonly procStartUnitsPerSecond = null;
  readonly experimental = true;

  private readonly system: PosixSystem;
  private readonly log: (message: string) => void;
  private readonly keepAwakeChild: KeepAwake;
  private readonly alertStops = new Set<() => void>();
  private processListProblem: string | null = null;
  private idleProblem: string | null = null;

  constructor(options: PlatformOptions, system: PosixSystem) {
    this.system = system;
    this.log = options.log;
    this.keepAwakeChild = new KeepAwake(system, () => this.caffeinateCommand(), () => this.toolEnv());
  }

  environmentProblem(): string | null {
    return null;
  }

  helperStatus(): HelperStatus {
    return helperStatusOf({
      environmentProblem: null,
      processListProblem: this.processListProblem,
      idleProblem: this.idleProblem,
    });
  }

  async snapshot(request: SnapshotRequest): Promise<SystemSnapshot> {
    const takenAtMs = this.system.now();
    try {
      const [idleSeconds, table] = await Promise.all([this.idleSeconds(), this.readProcessTable(request)]);
      return { takenAtMs, idleSeconds, ...table };
    } catch (error) {
      this.processListProblem = `Couldn't inspect the running programs: ${errorText(error)}`;
      return { takenAtMs, idleSeconds: null, processes: null, details: {}, problem: this.processListProblem };
    }
  }

  async probe(pids: number[]): Promise<Record<number, ProcDetail>> {
    const details: Record<number, ProcDetail> = {};
    const wanted = validPids(pids).filter((pid) => pid <= MAC_PID_LIMIT);
    if (wanted.length === 0) return details;
    try {
      // Our own PID rides along as a canary: it always exists, so an answer without it is not a
      // process list, and nothing may be called gone on the strength of it.
      const rows = await this.listProcesses(['-ww', ...PS_COLUMNS, '-p', [this.system.pid, ...wanted].join(',')]);
      if (typeof rows === 'string') return details;
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      for (const pid of wanted) {
        const row = byPid.get(pid);
        details[pid] = row === undefined ? blankDetail('gone') : macDetail(row);
      }
    } catch (error) {
      this.log(`macos: probe failed: ${errorText(error)}`);
    }
    return details;
  }

  async idleSeconds(): Promise<number | null> {
    let seconds: number | null = null;
    try {
      seconds = await this.readIdle();
    } catch (error) {
      this.log(`macos: idle query failed: ${errorText(error)}`);
    }
    this.idleProblem = seconds === null ? IDLE_PROBLEM : null;
    return seconds;
  }

  async capability(action: PowerAction): Promise<Capability> {
    try {
      switch (action) {
        case 'notify':
          return NOTIFY_CAPABILITY;
        case 'hibernate':
          return { ok: false, detail: HIBERNATE_REFUSAL };
        case 'sleep':
          return this.system.exists(PMSET) ? { ok: true, detail: 'Allowed by macOS.' } : { ok: false, detail: missingToolText('pmset') };
        case 'lock':
          return this.system.exists(PMSET)
            ? { ok: true, detail: 'Best effort: turns the display off. macOS locks it only if it is set to ask for the password right away.' }
            : { ok: false, detail: missingToolText('pmset') };
        case 'shutdown':
          return await this.shutdownCapability();
        default:
          return { ok: null, detail: 'Unknown action.' };
      }
    } catch (error) {
      return { ok: null, detail: `Couldn't find out whether macOS allows it: ${errorText(error)}` };
    }
  }

  async execute(action: PowerAction, _options: { force: boolean }): Promise<ActionResult> {
    if (action === 'notify') return NOTIFY_RESULT;
    if (powerActionsDisabled(this.system.env)) return POWER_DISABLED_RESULT;
    try {
      switch (action) {
        case 'hibernate':
          return failedAction(HIBERNATE_REFUSAL);
        case 'shutdown':
        case 'sleep':
        case 'lock':
          return await this.runPower(macPowerCommand(action));
        default:
          return failedAction('Unknown action; nothing was run.');
      }
    } catch (error) {
      return failedAction(`The action could not be run: ${errorText(error)}`);
    }
  }

  keepAwake(on: boolean): Promise<{ ok: boolean; detail: string }> {
    return this.keepAwakeChild.set(on === true);
  }

  startCountdownAlert(options: CountdownAlertOptions): CountdownAlert {
    try {
      return this.showAlert(options);
    } catch (error) {
      this.log(`macos: countdown alert failed: ${errorText(error)}`);
      return inertAlert();
    }
  }

  foreignRoots(): Promise<{ roots: ForeignRoot[]; problem: string | null }> {
    return Promise.resolve({ roots: [], problem: null });
  }

  async dispose(): Promise<void> {
    for (const stop of [...this.alertStops]) stop();
    await this.keepAwakeChild.set(false);
  }

  // -- processes -------------------------------------------------------------------------------

  /** Rows of one ps call, or the reason it cannot be trusted as a process list. */
  private async listProcesses(args: readonly string[]): Promise<PsRow[] | string> {
    if (!this.system.exists(PS)) return 'ps was not found';
    const result = await this.system.run(PS, args, { timeoutMs: QUERY_TIMEOUT_MS, env: this.psEnv(), maxBytes: PS_MAX_BYTES });
    if (!exitedCleanly(result)) return describeRunFailure('ps', result);
    const { rows, unparsed } = parsePsOutput(result.stdout);
    if (unparsed > 0) return `${unparsed} ${unparsed === 1 ? 'line' : 'lines'} of the ps output could not be understood`;
    if (!rows.some((row) => row.pid === this.system.pid)) return 'the ps output does not list this program itself';
    return rows;
  }

  private async readProcessTable(request: SnapshotRequest): Promise<ProcessTable> {
    const rows = await this.listProcesses(['-axww', ...PS_COLUMNS]);
    if (typeof rows === 'string') {
      // Without a trustworthy list nothing can be called gone: details stay empty (= unknown).
      this.processListProblem = `Couldn't read the list of running programs (${rows}).`;
      return { processes: null, details: {}, problem: this.processListProblem };
    }
    this.processListProblem = null;

    const wanted = new Set(validPids(request.detailPids));
    const needles = detailNeedles(request.detailNames);
    const processes: ProcRow[] = [];
    const details: Record<number, ProcDetail> = {};
    for (const row of rows) {
      const name = macProcessName(row.command);
      processes.push({ pid: row.pid, ppid: row.ppid, name });
      if (wanted.has(row.pid) || containsAny(name, needles) || containsAny(row.command, needles)) details[row.pid] = macDetail(row);
    }
    // A complete list that does not contain a requested PID proves that process is gone.
    for (const pid of wanted) details[pid] ??= blankDetail('gone');
    return { processes, details, problem: null };
  }

  // -- idle ------------------------------------------------------------------------------------

  private async readIdle(): Promise<number | null> {
    if (!this.system.exists(IOREG)) return null;
    const args = ['-r', '-c', 'IOHIDSystem', '-k', 'HIDIdleTime', '-d', '1'];
    const result = await this.system.run(IOREG, args, { timeoutMs: QUERY_TIMEOUT_MS, env: this.toolEnv() });
    if (!exitedCleanly(result)) return null;
    const seconds = parseHidIdleSeconds(result.stdout);
    return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  // -- power -----------------------------------------------------------------------------------

  /**
   * Shutting down goes through System Events, which needs the user's Automation consent. Asking a
   * harmless question now makes macOS show that dialog while the user is still here; at 3 AM
   * nobody would answer it and the shutdown would fail.
   */
  private async shutdownCapability(): Promise<Capability> {
    if (!this.system.exists(OSASCRIPT)) return { ok: false, detail: missingToolText('osascript') };
    const result = await this.system.run(OSASCRIPT, ['-e', CONSENT_SCRIPT], { timeoutMs: CONSENT_TIMEOUT_MS, env: this.toolEnv() });
    if (exitedCleanly(result)) {
      return { ok: true, detail: 'Allowed by macOS. An app with unsaved changes can still stop the shutdown.' };
    }
    if (result.timedOut) {
      return { ok: false, detail: 'macOS is asking whether this editor may control System Events. Allow it, then try again.' };
    }
    return {
      ok: false,
      detail: `macOS doesn't let this editor control System Events, which shutting down needs. Allow it under System Settings > Privacy & Security > Automation. (${describeRunFailure('osascript', result)})`,
    };
  }

  private async runPower(command: PowerCommand): Promise<ActionResult> {
    if (!this.system.exists(command.file)) return failedAction(missingToolText(path.posix.basename(command.file)));
    return runPowerCommand(this.system, command, this.toolEnv());
  }

  private caffeinateCommand(): HoldCommand {
    if (!this.system.exists(CAFFEINATE)) return { problem: "Can't keep this computer awake: caffeinate was not found." };
    return { file: CAFFEINATE, args: caffeinateArgs(this.system.pid) };
  }

  // -- countdown alert -------------------------------------------------------------------------

  private showAlert(options: CountdownAlertOptions): CountdownAlert {
    const toolOptions = { timeoutMs: ALERT_TOOL_TIMEOUT_MS, env: this.toolEnv() };
    const nowMs = this.system.now();
    const secondsLeft = (alertDeadlineMs(options, nowMs) - nowMs) / 1000;
    if (this.system.exists(OSASCRIPT)) void this.system.run(OSASCRIPT, notificationArgs(options, nowMs), toolOptions);
    else this.log('macos: osascript was not found, no countdown notification');

    const canPlay = options.sound === true && this.system.exists(AFPLAY) && this.system.exists(ALERT_SOUND);
    const cancelSounds = canPlay
      ? scheduleCountdownSounds(secondsLeft, () => void this.system.run(AFPLAY, [ALERT_SOUND], toolOptions))
      : () => undefined;
    const stop = (): void => {
      cancelSounds();
      this.alertStops.delete(stop);
    };
    this.alertStops.add(stop);
    // A macOS notification has no Cancel button here, so onCancel never fires.
    return { onCancel: () => undefined, stop };
  }

  // -- tools -----------------------------------------------------------------------------------

  private toolEnv(): NodeJS.ProcessEnv {
    return sanitiseToolEnv(this.system.env);
  }

  /** ps prints dates in the user's language and time zone unless both are pinned. */
  private psEnv(): NodeJS.ProcessEnv {
    return { ...this.toolEnv(), LC_ALL: 'C', TZ: 'UTC' };
  }
}

/** `system` is the test seam; production uses the real file system and child processes. */
export function createMacPlatform(options: PlatformOptions, system: PosixSystem = createPosixSystem()): Platform {
  return new MacPlatform(options, system);
}
