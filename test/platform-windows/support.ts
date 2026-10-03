// Shared helpers for the Windows platform tests: a scripted fake helper process and process checks.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunResult } from '../../src/platform/exec';
import type { HelperLaunch } from '../../src/platform/winHelper';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const HELPER_SCRIPT = path.join(REPO_ROOT, 'resources', 'win-helper.ps1');
export const ALERT_SCRIPT = path.join(REPO_ROOT, 'resources', 'win-countdown-alert.ps1');
const FAKE_HELPER = path.join(__dirname, 'fakeHelper.mjs');
const FAKE_ALERT = path.join(__dirname, 'fakeAlert.mjs');

/** What one start of the fake helper does. See fakeHelper.mjs. */
export interface FakePlan {
  exitBeforeHello?: { code?: number; stderr?: string };
  /** false = never greet; an object overrides fields of the greeting. */
  hello?: false | Record<string, unknown>;
  native?: boolean;
  /** Overrides applied when the helper is started with -NoNative. */
  whenNoNative?: FakePlan;
  banner?: string;
  crlf?: boolean;
  chunk?: number;
  garbageBeforeReply?: boolean;
  replies?: Record<string, Record<string, unknown>>;
  hangOn?: string;
  dieOn?: string;
  /** Answer this op with megabytes of output that never ends in a line break. */
  floodOn?: string;
  ignoreStdinEnd?: boolean;
  /** When stdin closes: write this to stderr and exit with this code (default 1). */
  onStdinEnd?: { code?: number; stderr?: string };
}

export interface FakeLogEntry {
  event: 'spawn' | 'request' | 'stdin-end';
  n: number;
  args?: string[];
  pid?: number;
  raw?: string;
  request?: Record<string, unknown>;
}

export interface FakeHelper {
  launch: HelperLaunch;
  log(): FakeLogEntry[];
  spawns(): FakeLogEntry[];
  requests(op?: string): Record<string, unknown>[];
  cleanup(): void;
}

export function makeFakeHelper(spawns: FakePlan[]): FakeHelper {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  const logFile = path.join(dir, 'fake.log');
  const configFile = path.join(dir, 'fake.json');
  fs.writeFileSync(configFile, JSON.stringify({ log: logFile, spawns }));
  const log = (): FakeLogEntry[] =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeLogEntry)
      : [];
  return {
    // Not the temp dir: Windows cannot delete a folder that a just-killed process still has as cwd.
    launch: { file: process.execPath, args: [FAKE_HELPER, configFile], cwd: __dirname },
    log,
    spawns: () => log().filter((entry) => entry.event === 'spawn'),
    requests: (op) =>
      log()
        .filter((entry) => entry.event === 'request' && (op === undefined || entry.request?.op === op))
        .map((entry) => entry.request as Record<string, unknown>),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  };
}

export function fakeAlertLaunch(mode: string, file?: string, extraArgs: string[] = []) {
  return { file: process.execPath, args: [FAKE_ALERT, mode, file ?? '', ...extraArgs], cwd: __dirname, env: {} as Record<string, string> };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return condition();
}

export const waitUntilGone = (pid: number, timeoutMs = 5000) => waitFor(() => !isAlive(pid), timeoutMs);

/** A finished process as `run()` reports it. */
export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return { started: true, code: 0, stdout: '', stderr: '', timedOut: false, error: null, elapsedMs: 40, ...overrides };
}
