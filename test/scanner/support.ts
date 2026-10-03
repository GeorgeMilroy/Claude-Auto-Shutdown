// Fakes and fixtures for the scanner tests. Nothing here touches the real machine: every Claude
// folder is built inside a fresh temp directory, time is a number the test sets, and the platform
// only replays the processes a test gave it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Scanner, type ScanRequest, type ScannerOptions } from '../../src/core/scanner';
import type { ScanResult, Session } from '../../src/core/types';
import type {
  ActionResult,
  Capability,
  CountdownAlert,
  ForeignRoot,
  HelperStatus,
  Platform,
  PlatformId,
  ProcDetail,
  ProcRow,
  SnapshotRequest,
  SystemSnapshot,
} from '../../src/platform/types';

/** "Now" of every test: a whole second, so file times round-trip exactly. */
export const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
/** Start of the processes that tests register as live sessions. */
export const SESSION_START = NOW - 2 * 3600_000;

export const CLAUDE_EXE =
  'C:\\Users\\X\\.vscode\\extensions\\anthropic.claude-code-2.1.288-win32-x64\\resources\\native-binary\\claude.exe';

const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

/** A Windows FILETIME (100 ns since 1601) as the decimal string the registry and the helper use. */
export function filetime(epochMs: number): string {
  return (BigInt(epochMs) * 10_000n + FILETIME_UNIX_EPOCH).toString();
}

export function detail(overrides: Partial<ProcDetail> = {}): ProcDetail {
  return {
    state: 'ok',
    path: 'C:\\Windows\\System32\\cmd.exe',
    startRaw: filetime(SESSION_START),
    startEpochMs: SESSION_START,
    cpuSeconds: 1,
    ioBytes: 1000,
    ...overrides,
  };
}

type Failing = 'snapshot' | 'probe' | 'foreignRoots' | 'helperStatus';

/**
 * A platform that answers from what the test set up. Like a real backend, a snapshot only
 * carries detail for the PIDs and names it was asked about.
 */
export class FakePlatform implements Platform {
  id: PlatformId = 'windows';
  readonly osName = 'Windows';
  procStartUnitsPerSecond: number | null = 10_000_000;
  readonly experimental = false;

  /** null = the process list cannot be read. */
  processes: ProcRow[] | null = [{ pid: 4, ppid: 0, name: 'system' }];
  details: Record<number, ProcDetail> = {};
  /** What probe() says; a PID without an entry falls back to `details`. */
  probeSamples: Record<number, ProcDetail> = {};
  idle: number | null = 900;
  snapshotProblem: string | null = null;
  foreign: { roots: ForeignRoot[]; problem: string | null } = { roots: [], problem: null };
  helper: HelperStatus = { tier: 'full', problem: null };
  /** Calls that throw instead of answering. */
  readonly failing = new Set<Failing>();

  readonly snapshotRequests: SnapshotRequest[] = [];
  readonly probeRequests: number[][] = [];
  foreignRootCalls = 0;

  /** Adds a running process. `info` null = listed, but nothing more is known about it. */
  run(pid: number, name: string, ppid: number | null = 1, info: Partial<ProcDetail> | null = {}): void {
    (this.processes ??= []).push({ pid, ppid, name });
    if (info !== null) this.details[pid] = detail(info);
  }

  environmentProblem(): string | null {
    return null;
  }

  helperStatus(): HelperStatus {
    if (this.failing.has('helperStatus')) throw new Error('helper status exploded');
    return this.helper;
  }

  async snapshot(request: SnapshotRequest): Promise<SystemSnapshot> {
    this.snapshotRequests.push(request);
    if (this.failing.has('snapshot')) throw new Error('snapshot exploded');
    const wanted = new Set(request.detailPids);
    for (const row of this.processes ?? []) {
      if (request.detailNames.includes(row.name)) wanted.add(row.pid);
    }
    const details: Record<number, ProcDetail> = {};
    for (const pid of wanted) {
      const known = this.details[pid];
      if (known !== undefined) details[pid] = known;
    }
    return {
      takenAtMs: NOW,
      idleSeconds: this.idle,
      processes: this.processes === null ? null : [...this.processes],
      details,
      problem: this.snapshotProblem,
    };
  }

  async probe(pids: number[]): Promise<Record<number, ProcDetail>> {
    this.probeRequests.push([...pids]);
    if (this.failing.has('probe')) throw new Error('probe exploded');
    const answer: Record<number, ProcDetail> = {};
    for (const pid of pids) {
      const known = this.probeSamples[pid] ?? this.details[pid];
      if (known !== undefined) answer[pid] = known;
    }
    return answer;
  }

  async idleSeconds(): Promise<number | null> {
    return this.idle;
  }

  async capability(): Promise<Capability> {
    return { ok: null, detail: 'fake platform' };
  }

  /** A fake never does anything to the machine. */
  async execute(): Promise<ActionResult> {
    return { ok: false, detail: 'fake platform: nothing was run', command: null, exitCode: null, confirmed: null };
  }

  async keepAwake(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'fake platform' };
  }

  startCountdownAlert(): CountdownAlert {
    return { onCancel: () => undefined, stop: () => undefined };
  }

  async foreignRoots(): Promise<{ roots: ForeignRoot[]; problem: string | null }> {
    this.foreignRootCalls++;
    if (this.failing.has('foreignRoots')) throw new Error('wsl exploded');
    return this.foreign;
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------------------------
// Transcript records
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function assistant(stopReason: string | null, content: unknown[]): Json {
  return { type: 'assistant', message: { role: 'assistant', stop_reason: stopReason, content } };
}

const PROMPT: Json = { type: 'user', message: { role: 'user', content: 'please do the thing' } };
const TOOL_RESULT: Json = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
};

/** The turn ended: the model answered and waits for a human. */
export const CLOSED: Json[] = [PROMPT, assistant('end_turn', [{ type: 'text', text: 'done' }])];
/** A tool call is in flight. */
export const OPEN: Json[] = [
  PROMPT,
  assistant('tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
];
/** Nothing in it says anything about a turn. */
export const NOISE_ONLY: Json[] = [{ type: 'file-history-snapshot' }, { type: 'summary', summary: 'x' }];

/** A turn that ended after scheduling its own wake-up (/loop). */
export function closedWithWakeup(delaySeconds: number): Json[] {
  return [
    PROMPT,
    assistant('tool_use', [{ type: 'tool_use', id: 't1', name: 'ScheduleWakeup', input: { delaySeconds } }]),
    TOOL_RESULT,
    assistant('end_turn', [{ type: 'text', text: 'see you later' }]),
  ];
}

/** ISO timestamp of a transcript record. */
export function stamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** A call of the CronCreate tool (fixed-interval /loop), made at `atMs`. */
export function cronCreate(toolUseId: string, input: Json, atMs: number): Json {
  return {
    ...assistant('tool_use', [{ type: 'tool_use', id: toolUseId, name: 'CronCreate', input: { prompt: 'check the deploy', ...input } }]),
    timestamp: stamp(atMs),
  };
}

/** A call of the CronDelete tool, made at `atMs`. */
export function cronDelete(toolUseId: string, id: string, atMs: number): Json {
  return { ...assistant('tool_use', [{ type: 'tool_use', id: toolUseId, name: 'CronDelete', input: { id } }]), timestamp: stamp(atMs) };
}

/** The answer to a tool call. */
export function toolAnswer(toolUseId: string, text: string, isError = false): Json {
  const block = { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) };
  return { type: 'user', message: { role: 'user', content: [block] } };
}

/**
 * `/loop 10m check the deploy` as Claude Code runs it: one turn that schedules the task, then the
 * turns it fires, which do not repeat the call.
 */
export function intervalLoop(createdAtMs: number, cron = '*/10 * * * *', jobId = '1a2b3c4d'): Json[] {
  return [
    { type: 'user', message: { role: 'user', content: '/loop 10m check the deploy' } },
    cronCreate('toolu_cron1', { cron, recurring: true }, createdAtMs),
    toolAnswer('toolu_cron1', `Scheduled recurring job ${jobId} (${cron}). Auto-expires after 7 days. Use CronDelete to cancel sooner.`),
    assistant('end_turn', [{ type: 'text', text: 'Checking the deploy every 10 minutes.' }]),
    { type: 'user', message: { role: 'user', content: 'check the deploy' } },
    assistant('end_turn', [{ type: 'text', text: 'The deploy is still green.' }]),
  ];
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function setWriteTime(file: string, mtimeMs: number): void {
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

// ---------------------------------------------------------------------------------------------
// A synthetic Claude config folder
// ---------------------------------------------------------------------------------------------

export class ClaudeDir {
  constructor(readonly dir: string) {}

  get sessionsDir(): string {
    return path.join(this.dir, 'sessions');
  }

  get projectsDir(): string {
    return path.join(this.dir, 'projects');
  }

  /** Writes sessions/<fileName> with exactly this content. Default write time: an hour ago. */
  rawSession(fileName: string, content: string, mtimeMs: number = NOW - 3600_000): string {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const file = path.join(this.sessionsDir, fileName);
    fs.writeFileSync(file, content);
    setWriteTime(file, mtimeMs);
    return file;
  }

  /** Writes sessions/<pid>.json. */
  session(fields: Json & { pid: number }, mtimeMs?: number): string {
    return this.rawSession(`${fields.pid}.json`, JSON.stringify(fields), mtimeMs);
  }

  /** Writes projects/<project>/<sessionId>.jsonl, last written at `mtimeMs`. */
  transcript(project: string, sessionId: string, records: readonly unknown[], mtimeMs: number): string {
    return this.write(path.join(this.projectsDir, project, `${sessionId}.jsonl`), jsonl(records), mtimeMs);
  }

  /** Writes <transcript without .jsonl>/subagents/<relativePath>. */
  subagent(transcriptPath: string, relativePath: string, records: readonly unknown[], mtimeMs: number): string {
    const file = path.join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents', relativePath);
    return this.write(file, jsonl(records), mtimeMs);
  }

  /** Appends one record and moves the write time, like a session that writes again. */
  append(file: string, record: unknown, mtimeMs: number): void {
    fs.appendFileSync(file, jsonl([record]));
    setWriteTime(file, mtimeMs);
  }

  private write(file: string, content: string, mtimeMs: number): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    setWriteTime(file, mtimeMs);
    return file;
  }
}

// ---------------------------------------------------------------------------------------------
// Workspace: a temp home, a fake platform, a scanner
// ---------------------------------------------------------------------------------------------

export const DEFAULT_REQUEST: ScanRequest = {
  quietSeconds: 300,
  guardPatterns: [],
  waitForChildProcesses: false,
  extraClaudeDirs: [],
  scanWsl: false,
  ignores: new Set(),
  forceWide: false,
};

export interface Workspace {
  /** Temp folder that plays the home directory. */
  home: string;
  /** <home>/.claude */
  claude: ClaudeDir;
  platform: FakePlatform;
  /** The scanner's clock; a test moves `now` forward between scans. */
  clock: { now: number };
  scanner: Scanner;
  scan(overrides?: Partial<ScanRequest>): Promise<ScanResult>;
  /** Another Claude folder inside the temp home (not created until something is written). */
  otherDir(name: string): ClaudeDir;
  /**
   * Registers a session and runs the matching process: start time and procStart agree, so the
   * session is live and verified.
   */
  liveSession(pid: number, sessionId: string, fields?: Json, into?: ClaudeDir): void;
  cleanup(): void;
}

export function createWorkspace(options: Partial<Omit<ScannerOptions, 'platform' | 'homeDir' | 'now'>> = {}): Workspace {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-scanner-'));
  const platform = new FakePlatform();
  const clock = { now: NOW };
  const scanner = new Scanner({ env: {}, ...options, platform, homeDir: home, now: () => clock.now });
  const claude = new ClaudeDir(path.join(home, '.claude'));
  return {
    home,
    claude,
    platform,
    clock,
    scanner,
    scan: (overrides = {}) => scanner.scan({ ...DEFAULT_REQUEST, ...overrides }),
    otherDir: (name) => new ClaudeDir(path.join(home, name)),
    liveSession: (pid, sessionId, fields = {}, into = claude) => {
      into.session({ pid, sessionId, cwd: 'C:\\work\\shop', entrypoint: 'cli', procStart: filetime(SESSION_START), ...fields });
      platform.run(pid, 'claude', 1, { path: CLAUDE_EXE });
    },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

/** The one session a test expects; fails loudly when there are none or several. */
export function only(result: ScanResult): Session {
  if (result.sessions.length !== 1) {
    throw new Error(`expected exactly one session, got ${result.sessions.length}: ${JSON.stringify(result.errors)}`);
  }
  return result.sessions[0] as Session;
}

export function sessionNamed(result: ScanResult, name: string): Session {
  const found = result.sessions.find((session) => session.name === name);
  if (found === undefined) throw new Error(`no session named ${name} in [${result.sessions.map((s) => s.name).join(', ')}]`);
  return found;
}
