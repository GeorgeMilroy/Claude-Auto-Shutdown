// Client for resources/win-helper.ps1: one long-lived PowerShell process that answers JSON lines.
//
// Rules this file enforces (see the helper script for the measurements behind them):
// - one fixed command line, script file by absolute path, no shell, no -EncodedCommand;
// - the helper is stopped by closing its stdin, and killed if it is still alive shortly after;
// - a helper that never greets is asked why the same way (a refused script only says so then);
// - a request that is not answered in time kills the helper and counts as failed;
// - a helper that cannot run at all is reported as 'unavailable' - never as "nothing is running".

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { powershellPath } from './winPower';
import { isRecord } from './winRows';
import type { HelperStatus, HelperTier } from './types';

/** Version of the line protocol spoken by the helper script shipped with this build. */
export const HELPER_PROTOCOL = 2;

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 4000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** After a process is gone, its last error output may still be in the pipe for a moment. */
const STDERR_DRAIN_MS = 500;
/** The execution-policy refusal carries this error id in every display language. */
const POLICY_REFUSAL = /UnauthorizedAccess/;

export interface HelperLaunch {
  file: string;
  args: string[];
  cwd: string;
}

/** The one command line the helper is ever started with. */
export function buildHelperLaunch(systemRoot: string, extensionPath: string, parentPid: number): HelperLaunch {
  const file = powershellPath(systemRoot);
  return {
    file,
    args: [
      '-NoProfile',
      '-NonInteractive',
      // Windows clients default to "Restricted", which refuses every script file.
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(extensionPath, 'resources', 'win-helper.ps1'),
      '-ParentPid',
      String(parentPid),
      '-IdleExitSeconds',
      '120',
    ],
    cwd: path.win32.dirname(file),
  };
}

/** JSON on one line with everything outside printable ASCII escaped (stdin has no fixed code page). */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface HelperHello {
  pid: number;
  native: boolean;
  nativeError: string | null;
  psVersion: string;
  languageMode: string;
}

type HelloOutcome =
  | { kind: 'hello'; hello: HelperHello }
  | { kind: 'badHello'; detail: string }
  | { kind: 'exited'; code: number | null; stderr: string }
  | { kind: 'timeout' };

type RequestOutcome = { kind: 'reply'; message: Record<string, unknown> } | { kind: 'timeout' } | { kind: 'exited' };

interface Pending {
  settle(outcome: RequestOutcome): void;
  timer: NodeJS.Timeout;
}

function parseHello(message: Record<string, unknown>): HelloOutcome {
  if (message.hello !== true) return { kind: 'badHello', detail: 'the first line was not a greeting' };
  if (message.protocol !== HELPER_PROTOCOL) return { kind: 'badHello', detail: `it speaks protocol ${String(message.protocol)}, expected ${HELPER_PROTOCOL}` };
  const { pid, native } = message;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof native !== 'boolean') {
    return { kind: 'badHello', detail: 'the greeting was incomplete' };
  }
  return {
    kind: 'hello',
    hello: {
      pid,
      native,
      nativeError: typeof message.nativeError === 'string' ? message.nativeError : null,
      psVersion: typeof message.psVersion === 'string' ? message.psVersion : '',
      languageMode: typeof message.languageMode === 'string' ? message.languageMode : '',
    },
  };
}

/** One running helper process: line framing, request ids, per-request timeouts. */
class HelperProcess {
  private readonly child: ChildProcess | null;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrText = '';
  private nextId = 1;
  private ended = false;
  private exitCode: number | null = null;
  private resolveExited!: () => void;
  /** Resolves once the process is gone (or never started). */
  readonly exited = new Promise<void>((resolve) => (this.resolveExited = resolve));
  private resolveDrained!: () => void;
  /** Resolves once the process is gone AND its output pipes were read to the end. */
  private readonly drained = new Promise<void>((resolve) => (this.resolveDrained = resolve));

  constructor(launch: HelperLaunch) {
    let child: ChildProcess | null = null;
    try {
      child = spawn(launch.file, launch.args, { cwd: launch.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.stderrText = error instanceof Error ? error.message : String(error);
    }
    this.child = child;
    if (!child) {
      this.finish(null);
      this.resolveDrained();
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrText.length < MAX_STDERR_CHARS) this.stderrText += chunk.toString('latin1');
    });
    child.on('error', (error) => {
      this.stderrText ||= error.message;
      this.finish(null);
      this.resolveDrained();
    });
    child.on('exit', (code) => this.finish(code));
    child.on('close', () => this.resolveDrained());
    // Writing to a helper that just died must not take the extension host down with EPIPE.
    child.stdin?.on('error', () => undefined);
  }

  get alive(): boolean {
    return !this.ended;
  }

  /**
   * The greeting, or why there is none.
   *
   * PowerShell reports a script it refuses to load (execution policy) only once its stdin reaches
   * end-of-file; until then it sits there in silence. So a helper that does not greet in time gets
   * its stdin closed and `graceMs` to say why. 'timeout' = it had nothing to say: it is still
   * running, or it ended normally (a script that was merely too slow ends when stdin closes).
   */
  async waitHello(timeoutMs: number, graceMs: number): Promise<HelloOutcome> {
    const outcome = await this.expect(0, timeoutMs);
    if (outcome.kind === 'reply') return parseHello(outcome.message);
    if (outcome.kind === 'timeout') {
      this.closeStdin();
      await settledWithin(this.exited, graceMs);
      if (!this.ended || this.exitCode === 0) return { kind: 'timeout' };
    }
    await settledWithin(this.drained, STDERR_DRAIN_MS);
    return { kind: 'exited', code: this.exitCode, stderr: this.stderrText };
  }

  request(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<RequestOutcome> {
    if (this.ended || !this.child?.stdin?.writable) return Promise.resolve({ kind: 'exited' });
    const id = this.nextId++;
    const outcome = this.expect(id, timeoutMs);
    this.child.stdin.write(`${asciiJson({ ...params, id, op })}\n`);
    return outcome;
  }

  /** Ask the helper to end: it exits as soon as its stdin reaches end-of-file. */
  closeStdin(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      // already closed
    }
  }

  kill(): void {
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
  }

  private expect(id: number, timeoutMs: number): Promise<RequestOutcome> {
    if (this.ended) return Promise.resolve({ kind: 'exited' });
    return new Promise<RequestOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        settle: (outcome) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(outcome);
        },
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      // The cmdlet-only tier writes CRLF.
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > 0) this.onLine(line.toString('utf8'));
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.kill();
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not ours (PowerShell prints its banner when it cannot open the script): no reply follows.
      return;
    }
    if (!isRecord(message) || typeof message.id !== 'number') return;
    this.pending.get(message.id)?.settle({ kind: 'reply', message });
  }

  private finish(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    for (const pending of [...this.pending.values()]) pending.settle({ kind: 'exited' });
    this.resolveExited();
  }
}

export interface WinHelperOptions {
  /** How to start the helper; null = it cannot be started on this PC (see `launchProblem`). */
  launch: HelperLaunch | null;
  launchProblem?: string;
  log(message: string): void;
  /** No greeting within this time = that start attempt failed. */
  helloTimeoutMs?: number;
  /** No answer within this time = the request failed and the helper is killed. */
  requestTimeoutMs?: number;
  /** How long a helper gets to exit after its stdin was closed before it is killed. */
  stopGraceMs?: number;
  /** Wait before starting again after a failed start; doubles with every further failure. */
  restartBackoffMs?: number;
}

export type HelperReply =
  /** `generation` identifies the helper process that answered (state such as keep-awake dies with it). */
  { ok: true; body: Record<string, unknown>; generation: number } | { ok: false; error: string };

const NO_LAUNCH_PROBLEM = "The process helper can't be started on this PC.";

const POLICY_PROBLEM =
  "Windows doesn't allow this extension's PowerShell helper to run on this PC (blocked by a script policy), so the programs running on it can't be checked.";

function limitedProblem(reason: string | null): string {
  const why = reason ? ` (${reason.replace(/\s+/g, ' ').trim().slice(0, 200)})` : '';
  return `Part of this extension's helper can't run on this PC${why}. Running programs can still be checked, but idle time, keep-awake and Sleep are unavailable.`;
}

/** Waits for `done`, but no longer than `ms`. Leaves no timer behind. */
async function settledWithin(done: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const overdue = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  await Promise.race([done, overdue]);
  clearTimeout(timer);
}

/**
 * Keeps at most one helper alive: started lazily on first use, restarted after it dies, with one
 * retry per call. Every public method resolves; nothing here rejects.
 */
export class WinHelper {
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly restartBackoffMs: number;

  private current: HelperProcess | null = null;
  private launching: HelperProcess | null = null;
  private starting: Promise<HelperProcess | null> | null = null;
  private hello: HelperHello | null = null;
  private generationValue = 0;
  /**
   * Before the first start nothing is known to be wrong. That is safe: every answer that matters
   * (process list, capability) fails closed on its own when the helper turns out not to work.
   */
  private tier: HelperTier = 'full';
  private problem: string | null = null;
  /**
   * Why a start with the native code failed (it hung or crashed). Once set, later starts go
   * straight to the cmdlet tier instead of waiting for the same failure again.
   */
  private nativeFailure: string | null = null;
  private failedStarts = 0;
  private retryNotBefore = 0;
  private disposed = false;

  constructor(private readonly options: WinHelperOptions) {
    this.helloTimeoutMs = options.helloTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.stopGraceMs = options.stopGraceMs ?? 2_000;
    this.restartBackoffMs = options.restartBackoffMs ?? 30_000;
    if (!options.launch) {
      this.tier = 'unavailable';
      this.problem = options.launchProblem ?? NO_LAUNCH_PROBLEM;
    }
  }

  status(): HelperStatus {
    return { tier: this.tier, problem: this.problem };
  }

  /** A helper process is up right now. */
  get running(): boolean {
    return this.current?.alive === true;
  }

  /** Increases with every helper process that came up. */
  get generation(): number {
    return this.generationValue;
  }

  /** true / false once a helper has greeted; null = none has yet. */
  get native(): boolean | null {
    return this.hello ? this.hello.native : null;
  }

  /** PID of the running helper, else null. */
  get pid(): number | null {
    return this.running && this.hello ? this.hello.pid : null;
  }

  async call(op: string, params: Record<string, unknown> = {}): Promise<HelperReply> {
    // One retry: a helper that died (idle exit, crash) is restarted once per call.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.disposed) return { ok: false, error: 'the helper has been stopped' };
      const helper = await this.ensureStarted();
      if (!helper) return { ok: false, error: this.problem ?? 'the helper is not available' };
      const generation = this.generationValue;
      const outcome = await helper.request(op, params, this.requestTimeoutMs);
      if (outcome.kind === 'reply') {
        const { message } = outcome;
        if (message.ok === true) return { ok: true, body: message, generation };
        return { ok: false, error: typeof message.error === 'string' ? message.error : 'the helper reported an error' };
      }
      if (outcome.kind === 'timeout') {
        // A helper that stopped answering cannot be trusted with the next request either.
        helper.kill();
        if (this.current === helper) this.current = null;
        this.options.log(`Process helper did not answer "${op}" within ${this.requestTimeoutMs} ms; it was stopped.`);
        return { ok: false, error: `the helper did not answer within ${Math.round(this.requestTimeoutMs / 1000)} seconds` };
      }
    }
    return { ok: false, error: 'the helper stopped while answering' };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.launching?.kill();
    const helper = this.current;
    this.current = null;
    if (!helper || !helper.alive) return;
    helper.closeStdin();
    await settledWithin(helper.exited, this.stopGraceMs);
    if (helper.alive) {
      helper.kill();
      await settledWithin(helper.exited, 1_000);
    }
  }

  private ensureStarted(): Promise<HelperProcess | null> {
    if (this.current?.alive) return Promise.resolve(this.current);
    if (this.starting) return this.starting;
    if (performance.now() < this.retryNotBefore) return Promise.resolve(null);
    this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<HelperProcess | null> {
    const { launch } = this.options;
    if (!launch) return null;
    let failure = '';
    let reason = '';
    for (const withoutNative of this.nativeFailure !== null ? [true] : [false, true]) {
      if (this.disposed) return null;
      const helper = new HelperProcess(withoutNative ? { ...launch, args: [...launch.args, '-NoNative'] } : launch);
      this.launching = helper;
      const outcome = await helper.waitHello(this.helloTimeoutMs, this.stopGraceMs);
      this.launching = null;
      if (this.disposed) {
        helper.kill();
        return null;
      }
      if (outcome.kind === 'hello') {
        if (withoutNative) this.nativeFailure ??= reason;
        this.adopt(helper, outcome.hello);
        return helper;
      }
      helper.kill();
      if (outcome.kind === 'exited' && POLICY_REFUSAL.test(outcome.stderr)) {
        failure = POLICY_PROBLEM;
        break;
      }
      reason = describeStartFailure(outcome);
      failure = `The process helper could not be started: ${reason}.`;
      // A wrong greeting means a wrong script; starting it again without native code changes nothing.
      if (outcome.kind === 'badHello') break;
    }
    this.markUnavailable(failure);
    return null;
  }

  private adopt(helper: HelperProcess, hello: HelperHello): void {
    this.current = helper;
    this.hello = hello;
    this.generationValue++;
    this.failedStarts = 0;
    this.retryNotBefore = 0;
    this.tier = hello.native ? 'full' : 'limited';
    this.problem = hello.native ? null : limitedProblem(this.nativeFailure ?? hello.nativeError);
    this.options.log(
      `Process helper started (PID ${hello.pid}, ${hello.native ? 'native' : 'cmdlet-only'} tier, PowerShell ${hello.psVersion}).` +
        (this.problem ? ` ${this.problem}` : ''),
    );
    void helper.exited.then(() => {
      if (this.current === helper) this.current = null;
    });
  }

  private markUnavailable(problem: string): void {
    this.tier = 'unavailable';
    this.problem = problem;
    this.failedStarts++;
    const wait = Math.min(this.restartBackoffMs * 2 ** (this.failedStarts - 1), MAX_BACKOFF_MS);
    this.retryNotBefore = performance.now() + wait;
    this.options.log(`${problem} Trying again in ${Math.round(wait / 1000)} s.`);
  }
}

function describeStartFailure(outcome: Exclude<HelloOutcome, { kind: 'hello' }>): string {
  switch (outcome.kind) {
    case 'timeout':
      return 'PowerShell did not answer in time';
    case 'badHello':
      return outcome.detail;
    case 'exited': {
      const message = outcome.stderr.replace(/\s+/g, ' ').trim().slice(0, 300);
      return `PowerShell ended${outcome.code === null ? '' : ` with code ${outcome.code}`}${message ? ` (${message})` : ''}`;
    }
  }
}
