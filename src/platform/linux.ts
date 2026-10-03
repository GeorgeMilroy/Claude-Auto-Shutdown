// Linux backend: /proc is read directly (no child process per scan), idle time comes from the
// desktop (GNOME Mutter, xprintidle on X11, logind as a coarse last resort), power goes through
// systemd-logind.
//
// NOT RUN ON REAL HARDWARE. This backend was written and unit-tested on Windows. Every file read
// and every spawned tool goes through PosixSystem, and test/platform-posix drives the whole backend
// with fakes built from the documented /proc formats and tool replies. Nothing in this file has
// executed against a real /proc, D-Bus or logind yet: the first run on a Linux desktop is part of
// its verification.

import * as path from 'node:path';

import type { PowerAction } from '../shared/config';
import type { PlatformOptions } from './index';
import {
  ACTION_TIMEOUT_MS,
  APP_NAME,
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
  errnoCode,
  errorText,
  exitedCleanly,
  failedAction,
  formatCommand,
  helperStatusOf,
  inertAlert,
  mapLimit,
  missingToolText,
  normaliseProcessName,
  powerActionsDisabled,
  runPowerCommand,
  scheduleCountdownSounds,
  validPids,
  type HoldCommand,
  type PowerCommand,
} from './posixShared';
import { createPosixSystem, findTool, sanitiseToolEnv, type PosixSystem } from './posixSystem';
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

const PROC = '/proc';
/** USER_HZ: 100 on every architecture an editor runs on; `getconf CLK_TCK` confirms it. */
const DEFAULT_CLOCK_TICKS = 100;
/** The kernel keeps 15 bytes of a process name (TASK_COMM_LEN - 1). */
const COMM_MAX_BYTES = 15;
const READ_CONCURRENCY = 64;
const BOOT_TIME_TTL_MS = 60_000;
const IDLE_SOURCE_RETRY_MS = 60_000;
const LOCK_CONFIRM_ATTEMPTS = 6;
const LOCK_CONFIRM_INTERVAL_MS = 500;
const ALERT_TOOL_TIMEOUT_MS = 10_000;

export const FLATPAK_PROBLEM = "VS Code runs inside Flatpak, so other programs on this PC can't be seen.";
const IDLE_PROBLEM = "Can't tell how long you've been away: this desktop doesn't report idle time (needs GNOME, xprintidle on X11, or logind).";

// ---------------------------------------------------------------------------------------------
// /proc parsing (pure)
// ---------------------------------------------------------------------------------------------

/** What reading one /proc file gave: its text, or the errno code of the failure. */
export type ReadOutcome = { ok: true; value: string } | { ok: false; code: string };

export interface ProcStat {
  /** Process name as the kernel keeps it: at most 15 bytes, may contain spaces and parentheses. */
  comm: string;
  /** One letter: R, S, D, I, T, ... ; Z and X mean the process has exited. */
  state: string;
  ppid: number | null;
  /** utime + stime, in clock ticks. */
  cpuTicks: number | null;
  /** starttime: clock ticks since boot, exactly as the kernel printed it. */
  startTicks: string | null;
}

function wholeNumber(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * One line of /proc/<pid>/stat. The name sits in parentheses and may itself contain spaces and
 * parentheses ("(sd-pam)", "Web Content"), so the fields are counted from the LAST ')': splitting
 * the whole line on spaces would shift them and read garbage as the start time.
 * null = not a stat line at all. A line that is cut short keeps what it has; the rest is null.
 */
export function parseProcStat(raw: string): ProcStat | null {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open || !/^\s*\d+\s*$/.test(raw.slice(0, open))) return null;
  // The tail starts at field 3 (state), so field N is tail[N - 3].
  const tail = raw.slice(close + 1).trim().split(/\s+/);
  const state = tail[0];
  if (state === undefined || !/^[A-Za-z]$/.test(state)) return null;
  const utime = wholeNumber(tail[11]);
  const stime = wholeNumber(tail[12]);
  return {
    comm: raw.slice(open + 1, close),
    state,
    ppid: wholeNumber(tail[1]),
    cpuTicks: utime !== null && stime !== null ? utime + stime : null,
    startTicks: tail[19] !== undefined && /^\d+$/.test(tail[19]) ? tail[19] : null,
  };
}

/** Zombie (Z) or dead (X / x): the PID is still listed, but nothing is running. */
export function hasExited(state: string): boolean {
  return state === 'Z' || state === 'X' || state === 'x';
}

/** `btime` (boot time, epoch seconds) from /proc/stat. */
export function parseBootTimeSeconds(procStat: string): number | null {
  const match = /^btime\s+(\d+)\s*$/m.exec(procStat);
  return match ? wholeNumber(match[1]) : null;
}

/** rchar + wchar from /proc/<pid>/io: every byte the process read or wrote, files and pipes alike. */
export function parseProcIo(raw: string): number | null {
  const read = /^rchar:\s*(\d+)\s*$/m.exec(raw);
  const written = /^wchar:\s*(\d+)\s*$/m.exec(raw);
  if (!read || !written) return null;
  const total = Number(read[1]) + Number(written[1]);
  return Number.isFinite(total) ? total : null;
}

/** Output of `getconf CLK_TCK`. */
export function parseClockTicks(stdout: string): number | null {
  const ticks = wholeNumber(stdout.trim());
  return ticks !== null && ticks >= 1 && ticks <= 1_000_000 ? ticks : null;
}

/** The exe link of a binary that was replaced on disk (Claude updates itself) ends in " (deleted)". */
export function cleanExePath(link: string): string {
  const suffix = ' (deleted)';
  return link.endsWith(suffix) ? link.slice(0, -suffix.length) : link;
}

export function commMayBeTruncated(comm: string): boolean {
  return Buffer.byteLength(comm, 'utf8') >= COMM_MAX_BYTES;
}

/**
 * ProcRow.name. The kernel cuts comm at 15 bytes, so a keep-on pattern such as
 * `blender-softwaregl` would never match it. When comm is at that limit and the file name of
 * argv[0] continues it, that longer name is the real one. Shorter comms are complete and are kept
 * as they are: a program that rewrites its own title ("nginx: worker process") must not rename it.
 */
export function chooseProcessName(comm: string, cmdline: string | null): string {
  if (cmdline !== null && commMayBeTruncated(comm)) {
    const argv0 = cmdline.split('\0', 1)[0] ?? '';
    const fileName = path.posix.basename(argv0);
    if (fileName.length > comm.length && fileName.startsWith(comm)) return normaliseProcessName(fileName);
  }
  return normaliseProcessName(comm);
}

export interface LinuxClock {
  ticksPerSecond: number;
  /** Boot time in epoch seconds; null = /proc/stat could not be read. */
  bootTimeSeconds: number | null;
}

export interface ProcSources {
  stat: ReadOutcome;
  /** /proc/<pid>/exe; null = not attempted. */
  exe: ReadOutcome | null;
  /** /proc/<pid>/io; null = not attempted. */
  io: ReadOutcome | null;
}

function vanished(code: string): boolean {
  return code === 'ENOENT' || code === 'ESRCH';
}

function startEpochMs(startTicks: string | null, clock: LinuxClock): number | null {
  if (startTicks === null || clock.bootTimeSeconds === null) return null;
  const ms = Math.round((clock.bootTimeSeconds + Number(startTicks) / clock.ticksPerSecond) * 1000);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What /proc says about one PID.
 * - gone only when the kernel itself says "no such process" (ENOENT / ESRCH on stat);
 * - exited for a zombie: its start time still matches the registry, but it is not a live session;
 * - any other failure leaves the process alive-but-unknown (denied / partial), never dead. In
 *   particular an unreadable exe link is NOT replaced by the comm name: path stays null.
 * ioBytes is optional detail (only the owner may read it) and does not make a process 'partial'.
 */
export function buildLinuxDetail(sources: ProcSources, clock: LinuxClock): ProcDetail {
  if (!sources.stat.ok) return blankDetail(vanished(sources.stat.code) ? 'gone' : 'denied');
  const stat = parseProcStat(sources.stat.value);
  if (stat === null) return blankDetail('partial');

  const startedMs = startEpochMs(stat.startTicks, clock);
  const cpuSeconds = stat.cpuTicks === null ? null : stat.cpuTicks / clock.ticksPerSecond;
  if (hasExited(stat.state)) {
    return { state: 'exited', path: null, startRaw: stat.startTicks, startEpochMs: startedMs, cpuSeconds, ioBytes: null };
  }
  const exePath = sources.exe?.ok && sources.exe.value !== '' ? cleanExePath(sources.exe.value) : null;
  const complete = exePath !== null && stat.startTicks !== null && startedMs !== null && cpuSeconds !== null;
  return {
    state: complete ? 'ok' : 'partial',
    path: exePath,
    startRaw: stat.startTicks,
    startEpochMs: startedMs,
    cpuSeconds,
    ioBytes: sources.io?.ok ? parseProcIo(sources.io.value) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Idle time (pure)
// ---------------------------------------------------------------------------------------------

/** busctl reply to GetIdletime: `t 66615` (milliseconds). */
export function parseBusctlUint64(stdout: string): number | null {
  const match = /^t (\d+)$/.exec(stdout.trim());
  return match ? wholeNumber(match[1]) : null;
}

/** gdbus reply to GetIdletime: `(uint64 66615,)` (milliseconds). */
export function parseGdbusUint64(stdout: string): number | null {
  const match = /^\(uint64 (\d+),\)$/.exec(stdout.trim());
  return match ? wholeNumber(match[1]) : null;
}

/** xprintidle prints the idle time in milliseconds. */
export function parseXprintidle(stdout: string): number | null {
  return wholeNumber(stdout.trim());
}

/** busctl reply carrying one string: `s "yes"`. */
export function parseBusctlString(stdout: string): string | null {
  const match = /^s "([^"]*)"$/.exec(stdout.trim());
  return match?.[1] ?? null;
}

/** `loginctl show-session` output: one `Name=value` per line. */
export function parseLoginctlProperties(stdout: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals > 0) properties[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return properties;
}

/**
 * logind's idle hint, a coarse source: the desktop sets it only after its own idle delay.
 * - IdleSinceHint 0: the desktop has never told logind anything. That is silence, not "active".
 * - IdleHint no: the user is active by the desktop's own judgement -> 0.
 * - IdleHint yes: idle for at least the time since the hint was set (an under-estimate, which is
 *   the safe direction).
 */
export function idleSecondsFromLogind(properties: Record<string, string>, nowMs: number): number | null {
  const sinceMicros = wholeNumber(properties.IdleSinceHint);
  if (sinceMicros === null || sinceMicros <= 0) return null;
  if (properties.IdleHint === 'no') return 0;
  if (properties.IdleHint !== 'yes') return null;
  const idleMs = nowMs - sinceMicros / 1000;
  return Number.isFinite(idleMs) && idleMs >= 0 ? idleMs / 1000 : null;
}

function millisecondsToSeconds(ms: number | null): number | null {
  return ms === null ? null : ms / 1000;
}

/**
 * Session names to try with loginctl: logind's own choice first, then the session we were started
 * in. logind session ids are letters and digits only; anything else is not passed to a tool.
 */
export function sessionTargets(env: NodeJS.ProcessEnv): string[] {
  const own = env.XDG_SESSION_ID;
  return own !== undefined && /^[A-Za-z0-9]+$/.test(own) ? ['auto', own] : ['auto'];
}

export interface IdleSource {
  id: string;
  tool: string;
  args: readonly string[];
  /** Seconds since the last input, or null when the reply says nothing usable. */
  parse(stdout: string, nowMs: number): number | null;
}

const MUTTER_IDLE = ['org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core'] as const;
const MUTTER_BUSCTL_ARGS = ['--user', 'call', ...MUTTER_IDLE, 'org.gnome.Mutter.IdleMonitor', 'GetIdletime'] as const;
const MUTTER_GDBUS_ARGS = [
  'call',
  '--session',
  '--dest',
  MUTTER_IDLE[0],
  '--object-path',
  MUTTER_IDLE[1],
  '--method',
  'org.gnome.Mutter.IdleMonitor.GetIdletime',
] as const;

/** Idle-time sources for this session, best first. */
export function idleSources(env: NodeJS.ProcessEnv): IdleSource[] {
  const sources: IdleSource[] = [
    { id: 'mutter-busctl', tool: 'busctl', args: MUTTER_BUSCTL_ARGS, parse: (out) => millisecondsToSeconds(parseBusctlUint64(out)) },
    { id: 'mutter-gdbus', tool: 'gdbus', args: MUTTER_GDBUS_ARGS, parse: (out) => millisecondsToSeconds(parseGdbusUint64(out)) },
  ];
  // Under Wayland xprintidle talks to XWayland and only sees input that went to X11 windows: a user
  // typing in a native Wayland window would read as idle. It is trusted on a real X11 session only.
  if (env.XDG_SESSION_TYPE === 'x11') {
    sources.push({ id: 'xprintidle', tool: 'xprintidle', args: [], parse: (out) => millisecondsToSeconds(parseXprintidle(out)) });
  }
  for (const session of sessionTargets(env)) {
    sources.push({
      id: `logind-${session}`,
      tool: 'loginctl',
      args: ['show-session', session, '-p', 'IdleHint', '-p', 'IdleSinceHint'],
      parse: (out, nowMs) => idleSecondsFromLogind(parseLoginctlProperties(out), nowMs),
    });
  }
  return sources;
}

// ---------------------------------------------------------------------------------------------
// Power (pure)
// ---------------------------------------------------------------------------------------------

export type LogindAction = 'shutdown' | 'hibernate' | 'sleep';

const LOGIND_MANAGER = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'] as const;
const LOGIND_CAN: Record<LogindAction, string> = { shutdown: 'CanPowerOff', hibernate: 'CanHibernate', sleep: 'CanSuspend' };
const ACTION_NOUN: Record<LogindAction, string> = { shutdown: 'Shutting down', hibernate: 'Hibernation', sleep: 'Sleep' };
const ACTION_DONE: Record<LogindAction, string> = {
  shutdown: 'The system accepted the shutdown request.',
  hibernate: 'The system accepted the hibernate request.',
  sleep: 'The system accepted the sleep request.',
};

/** busctl arguments that ask logind whether `action` is allowed, without performing it. */
export function logindCanArgs(action: LogindAction): string[] {
  return ['call', ...LOGIND_MANAGER, LOGIND_CAN[action]];
}

/**
 * logind answers yes / no / challenge / na. "challenge" means a password prompt: at 3 AM nobody
 * types it, so it is a refusal, not an "almost yes". No usable answer is unknown, never a pass.
 */
export function capabilityFromLogind(action: LogindAction, answer: string | null): Capability {
  switch (answer) {
    case 'yes':
      return { ok: true, detail: 'Allowed by this system.' };
    case 'challenge':
      return { ok: false, detail: "This system would ask for an administrator password first, so it can't happen unattended." };
    case 'no':
      return { ok: false, detail: `${ACTION_NOUN[action]} is not allowed for your user on this system.` };
    case 'na':
      return { ok: false, detail: `${ACTION_NOUN[action]} is not available on this computer.` };
    default:
      return { ok: null, detail: "Couldn't find out whether this system allows it (logind gave no usable answer)." };
  }
}

/**
 * -i (= --check-inhibitors=no) is the counterpart of Windows' /f: without it one app holding an
 * inhibitor (an unsaved document, a media player) stops the shutdown and the computer stays on all
 * night. It is passed only when the user chose to close apps without asking.
 */
export function systemctlArgs(action: LogindAction, force: boolean): string[] {
  switch (action) {
    case 'shutdown':
      return force ? ['poweroff', '-i'] : ['poweroff'];
    case 'hibernate':
      return ['hibernate'];
    case 'sleep':
      return ['suspend'];
  }
}

/**
 * The inhibitor lives exactly as long as `cat` does, and `cat` ends when the pipe on its stdin
 * closes: on keepAwake(false), and also when the extension host dies without cleaning up. (A plain
 * `sleep infinity` would outlive a crashed editor and keep the computer awake for good.)
 */
export function inhibitArgs(catPath: string): string[] {
  return ['--what=idle:sleep', `--who=${APP_NAME}`, '--why=Claude Code sessions are still working', catPath];
}

export function notifySendArgs(options: CountdownAlertOptions, nowMs: number): string[] {
  const text = alertText(options, nowMs);
  return [
    '-u',
    options.kind === 'real' ? 'critical' : 'normal',
    '-a',
    APP_NAME,
    '-i',
    'dialog-warning',
    '-t',
    String(alertDeadlineMs(options, nowMs) - nowMs),
    '--',
    text.title,
    text.body,
  ];
}

/** Flatpak gives the editor a private /proc: registry PIDs look dead and host programs are invisible. */
export function isFlatpak(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): boolean {
  return (env.FLATPAK_ID !== undefined && env.FLATPAK_ID !== '') || exists('/.flatpak-info');
}

// ---------------------------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------------------------

interface Inspection {
  stat: ReadOutcome;
  /** null when stat could not be read or parsed. */
  parsed: ProcStat | null;
  /** null = not attempted (no stat, or the process has exited). */
  exe: ReadOutcome | null;
  /** null when the process cannot be named (no stat) or is not running any more. */
  name: string | null;
}

interface ProcessTable {
  processes: ProcRow[] | null;
  details: Record<number, ProcDetail>;
  problem: string | null;
}

class LinuxPlatform implements Platform {
  readonly id = 'linux' as const;
  readonly osName = 'Linux';
  readonly experimental = false;

  private readonly system: PosixSystem;
  private readonly log: (message: string) => void;
  private readonly flatpak: boolean;
  private readonly keepAwakeChild: KeepAwake;
  private readonly alertStops = new Set<() => void>();
  private readonly idleFailedAtMs = new Map<string, number>();
  private ticksPerSecond = DEFAULT_CLOCK_TICKS;
  private ticksQuery: Promise<void> | null = null;
  private bootTime: { seconds: number; readAtMs: number } | null = null;
  private processListProblem: string | null = null;
  private idleProblem: string | null = null;
  private idleSourceId: string | null = null;

  constructor(options: PlatformOptions, system: PosixSystem) {
    this.system = system;
    this.log = options.log;
    this.flatpak = isFlatpak(system.env, (file) => system.exists(file));
    this.keepAwakeChild = new KeepAwake(system, () => this.inhibitCommand(), () => this.desktopEnv());
  }

  /** CLK_TCK. The default until the first snapshot or probe has asked getconf. */
  get procStartUnitsPerSecond(): number {
    return this.ticksPerSecond;
  }

  environmentProblem(): string | null {
    return this.flatpak ? FLATPAK_PROBLEM : null;
  }

  helperStatus(): HelperStatus {
    return helperStatusOf({
      environmentProblem: this.environmentProblem(),
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
    try {
      const clock = await this.readClock();
      const found = await mapLimit(validPids(pids), READ_CONCURRENCY, async (pid) => ({
        pid,
        detail: await this.readDetail(pid, await this.inspect(pid), clock),
      }));
      for (const { pid, detail } of found) {
        // "No such process" proves death only while /proc itself answers. With /proc unreadable
        // every PID would look gone, so those stay unknown.
        if (detail.state === 'gone' && clock.bootTimeSeconds === null) continue;
        details[pid] = detail;
      }
    } catch (error) {
      this.log(`linux: probe failed: ${errorText(error)}`);
    }
    return details;
  }

  async idleSeconds(): Promise<number | null> {
    let seconds: number | null = null;
    try {
      seconds = await this.readIdle();
    } catch (error) {
      this.log(`linux: idle query failed: ${errorText(error)}`);
    }
    this.idleProblem = seconds === null ? IDLE_PROBLEM : null;
    return seconds;
  }

  async capability(action: PowerAction): Promise<Capability> {
    try {
      switch (action) {
        case 'notify':
          return NOTIFY_CAPABILITY;
        case 'lock':
          return this.tool('loginctl') === null
            ? { ok: false, detail: missingToolText('loginctl') }
            : { ok: true, detail: 'Asks your desktop to lock the screen (best effort).' };
        case 'shutdown':
        case 'hibernate':
        case 'sleep':
          return await this.logindCapability(action);
        default:
          return { ok: null, detail: 'Unknown action.' };
      }
    } catch (error) {
      return { ok: null, detail: `Couldn't find out whether this system allows it: ${errorText(error)}` };
    }
  }

  async execute(action: PowerAction, options: { force: boolean }): Promise<ActionResult> {
    if (action === 'notify') return NOTIFY_RESULT;
    if (powerActionsDisabled(this.system.env)) return POWER_DISABLED_RESULT;
    try {
      // Our own inhibitor blocks "sleep": it has to be gone before logind is asked to suspend.
      await this.keepAwakeChild.set(false);
      switch (action) {
        case 'lock':
          return await this.lock();
        case 'shutdown':
        case 'hibernate':
        case 'sleep':
          return await this.runSystemctl(action, options?.force === true);
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
      this.log(`linux: countdown alert failed: ${errorText(error)}`);
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

  private async read(file: string): Promise<ReadOutcome> {
    try {
      return { ok: true, value: await this.system.readFile(file) };
    } catch (error) {
      return { ok: false, code: errnoCode(error) };
    }
  }

  private async readLink(file: string): Promise<ReadOutcome> {
    try {
      return { ok: true, value: await this.system.readlink(file) };
    } catch (error) {
      return { ok: false, code: errnoCode(error) };
    }
  }

  private async readClock(): Promise<LinuxClock> {
    this.ticksQuery ??= this.queryClockTicks();
    await this.ticksQuery;
    return { ticksPerSecond: this.ticksPerSecond, bootTimeSeconds: await this.readBootTime() };
  }

  private async queryClockTicks(): Promise<void> {
    try {
      const getconf = this.tool('getconf');
      const result = getconf === null ? null : await this.system.run(getconf, ['CLK_TCK'], this.queryOptions());
      const ticks = result !== null && exitedCleanly(result) ? parseClockTicks(result.stdout) : null;
      if (ticks !== null) this.ticksPerSecond = ticks;
      else this.log(`linux: getconf CLK_TCK gave no answer, assuming ${DEFAULT_CLOCK_TICKS} ticks per second`);
    } catch (error) {
      this.log(`linux: getconf CLK_TCK failed (${errorText(error)}), assuming ${DEFAULT_CLOCK_TICKS} ticks per second`);
    }
  }

  private async readBootTime(): Promise<number | null> {
    const now = this.system.now();
    if (this.bootTime !== null && Math.abs(now - this.bootTime.readAtMs) < BOOT_TIME_TTL_MS) return this.bootTime.seconds;
    const stat = await this.read(`${PROC}/stat`);
    const seconds = stat.ok ? parseBootTimeSeconds(stat.value) : null;
    this.bootTime = seconds === null ? null : { seconds, readAtMs: now };
    return seconds;
  }

  /** Every PID in /proc, or the reason the directory is no process list. */
  private async listProcessIds(): Promise<number[] | string> {
    let names: string[];
    try {
      names = await this.system.readdir(PROC);
    } catch (error) {
      return errnoCode(error);
    }
    const pids = validPids(names.filter((name) => /^\d+$/.test(name)).map(Number));
    return pids.length > 0 ? pids : 'it lists no processes';
  }

  private async inspect(pid: number): Promise<Inspection> {
    const stat = await this.read(`${PROC}/${pid}/stat`);
    const parsed = stat.ok ? parseProcStat(stat.value) : null;
    if (parsed === null || hasExited(parsed.state)) return { stat, parsed, exe: null, name: null };
    const exe = await this.readLink(`${PROC}/${pid}/exe`);
    const cmdline = commMayBeTruncated(parsed.comm) ? await this.read(`${PROC}/${pid}/cmdline`) : null;
    return { stat, parsed, exe, name: chooseProcessName(parsed.comm, cmdline?.ok ? cmdline.value : null) };
  }

  private async readDetail(pid: number, seen: Inspection, clock: LinuxClock): Promise<ProcDetail> {
    const io = seen.name === null ? null : await this.read(`${PROC}/${pid}/io`);
    return buildLinuxDetail({ stat: seen.stat, exe: seen.exe, io }, clock);
  }

  private async readProcessTable(request: SnapshotRequest): Promise<ProcessTable> {
    const clock = await this.readClock();
    const listing = await this.listProcessIds();
    if (typeof listing === 'string') {
      // Without the list nothing can be called gone: details stay empty (= unknown).
      this.processListProblem = `Couldn't read the list of running programs (${PROC}: ${listing}).`;
      return { processes: null, details: {}, problem: this.processListProblem };
    }
    this.processListProblem = null;

    const listed = new Set(listing);
    const wanted = new Set(validPids(request.detailPids));
    const needles = detailNeedles(request.detailNames);
    const entries = await mapLimit([...new Set([...listing, ...wanted])], READ_CONCURRENCY, async (pid) => {
      const seen = await this.inspect(pid);
      // The native Claude binary is a file named after its version (.../claude/versions/2.1.283),
      // so a session started by that path has no "claude" in its name: match the path as well.
      const exePath = seen.exe?.ok ? seen.exe.value : null;
      const named = seen.name !== null && (containsAny(seen.name, needles) || containsAny(exePath, needles));
      return {
        pid,
        row: listed.has(pid) && seen.name !== null ? { pid, ppid: seen.parsed?.ppid ?? null, name: seen.name } : null,
        detail: wanted.has(pid) || (listed.has(pid) && named) ? await this.readDetail(pid, seen, clock) : null,
        unreadable: listed.has(pid) && (seen.stat.ok ? seen.parsed === null : !vanished(seen.stat.code)),
      };
    });

    const processes: ProcRow[] = [];
    const details: Record<number, ProcDetail> = {};
    let unreadable = 0;
    for (const entry of entries) {
      if (entry.row !== null) processes.push(entry.row);
      if (entry.detail !== null) details[entry.pid] = entry.detail;
      if (entry.unreadable) unreadable++;
    }
    const problem =
      unreadable > 0
        ? `${unreadable} running ${unreadable === 1 ? 'program' : 'programs'} could not be inspected, so the list is incomplete.`
        : null;
    return { processes, details, problem };
  }

  // -- idle ------------------------------------------------------------------------------------

  private async readIdle(): Promise<number | null> {
    for (const source of idleSources(this.system.env)) {
      const failedAt = this.idleFailedAtMs.get(source.id);
      // A source that just failed (no GNOME, tool missing) is not asked again on every poll.
      if (failedAt !== undefined && Math.abs(this.system.now() - failedAt) < IDLE_SOURCE_RETRY_MS) continue;
      const seconds = await this.readIdleSource(source);
      if (seconds !== null) {
        this.idleFailedAtMs.delete(source.id);
        this.noteIdleSource(source.id);
        return seconds;
      }
      this.idleFailedAtMs.set(source.id, this.system.now());
    }
    this.noteIdleSource(null);
    return null;
  }

  private async readIdleSource(source: IdleSource): Promise<number | null> {
    const tool = this.tool(source.tool);
    if (tool === null) return null;
    const result = await this.system.run(tool, source.args, this.queryOptions());
    if (!exitedCleanly(result)) return null;
    const seconds = source.parse(result.stdout, this.system.now());
    return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  private noteIdleSource(id: string | null): void {
    if (id === this.idleSourceId) return;
    this.idleSourceId = id;
    this.log(id === null ? 'linux: no idle-time source answers' : `linux: idle time now comes from ${id}`);
  }

  // -- power -----------------------------------------------------------------------------------

  private async logindCapability(action: LogindAction): Promise<Capability> {
    if (this.tool('systemctl') === null) return { ok: false, detail: missingToolText('systemctl') };
    const busctl = this.tool('busctl');
    if (busctl === null) {
      return { ok: null, detail: "Couldn't find out whether this system allows it: busctl was not found." };
    }
    const result = await this.system.run(busctl, logindCanArgs(action), this.queryOptions());
    if (!exitedCleanly(result)) {
      return { ok: null, detail: `Couldn't find out whether this system allows it: ${describeRunFailure('busctl', result)}.` };
    }
    return capabilityFromLogind(action, parseBusctlString(result.stdout));
  }

  private async runSystemctl(action: LogindAction, force: boolean): Promise<ActionResult> {
    const systemctl = this.tool('systemctl');
    if (systemctl === null) return failedAction(missingToolText('systemctl'));
    const command: PowerCommand = {
      file: systemctl,
      args: systemctlArgs(action, force),
      suspends: action !== 'shutdown',
      done: ACTION_DONE[action],
    };
    return runPowerCommand(this.system, command, this.queryEnv());
  }

  private async lock(): Promise<ActionResult> {
    const loginctl = this.tool('loginctl');
    if (loginctl === null) return failedAction(missingToolText('loginctl'));
    let failure = failedAction('The screen could not be locked.');
    for (const session of sessionTargets(this.system.env)) {
      const args = ['lock-session', session];
      const command = formatCommand(loginctl, args);
      const result = await this.system.run(loginctl, args, { timeoutMs: ACTION_TIMEOUT_MS, env: this.queryEnv() });
      if (!exitedCleanly(result)) {
        failure = failedAction(describeRunFailure('loginctl', result), command, result.code);
        continue;
      }
      // loginctl exits 0 even when no screen locker is listening, so ask logind what happened.
      const locked = await this.lockConfirmed(loginctl, session);
      const detail = locked ? 'The screen is locked.' : "Asked the desktop to lock the screen; it didn't confirm that it did.";
      return { ok: true, detail, command, exitCode: 0, confirmed: locked };
    }
    return failure;
  }

  private async lockConfirmed(loginctl: string, session: string): Promise<boolean> {
    for (let attempt = 0; attempt < LOCK_CONFIRM_ATTEMPTS; attempt++) {
      const result = await this.system.run(loginctl, ['show-session', session, '-p', 'LockedHint'], this.queryOptions());
      if (exitedCleanly(result) && parseLoginctlProperties(result.stdout).LockedHint === 'yes') return true;
      await this.system.delay(LOCK_CONFIRM_INTERVAL_MS);
    }
    return false;
  }

  private inhibitCommand(): HoldCommand {
    const inhibit = this.tool('systemd-inhibit');
    const cat = this.tool('cat');
    if (inhibit === null) return { problem: "Can't keep this computer awake: systemd-inhibit was not found." };
    if (cat === null) return { problem: "Can't keep this computer awake: cat was not found." };
    return { file: inhibit, args: inhibitArgs(cat) };
  }

  // -- countdown alert -------------------------------------------------------------------------

  private showAlert(options: CountdownAlertOptions): CountdownAlert {
    const env = this.desktopEnv();
    const toolOptions = { timeoutMs: ALERT_TOOL_TIMEOUT_MS, env };
    const nowMs = this.system.now();
    const secondsLeft = (alertDeadlineMs(options, nowMs) - nowMs) / 1000;
    const notifySend = this.tool('notify-send');
    if (notifySend === null) this.log('linux: notify-send was not found, no countdown notification');
    else void this.system.run(notifySend, notifySendArgs(options, nowMs), toolOptions);

    const player = options.sound === true ? this.tool('canberra-gtk-play') : null;
    const cancelSounds =
      player === null
        ? () => undefined
        : scheduleCountdownSounds(secondsLeft, () => void this.system.run(player, ['-i', 'dialog-warning'], toolOptions));
    const stop = (): void => {
      cancelSounds();
      this.alertStops.delete(stop);
    };
    this.alertStops.add(stop);
    // A desktop notification has no Cancel button here, so onCancel never fires.
    return { onCancel: () => undefined, stop };
  }

  // -- tools -----------------------------------------------------------------------------------

  private tool(name: string): string | null {
    return findTool(this.system, name);
  }

  /** For desktop tools that show text: the user's own locale, minus what the editor leaked in. */
  private desktopEnv(): NodeJS.ProcessEnv {
    return sanitiseToolEnv(this.system.env);
  }

  /** For tools whose output is parsed or logged: fixed C locale. */
  private queryEnv(): NodeJS.ProcessEnv {
    return { ...this.desktopEnv(), LC_ALL: 'C' };
  }

  private queryOptions(): { timeoutMs: number; env: NodeJS.ProcessEnv } {
    return { timeoutMs: QUERY_TIMEOUT_MS, env: this.queryEnv() };
  }
}

/** `system` is the test seam; production uses the real file system and child processes. */
export function createLinuxPlatform(options: PlatformOptions, system: PosixSystem = createPosixSystem()): Platform {
  return new LinuxPlatform(options, system);
}
