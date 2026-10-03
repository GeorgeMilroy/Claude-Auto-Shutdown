// Fakes for the controller tests. Nothing here touches the real machine: time is a hand-cranked
// clock, the platform only records what it was asked to do, the scanner replays a script, and the
// state dir is a fresh temp folder per test.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Controller } from '../../src/controller/controller';
import type { Clock, ControllerDeps, ControllerStartOptions } from '../../src/controller/controller';
import type { EvaluateInput } from '../../src/core/evaluate';
import type { ScanRequest } from '../../src/core/scanner';
import type { Check, CheckData, CheckId, CheckState, ScanResult, Session, Verdict } from '../../src/core/types';
import type {
  ActionResult,
  Capability,
  CountdownAlert,
  CountdownAlertOptions,
  ForeignRoot,
  HelperStatus,
  Platform,
  ProcDetail,
  SnapshotRequest,
  SystemSnapshot,
} from '../../src/platform/types';
import { DEFAULT_CONFIG, contractDigest, toArmContract } from '../../src/shared/config';
import type { Config, PowerAction } from '../../src/shared/config';
import type { Command, CommandResult, LeaderInfo, UiState, WindowHello } from '../../src/shared/protocol';
import { StateDir } from '../../src/shared/stateDir';

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------

/** Lets every promise continuation that is ready run. No timers, no real waiting. */
export async function drain(): Promise<void> {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

interface FakeTimer {
  id: number;
  due: number;
  callback: () => void;
}

export class FakeClock implements Clock {
  private wall = Date.UTC(2026, 0, 15, 2, 0, 0);
  private monoMs = 50_000;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.wall;
  }

  mono(): number {
    return this.monoMs;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, due: this.monoMs + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Timers currently scheduled. */
  get pending(): number {
    return this.timers.length;
  }

  /** Both clocks move together; due timers fire in order, each followed by a microtask drain. */
  async advance(ms: number): Promise<void> {
    const target = this.monoMs + ms;
    await drain();
    for (;;) {
      const next = this.earliestDue(target);
      if (next === null) break;
      this.moveTo(Math.max(next.due, this.monoMs));
      this.timers = this.timers.filter((timer) => timer !== next);
      next.callback();
      await drain();
    }
    this.moveTo(target);
    await drain();
  }

  /** Time passes on both clocks without any timer firing: a stall, or a sleep. */
  skip(ms: number): void {
    this.monoMs += ms;
    this.wall += ms;
  }

  /** Only the wall clock moves: somebody changed the clock (or, on Linux, the PC slept). */
  shiftWall(ms: number): void {
    this.wall += ms;
  }

  private moveTo(mono: number): void {
    this.wall += mono - this.monoMs;
    this.monoMs = mono;
  }

  private earliestDue(target: number): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const timer of this.timers) {
      if (timer.due > target) continue;
      if (best === null || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) best = timer;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------------------------

export class FakeAlert implements CountdownAlert {
  readonly options: CountdownAlertOptions;
  stopped = false;
  private listener: (() => void) | null = null;

  constructor(options: CountdownAlertOptions) {
    this.options = options;
  }

  onCancel(listener: () => void): void {
    this.listener = listener;
  }

  stop(): void {
    this.stopped = true;
  }

  /** The user presses the alert's Cancel button. */
  press(): void {
    this.listener?.();
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records every call. `execute` never touches the machine: it returns `executeResult`. */
export class FakePlatform implements Platform {
  readonly id = 'windows' as const;
  readonly osName = 'Windows';
  readonly procStartUnitsPerSecond = 10_000_000;
  readonly experimental = false;

  environment: string | null = null;
  helper: HelperStatus = { tier: 'full', problem: null };
  capabilityOf: Partial<Record<PowerAction, Capability>> = {};
  idle: number | null = 10_000;
  executeResult: ActionResult | Error | Promise<ActionResult> = { ok: true, detail: 'command sent', command: 'fake', exitCode: 0, confirmed: null };
  /** Runs inside execute(), before it returns: lets a test look at the world at that instant. */
  onExecute: (() => void) | null = null;
  keepAwakeOk = true;

  readonly executeCalls: { action: PowerAction; force: boolean }[] = [];
  readonly keepAwakeCalls: boolean[] = [];
  readonly capabilityCalls: PowerAction[] = [];
  readonly alerts: FakeAlert[] = [];
  idleCalls = 0;
  disposed = false;

  environmentProblem(): string | null {
    return this.environment;
  }

  helperStatus(): HelperStatus {
    return this.helper;
  }

  snapshot(_request: SnapshotRequest): Promise<SystemSnapshot> {
    return Promise.resolve({ takenAtMs: 0, idleSeconds: this.idle, processes: [], details: {}, problem: null });
  }

  probe(_pids: number[]): Promise<Record<number, ProcDetail>> {
    return Promise.resolve({});
  }

  idleSeconds(): Promise<number | null> {
    this.idleCalls++;
    return Promise.resolve(this.idle);
  }

  capability(action: PowerAction): Promise<Capability> {
    this.capabilityCalls.push(action);
    return Promise.resolve(this.capabilityOf[action] ?? { ok: true, detail: 'Allowed' });
  }

  execute(action: PowerAction, options: { force: boolean }): Promise<ActionResult> {
    this.executeCalls.push({ action, force: options.force });
    this.onExecute?.();
    if (this.executeResult instanceof Error) return Promise.reject(this.executeResult);
    return Promise.resolve(this.executeResult);
  }

  keepAwake(on: boolean): Promise<{ ok: boolean; detail: string }> {
    this.keepAwakeCalls.push(on);
    return Promise.resolve({ ok: this.keepAwakeOk, detail: this.keepAwakeOk ? 'ok' : 'not available' });
  }

  startCountdownAlert(options: CountdownAlertOptions): CountdownAlert {
    const alert = new FakeAlert(options);
    this.alerts.push(alert);
    return alert;
  }

  foreignRoots(): Promise<{ roots: ForeignRoot[]; problem: string | null }> {
    return Promise.resolve({ roots: [], problem: null });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Scanner and scans
// ---------------------------------------------------------------------------------------------

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    key: '0:4242:aaaa1111',
    origin: 'registry',
    liveness: 'verified',
    pid: 4242,
    sessionId: 'aaaa1111',
    name: 'web-ui',
    cwd: 'C:\\work\\web-ui',
    folder: 'web-ui',
    entrypoint: 'cli',
    rootLabel: '~/.claude',
    startedAtMs: 1_768_000_000_000,
    transcriptPath: 'C:\\fixture\\.claude\\projects\\web-ui\\aaaa1111.jsonl',
    lastActivityMs: 1_768_440_000_000,
    silenceSeconds: 900,
    turn: 'CLOSED',
    turnReason: 'turnEnded',
    turnDetail: null,
    activeSubagents: 0,
    subagents: [],
    children: [],
    status: 'finished',
    working: false,
    why: { id: 'quiet' },
    ignoreKey: 'session:0:4242:aaaa1111:1000:1768440000:0',
    ignored: false,
    ...overrides,
  };
}

export function workingSession(overrides: Partial<Session> = {}): Session {
  return makeSession({
    silenceSeconds: 3,
    turn: 'OPEN',
    turnReason: 'toolInFlight',
    status: 'working',
    working: true,
    why: { id: 'turnOpen' },
    ...overrides,
  });
}

export function makeScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    startedAtMs: 0,
    completedAtMs: 0,
    sessions: [makeSession()],
    errors: [],
    roots: [{ path: 'C:\\fixture\\.claude', label: '~/.claude', kind: 'local', ok: true, missing: false, detail: null }],
    strays: [],
    unclaimedRecent: [],
    idleSeconds: 10_000,
    guardHits: [],
    processListOk: true,
    helperProblem: null,
    ...overrides,
  };
}

/** One finished session, the user away: every check of the fake evaluate passes. */
export const clearScan = (): ScanResult => makeScan();
/** One session in the middle of a tool call. */
export const busyScan = (name = 'web-ui'): ScanResult => makeScan({ sessions: [workingSession({ name })] });

export class FakeScanner {
  readonly requests: ScanRequest[] = [];
  /** What each scan returns; `index` counts scans from 0. Replace it to script a scenario. */
  script: (request: ScanRequest, index: number) => ScanResult | Promise<ScanResult> = () => clearScan();

  scan(request: ScanRequest): Promise<ScanResult> {
    this.requests.push(request);
    try {
      return Promise.resolve(this.script(request, this.requests.length - 1));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------------------------

function check(id: CheckId, state: CheckState, data: CheckData = {}): Check {
  return { id, state, data };
}

/**
 * A deliberately simple stand-in for core/evaluate.ts: the same shape and the same counting
 * rule, with `allClear` read straight off flags in the scripted scan.
 */
export function fakeEvaluate(input: EvaluateInput): Verdict {
  const { scan, contract } = input;
  const checks: Check[] = [
    check('armed', input.armed ? 'pass' : 'waiting'),
    check('stopFile', input.stopPresent ? 'fail' : 'pass'),
    check(
      'scanner',
      scan === null || input.scanStale || scan.errors.length > 0 ? 'cantTell' : 'pass',
      { reason: scan === null ? 'noScan' : input.scanStale ? 'stale' : 'errors' },
    ),
    check('helper', input.environmentProblem !== null || input.helperTier === 'unavailable' ? 'fail' : 'pass'),
  ];

  const capability = input.capability;
  if (contract.action === 'notify') checks.push(check('actionAllowed', 'pass'));
  else if (capability === null || capability.ok === null) checks.push(check('actionAllowed', 'cantTell'));
  else checks.push(check('actionAllowed', capability.ok ? 'pass' : 'fail'));

  if (input.remoteWindows.length > 0) {
    const blocking = input.remoteWindows.some((window) => !window.ignored && !window.covered);
    checks.push(check('remoteWindows', blocking ? 'cantTell' : 'pass'));
  }
  const working = scan?.sessions.filter((session) => session.working && !session.ignored) ?? [];
  checks.push(check('sessionsIdle', scan === null ? 'cantTell' : working.length > 0 ? 'waiting' : 'pass'));
  if (contract.requireUserIdle) {
    const idle = scan?.idleSeconds ?? null;
    const away = idle !== null && Number.isFinite(idle) && idle >= contract.userIdleSeconds;
    checks.push(check('userIdle', idle === null ? 'cantTell' : away ? 'pass' : 'waiting'));
  }

  const allClear = checks.every((entry) => entry.state === 'pass');
  const k = allClear ? input.stablePolls + 1 : 0;
  const confirmed = k >= contract.requiredPolls;
  checks.push(check('confirmed', confirmed ? 'pass' : 'waiting', { k, n: contract.requiredPolls }));
  return { checks, allClear, ok: allClear && confirmed, stablePolls: k, requiredPolls: contract.requiredPolls };
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

export const LEADER: LeaderInfo = {
  windowId: 'window-leader',
  label: 'claude-auto-shutdown',
  app: 'Visual Studio Code',
  ext: '0.1.0',
  pid: 4321,
  realm: 'realm-vscode',
};

export const HELLO: WindowHello = {
  windowId: 'window-follower',
  pid: 9876,
  app: 'Visual Studio Code',
  ext: '0.1.0',
  realm: LEADER.realm,
  label: 'web-ui',
  remote: null,
};

/** Mutable stand-ins for everything the glue would answer. */
export interface World {
  config: Config;
  viewers: boolean;
  remoteWindows: string[];
  leader: boolean;
}

export interface HarnessOptions {
  config?: Partial<Config>;
  viewers?: boolean;
  /** false = construct only; the test calls controller.start() itself. */
  start?: Partial<ControllerStartOptions> | false;
  /** Reuse a state dir (a second leader on the same machine). */
  dir?: string;
  deps?: Partial<ControllerDeps>;
}

/** poll every 10 s, 3 checks in a row, 30 s countdown, for real, shut down. */
export const TEST_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  testMode: false,
  pollSeconds: 10,
  requiredPolls: 3,
  countdownSeconds: 30,
  guardProcesses: [],
  extraClaudeDirs: [],
};

const tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  tempDirs.push(dir);
  return dir;
}

/** Call from afterEach. */
export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export class Harness {
  readonly clock = new FakeClock();
  readonly platform = new FakePlatform();
  readonly scanner = new FakeScanner();
  readonly stateDir: StateDir;
  readonly world: World;
  readonly controller: Controller;
  /** Every published state, with the monotonic time it was published at. */
  readonly published: { state: UiState; mono: number }[] = [];

  constructor(options: HarnessOptions = {}) {
    this.stateDir = new StateDir(options.dir ?? makeTempDir());
    this.world = {
      config: { ...TEST_CONFIG, ...options.config },
      viewers: options.viewers ?? false,
      remoteWindows: [],
      leader: true,
    };
    this.controller = new Controller({
      platform: this.platform,
      scanner: this.scanner,
      evaluate: fakeEvaluate,
      stateDir: this.stateDir,
      clock: this.clock,
      getConfig: () => this.world.config,
      leader: LEADER,
      hostname: 'test-pc',
      getRemoteWindows: () => this.world.remoteWindows,
      hasViewers: () => this.world.viewers,
      stillLeader: () => this.world.leader,
      ...options.deps,
    });
    this.controller.onState((state) => this.published.push({ state, mono: this.clock.mono() }));
    if (options.start !== false) {
      this.controller.start({ handover: null, previousLeaderWasWatching: false, freshStart: false, ...options.start });
    }
  }

  get state(): UiState {
    return this.controller.getState();
  }

  async send(command: Command, from: WindowHello = HELLO): Promise<CommandResult> {
    const result = await this.controller.handleCommand(command, from);
    await drain();
    return result;
  }

  /** The `arm` command a window in the leader's own editor would send for the current settings. */
  armCommand(change: Partial<Extract<Command, { name: 'arm' }>> = {}): Command {
    const contract = toArmContract(this.world.config);
    return {
      name: 'arm',
      contract,
      digest: contractDigest(contract),
      epoch: this.state.epoch,
      realm: LEADER.realm,
      ...change,
    };
  }

  arm(change: Partial<Extract<Command, { name: 'arm' }>> = {}): Promise<CommandResult> {
    return this.send(this.armCommand(change));
  }

  /** Arm and let exactly `requiredPolls` clear polls happen: the countdown has just started. */
  async armUntilCountdown(): Promise<void> {
    const result = await this.arm();
    if (!result.ok) throw new Error(`arm was refused: ${result.error}`);
    const { pollSeconds, requiredPolls } = this.world.config;
    await this.clock.advance(pollSeconds * 1000 * (requiredPolls - 1));
    if (this.state.phase !== 'countdown') throw new Error(`expected a countdown, got phase ${this.state.phase}`);
  }

  /** Advance in small steps until the condition holds. Throws when it never does. */
  async advanceUntil(condition: (state: UiState) => boolean, maxMs = 600_000, stepMs = 250): Promise<void> {
    for (let waited = 0; waited <= maxMs; waited += stepMs) {
      if (condition(this.state)) return;
      await this.clock.advance(stepMs);
    }
    throw new Error(`condition not reached within ${maxMs} ms (phase ${this.state.phase})`);
  }

  createStopFile(name = 'STOP'): void {
    fs.writeFileSync(path.join(this.stateDir.dir, name), '');
  }

  logText(): string {
    return fs.existsSync(this.stateDir.logFile) ? fs.readFileSync(this.stateDir.logFile, 'utf8') : '';
  }

  logLines(containing: string): string[] {
    return this.logText()
      .split('\n')
      .filter((line) => line.includes(containing));
  }

  lastRunFile(): unknown {
    return this.stateDir.readJson(this.stateDir.lastRunFile);
  }

  watchingFileExists(): boolean {
    return fs.existsSync(this.stateDir.watchRecordFile);
  }
}
