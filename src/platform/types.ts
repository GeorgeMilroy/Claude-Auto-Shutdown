// The only OS boundary. The engine and the controller talk to the machine exclusively through
// `Platform`; three backends implement it (windows, linux, macos) plus an 'unsupported' stub.
//
// Rules every backend follows:
// - Never throw / reject for an expected failure: return the "unknown" value (null) and a problem.
// - A process that cannot be inspected is UNKNOWN (state 'denied' / 'partial'), never dead.
// - System binaries are spawned by ABSOLUTE path with an args array, shell: false, a fixed cwd
//   and a timeout. Nothing is ever resolved from the workspace folder or PATH.
// - execute() refuses to run when process.env.CLAUDE_AUTOSHUTDOWN_NO_POWER === '1' (tests, CI).

import type { PowerAction } from '../shared/config';

export type PlatformId = 'windows' | 'linux' | 'macos' | 'unsupported';

/**
 * - ok: alive, every field read
 * - partial: alive, at least one field unreadable (null)
 * - denied: exists but could not be opened at all
 * - exited: the PID still exists as a zombie / exited process
 * - gone: no such process
 */
export type ProcState = 'ok' | 'partial' | 'denied' | 'exited' | 'gone';

export interface ProcDetail {
  state: ProcState;
  /** Full executable path; null = unreadable. */
  path: string | null;
  /**
   * Start time in the unit Claude Code writes to `procStart` on this OS, as a decimal string
   * (Windows: FILETIME, 100 ns since 1601; Linux: clock ticks since boot). null = unreadable or
   * not comparable on this OS. Compare with BigInt - FILETIMEs exceed 2^53.
   */
  startRaw: string | null;
  /** Start time as epoch ms; null = unreadable. */
  startEpochMs: number | null;
  /** Cumulative CPU time (kernel + user) in seconds; null = unreadable. */
  cpuSeconds: number | null;
  /** Cumulative bytes read + written (+ other on Windows); null = unavailable. */
  ioBytes: number | null;
}

export interface ProcRow {
  pid: number;
  /** Parent PID; null = unknown. NOTE: on Windows a parent PID can be stale (parent exited). */
  ppid: number | null;
  /** Lower-cased image name WITHOUT a trailing '.exe' ('claude', 'node', 'ffmpeg'). */
  name: string;
}

export interface SnapshotRequest {
  /** PIDs whose detail must be returned (present in `details` even when gone). */
  detailPids: number[];
  /** Also return detail for every process with one of these names (lower-case, no '.exe'). */
  detailNames: string[];
}

export interface SystemSnapshot {
  takenAtMs: number;
  /** Seconds since the last mouse / keyboard input; null = can't tell (never 0 on failure). */
  idleSeconds: number | null;
  /** Every running process; null = the list could not be read. */
  processes: ProcRow[] | null;
  /** Detail keyed by PID for everything requested. A requested PID that is absent here is unknown. */
  details: Record<number, ProcDetail>;
  /** Set when the snapshot is incomplete for a reason worth showing ("helper timed out"). */
  problem: string | null;
}

/**
 * - full: everything works
 * - limited: process data works, but idle time and/or some power features are unavailable
 * - unavailable: processes cannot be inspected at all - nothing may be shut down
 */
export type HelperTier = 'full' | 'limited' | 'unavailable';

export interface HelperStatus {
  tier: HelperTier;
  /** Plain-English reason when not 'full', else null. */
  problem: string | null;
}

export interface Capability {
  /** true = the action can run unattended; false = it cannot; null = could not find out. */
  ok: boolean | null;
  /** Plain English: "Allowed by Windows", "Hibernation is turned off on this PC", ... */
  detail: string;
}

export interface ActionResult {
  ok: boolean;
  /** Plain English result, including the OS's own message on failure. */
  detail: string;
  /** The command line that was run, for the log; null when nothing was spawned. */
  command: string | null;
  /** Exit code when a process ran to completion. */
  exitCode: number | null;
  /**
   * Whether the OS showed that the action really happened, beyond accepting the command:
   * true = confirmed (lock screen seen, PC slept and woke); false = the command was accepted but
   * nothing confirmed it (a lock nobody saw happen) - reported to the user as NOT confirmed;
   * null = no confirmation exists for this action (shutdown, notify) or it failed (`ok: false`).
   */
  confirmed: boolean | null;
}

export interface CountdownAlertOptions {
  /**
   * Seconds left at the moment of this call. The alert counts down from the call, not from the
   * moment its window finally appears (starting PowerShell + WinForms takes seconds), so it never
   * shows more time than really remains.
   */
  seconds: number;
  /** 'real' = solid, urgent; 'test' / 'preview' = clearly marked as harmless. */
  kind: 'real' | 'test' | 'preview';
  /** e.g. "Shutting down this PC in" */
  title: string;
  /** Second line, e.g. "All Claude sessions finished." */
  body: string;
  /** Label of the one button, e.g. "Cancel: keep this PC on" */
  cancelLabel: string;
  /** Play the OS warning sound at start and once per second for the last 5 s. */
  sound: boolean;
}

export interface CountdownAlert {
  /** Fires at most once, when the user presses the alert's Cancel button. */
  onCancel(listener: () => void): void;
  /** Close the alert (idempotent). */
  stop(): void;
}

export interface ForeignRoot {
  /** Path readable from this process, e.g. \\wsl.localhost\Ubuntu\home\me\.claude */
  path: string;
  /** e.g. "WSL: Ubuntu" */
  label: string;
}

export interface Platform {
  readonly id: PlatformId;
  /** 'Windows' | 'Linux' | 'macOS' | process.platform */
  readonly osName: string;
  /**
   * Units of ProcDetail.startRaw per second (Windows 10_000_000, Linux CLK_TCK).
   * null = startRaw cannot be compared with the registry's procStart on this OS.
   */
  readonly procStartUnitsPerSecond: number | null;
  /** The backend has never been run on real hardware (macOS). */
  readonly experimental: boolean;

  /**
   * A problem that makes the whole platform unusable - unsupported OS, Flatpak sandbox (private
   * /proc), ... Watching is refused while this is non-null.
   */
  environmentProblem(): string | null;

  /** Current helper tier. Cheap, synchronous, reflects the last interaction. */
  helperStatus(): HelperStatus;

  /** One consistent view of the machine. Never rejects. */
  snapshot(request: SnapshotRequest): Promise<SystemSnapshot>;

  /** Detail for a handful of PIDs (cheap). A PID missing from the result is unknown. Never rejects. */
  probe(pids: number[]): Promise<Record<number, ProcDetail>>;

  /** Seconds since last input; null = can't tell. Cheap enough to call once per second. */
  idleSeconds(): Promise<number | null>;

  /** Can `action` run unattended on this machine? Never performs it. */
  capability(action: PowerAction): Promise<Capability>;

  /**
   * Perform the action. 'notify' is a no-op that succeeds.
   * For sleep / hibernate the call may only return after the machine resumes: an early non-zero
   * exit is a failure, anything else (including "the timeout fired because we slept") is success.
   */
  execute(action: PowerAction, options: { force: boolean }): Promise<ActionResult>;

  /** Hold (true) or release (false) a "don't go to sleep by yourself" request. Best effort. */
  keepAwake(on: boolean): Promise<{ ok: boolean; detail: string }>;

  /** Show an OS-level, always-on-top countdown warning with one Cancel button. Best effort. */
  startCountdownAlert(options: CountdownAlertOptions): CountdownAlert;

  /**
   * Claude config dirs that live in another PID namespace but are readable from here
   * (Windows: running WSL distros). `problem` non-null = "something is there but I can't look".
   */
  foreignRoots(): Promise<{ roots: ForeignRoot[]; problem: string | null }>;

  /** Stop helpers, release keep-awake, close alerts. */
  dispose(): Promise<void>;
}
