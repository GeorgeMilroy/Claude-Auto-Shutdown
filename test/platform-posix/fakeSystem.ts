// A whole fake machine for the POSIX backends: an in-memory /proc, a set of "installed" tools with
// scripted replies, and held children that never touch the real OS.

import * as path from 'node:path';

import type { RunOptions, RunResult } from '../../src/platform/exec';
import type { PlatformOptions } from '../../src/platform/index';
import type { HeldExit, HeldProcess, PosixSystem } from '../../src/platform/posixSystem';

export function errno(code: string): Error {
  return Object.assign(new Error(`${code}: fake failure`), { code });
}

export interface RunCall {
  file: string;
  args: string[];
  options: RunOptions;
}

export type Reply = Partial<RunResult>;
type Responder = (args: string[], call: RunCall) => Reply | undefined;

export class FakeHeld implements HeldProcess {
  readonly exited: Promise<HeldExit>;
  readonly file: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  stopped = false;
  /** false = a child that ignores stop() (to test the bounded wait). */
  exitsOnStop = true;
  private settle: (exit: HeldExit) => void = () => undefined;

  constructor(file: string, args: readonly string[], env: NodeJS.ProcessEnv) {
    this.file = file;
    this.args = [...args];
    this.env = env;
    this.exited = new Promise<HeldExit>((resolve) => {
      this.settle = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.exitsOnStop) this.settle({ code: null, stderr: '' });
  }

  exit(code: number | null, stderr = ''): void {
    this.settle({ code, stderr });
  }
}

export interface FakeProcess {
  pid: number;
  comm: string;
  state?: string;
  ppid?: number;
  utime?: number;
  stime?: number;
  /** starttime in clock ticks. */
  start?: number;
  /** Target of /proc/<pid>/exe; an Error makes the readlink fail; undefined = ENOENT. */
  exe?: string | Error;
  /** argv, joined with NULs as the kernel does. */
  argv?: string[];
  /** Content of /proc/<pid>/io; an Error makes the read fail; undefined = ENOENT. */
  io?: string | Error;
}

/** A realistic /proc/<pid>/stat line (52 fields, as printed by a 6.x kernel). */
export function statLine(process: FakeProcess): string {
  const { pid, comm, state = 'S', ppid = 1, utime = 250, stime = 50, start = 633076 } = process;
  return (
    `${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 34816 ${pid} 4194304 3542 54321 0 12 ${utime} ${stime} 45 23 20 0 1 0 ` +
    `${start} 12345344 1432 18446744073709551615 94391817850880 94391818769325 140725241467664 0 0 0 65536 3670020 ` +
    `1266777851 1 0 0 17 3 0 0 0 0 0 94391819002384 94391819050012 94391843618816 140725241475382 140725241475387 ` +
    `140725241475387 140725241479150 0\n`
  );
}

export function ioFile(rchar: number, wchar: number): string {
  return (
    `rchar: ${rchar}\nwchar: ${wchar}\nsyscr: 632687\nsyscw: 632675\nread_bytes: 0\n` +
    `write_bytes: ${wchar}\ncancelled_write_bytes: 0\n`
  );
}

export const BOOT_TIME_SECONDS = 1_790_000_000;

export function procStatFile(bootTimeSeconds = BOOT_TIME_SECONDS): string {
  return (
    'cpu  225748 1981 87654 4405271 7164 0 2861 0 0 0\n' +
    'cpu0 28123 301 11034 550121 911 0 1422 0 0 0\n' +
    'intr 18245561 9 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n' +
    'ctxt 51234567\n' +
    `btime ${bootTimeSeconds}\n` +
    'processes 72451\nprocs_running 2\nprocs_blocked 0\nsoftirq 9876543 1 2 3\n'
  );
}

export class FakeSystem implements PosixSystem {
  env: NodeJS.ProcessEnv = {};
  pid = 4242;
  nowMs = Date.UTC(2026, 9, 3, 12, 0, 0);
  readonly files = new Map<string, string | Error>();
  readonly links = new Map<string, string | Error>();
  readonly dirs = new Map<string, string[] | Error>();
  readonly present = new Set<string>();
  readonly calls: RunCall[] = [];
  readonly holds: FakeHeld[] = [];
  /** Set to make every newly held child end at once with this exit. */
  holdEndsWith: HeldExit | null = null;
  private readonly responders = new Map<string, Responder>();

  now = (): number => this.nowMs;

  delay = (ms: number): Promise<void> => {
    this.nowMs += ms;
    return Promise.resolve();
  };

  readFile = async (file: string): Promise<string> => {
    const entry = this.files.get(file);
    if (entry === undefined) throw errno('ENOENT');
    if (entry instanceof Error) throw entry;
    return entry;
  };

  readlink = async (file: string): Promise<string> => {
    const entry = this.links.get(file);
    if (entry === undefined) throw errno('ENOENT');
    if (entry instanceof Error) throw entry;
    return entry;
  };

  readdir = async (dir: string): Promise<string[]> => {
    const entry = this.dirs.get(dir);
    if (entry === undefined) throw errno('ENOENT');
    if (entry instanceof Error) throw entry;
    return entry;
  };

  exists = (file: string): boolean => this.present.has(file) || this.files.has(file);

  run = async (file: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
    const call: RunCall = { file, args: [...args], options };
    this.calls.push(call);
    if (!this.present.has(file)) {
      return { started: false, code: null, stdout: '', stderr: '', timedOut: false, error: `not found: ${file}`, elapsedMs: 0 };
    }
    const reply = this.responders.get(path.posix.basename(file))?.(call.args, call) ?? {};
    return { started: true, code: 0, stdout: '', stderr: '', timedOut: false, error: null, elapsedMs: 5, ...reply };
  };

  hold = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): HeldProcess => {
    const held = new FakeHeld(file, args, env);
    this.holds.push(held);
    if (this.holdEndsWith !== null) held.exit(this.holdEndsWith.code, this.holdEndsWith.stderr);
    return held;
  };

  /** Make a tool exist; returns its absolute path. */
  install(name: string, dir = '/usr/bin'): string {
    const file = `${dir}/${name}`;
    this.present.add(file);
    return file;
  }

  /** Script the replies of an installed tool (matched by file name). */
  on(name: string, responder: Responder): void {
    this.responders.set(name, responder);
  }

  callsTo(name: string): RunCall[] {
    return this.calls.filter((call) => path.posix.basename(call.file) === name);
  }

  /** Mount a working /proc with these processes (plus /proc/stat). */
  mountProc(processes: FakeProcess[], extraEntries: string[] = ['cpuinfo', 'meminfo', 'self', 'stat', 'sys', 'uptime']): void {
    this.dirs.set('/proc', [...extraEntries, ...processes.map((process) => String(process.pid))]);
    this.files.set('/proc/stat', procStatFile());
    for (const process of processes) this.addProcess(process);
  }

  addProcess(process: FakeProcess): void {
    const base = `/proc/${process.pid}`;
    this.files.set(`${base}/stat`, statLine(process));
    if (process.exe !== undefined) this.links.set(`${base}/exe`, process.exe);
    if (process.argv !== undefined) this.files.set(`${base}/cmdline`, `${process.argv.join('\0')}\0`);
    if (process.io !== undefined) this.files.set(`${base}/io`, process.io);
  }
}

export function fakeOptions(): PlatformOptions & { lines: string[] } {
  const lines: string[] = [];
  return { extensionPath: '/opt/extension', log: (message) => lines.push(message), lines };
}
