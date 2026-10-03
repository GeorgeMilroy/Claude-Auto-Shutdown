// Claude config dirs inside RUNNING WSL distros. A session started in WSL keeps its registry in
// the distro's own ~/.claude and its processes are invisible to Windows, so without this the PC
// would shut down underneath it.
//
// Only distros that are already running are touched: opening \\wsl.localhost\<distro> starts a
// stopped one. A UNC path can also hang, so every file operation has a timeout and a distro that
// did not answer is left alone until that operation finally returns.

import * as fs from 'node:fs';
import type { RunResult } from './exec';
import type { RunFn } from './winPower';
import { sentence } from './winRows';
import type { ForeignRoot } from './types';

export interface ForeignRoots {
  roots: ForeignRoot[];
  problem: string | null;
}

export interface WslFs {
  /** Entry names of a directory. Rejects with a Node fs error. */
  readdir(dir: string): Promise<string[]>;
  /** Rejects with a Node fs error when the path cannot be examined (ENOENT included). */
  isDirectory(file: string): Promise<boolean>;
}

export const nodeWslFs: WslFs = {
  readdir: (dir) => fs.promises.readdir(dir),
  isDirectory: async (file) => (await fs.promises.stat(file)).isDirectory(),
};

export interface WslDeps {
  /** Absolute path of System32\wsl.exe; null = it does not exist, so no distro can be running. */
  wslExe: string | null;
  run: RunFn;
  fs: WslFs;
  /** Monotonic milliseconds. */
  now(): number;
  fsTimeoutMs?: number;
}

/** Windows 11 names the WSL virtual machine 'vmmemWSL'; 'wslhost' exists per running distro. */
const DEFINITE_PROCESSES = ['wslhost', 'vmmemwsl'];
/** Older builds call the WSL VM plain 'vmmem' - and so do Hyper-V, Docker and Windows Sandbox. */
const POSSIBLE_PROCESS = 'vmmem';

const UNC_PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\'];
const DISTRO_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const LIST_TIMEOUT_MS = 5_000;
const DEFAULT_FS_TIMEOUT_MS = 3_000;
const CACHE_MS = 60_000;
/** A problem is re-checked sooner so that watching resumes quickly once WSL answers again. */
const PROBLEM_CACHE_MS = 10_000;
const MAX_HOME_FOLDERS = 64;
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
/** Another Linux user's home, or /root for a non-root user: unreadable by design, not a fault. */
const NOT_OURS = new Set(['EACCES', 'EPERM']);

const NOTHING: ForeignRoots = { roots: [], problem: null };

export type WslIndicator = 'definite' | 'possible' | 'none';

export function wslIndicator(processNames: ReadonlySet<string>): WslIndicator {
  if (DEFINITE_PROCESSES.some((name) => processNames.has(name))) return 'definite';
  return processNames.has(POSSIBLE_PROCESS) ? 'possible' : 'none';
}

/**
 * Distro names out of `wsl.exe -l --running -q` (already decoded from UTF-16LE).
 * `unusable` = single words that cannot be a distro folder name; sentences are just messages.
 */
export function parseWslList(stdout: string): { distros: string[]; unusable: string[] } {
  const distros = new Set<string>();
  const unusable: string[] = [];
  for (const raw of stdout.replace(/[\u0000\ufeff]/g, '').split(/[\r\n]+/)) {
    const line = raw.trim();
    if (line === '' || /\s/.test(line)) continue;
    if (DISTRO_NAME.test(line) && line !== '.' && line !== '..') distros.add(line);
    else unusable.push(line);
  }
  return { distros: [...distros], unusable };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; timedOut: boolean; code: string; detail: string };

const TIMED_OUT = Symbol('timed out');

function succeeded(result: RunResult): boolean {
  return result.started && !result.timedOut && result.code === 0;
}

function describeRun(result: RunResult): string {
  if (!result.started) return result.error ?? 'it could not be started';
  if (result.timedOut) return `no answer within ${LIST_TIMEOUT_MS / 1000} seconds`;
  return `exit code ${result.code}`;
}

export class WslRootFinder {
  private readonly fsTimeoutMs: number;
  private cache: { at: number; result: ForeignRoots } | null = null;
  private refreshing: Promise<ForeignRoots> | null = null;
  /** Distros with a file operation that timed out and has not returned yet. */
  private readonly unanswered = new Set<string>();

  constructor(private readonly deps: WslDeps) {
    this.fsTimeoutMs = deps.fsTimeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
  }

  /** `processNames`: lower-case names of the running processes; null = the list is unavailable. */
  async find(processNames: ReadonlySet<string> | null): Promise<ForeignRoots> {
    if (processNames === null) {
      return { roots: [], problem: "Couldn't check whether WSL is running because the list of running programs is unavailable." };
    }
    const indicator = wslIndicator(processNames);
    if (indicator === 'none' || this.deps.wslExe === null) {
      this.cache = null;
      return NOTHING;
    }
    if (this.cache && this.deps.now() - this.cache.at < (this.cache.result.problem ? PROBLEM_CACHE_MS : CACHE_MS)) {
      return this.cache.result;
    }
    this.refreshing ??= this.refresh(this.deps.wslExe, indicator)
      .catch((error): ForeignRoots => ({ roots: [], problem: sentence("WSL couldn't be checked", error instanceof Error ? error.message : String(error)) }))
      .then((result) => {
        this.cache = { at: this.deps.now(), result };
        this.refreshing = null;
        return result;
      });
    return this.refreshing;
  }

  private async refresh(wslExe: string, indicator: WslIndicator): Promise<ForeignRoots> {
    const running = await this.deps.run(wslExe, ['-l', '--running', '-q'], { timeoutMs: LIST_TIMEOUT_MS, encoding: 'utf16le' });
    if (!succeeded(running)) return this.explainListFailure(wslExe, indicator, running);

    const { distros, unusable } = parseWslList(running.stdout);
    const roots: ForeignRoot[] = [];
    const problems = unusable.map((name) => `WSL reported a running distro whose name can't be used as a folder name (${name.slice(0, 80)}).`);
    for (const distro of distros) {
      // Docker Desktop's own distros hold no user home.
      if (distro.toLowerCase().startsWith('docker-desktop')) continue;
      const found = await this.listDistro(distro);
      roots.push(...found.roots);
      if (found.problem) problems.push(found.problem);
    }
    return { roots, problem: problems.length > 0 ? problems.join(' ') : null };
  }

  /**
   * wsl.exe exits non-zero both when it fails and when it merely has nothing to list (no distro
   * running, WSL not installed), and its message is localised. So: plain 'vmmem' alone proves
   * nothing (Hyper-V uses it too); with a WSL-only process running, a working `wsl -l -q` shows
   * that WSL itself is fine and simply has no running distro. Anything else is "can't look".
   */
  private async explainListFailure(wslExe: string, indicator: WslIndicator, running: RunResult): Promise<ForeignRoots> {
    if (indicator !== 'definite') return NOTHING;
    const installed = await this.deps.run(wslExe, ['-l', '-q'], { timeoutMs: LIST_TIMEOUT_MS, encoding: 'utf16le' });
    if (succeeded(installed)) return NOTHING;
    return { roots: [], problem: `WSL is running, but its list of running distros couldn't be read (${describeRun(running)}).` };
  }

  private async listDistro(distro: string): Promise<ForeignRoots> {
    const label = `WSL: ${distro}`;
    const failure = (detail: string, roots: ForeignRoot[] = []): ForeignRoots => ({
      roots,
      problem: `${label}: its files couldn't be read (${detail}), so Claude sessions inside it can't be checked.`,
    });
    if (this.unanswered.has(distro)) return failure('it is still not answering');

    let base: string | null = null;
    let homeFolders: string[] = [];
    let lastError = 'not reachable';
    for (const prefix of UNC_PREFIXES) {
      const candidate = `${prefix}${distro}`;
      const home = await this.attempt(distro, () => this.deps.fs.readdir(`${candidate}\\home`));
      if (home.ok) {
        base = candidate;
        homeFolders = home.value;
        break;
      }
      if (home.timedOut) return failure(home.detail);
      // /home is missing or unreadable - or this UNC name is not served on this Windows build.
      // The distro's top folder tells the two apart.
      const top = await this.attempt(distro, () => this.deps.fs.readdir(`${candidate}\\`));
      if (top.ok) {
        if (!ABSENT.has(home.code)) return failure(`/home: ${home.detail}`);
        base = candidate;
        break;
      }
      if (top.timedOut) return failure(top.detail);
      lastError = top.detail;
    }
    if (base === null) return failure(lastError);
    if (homeFolders.length > MAX_HOME_FOLDERS) return failure(`/home has more than ${MAX_HOME_FOLDERS} folders`);

    const roots: ForeignRoot[] = [];
    const candidates = [...homeFolders.map((user) => `${base}\\home\\${user}\\.claude`), `${base}\\root\\.claude`];
    for (const dir of candidates) {
      const check = await this.attempt(distro, () => this.deps.fs.isDirectory(dir));
      if (check.ok) {
        if (check.value) roots.push({ path: dir, label });
      } else if (check.timedOut || !(ABSENT.has(check.code) || NOT_OURS.has(check.code))) {
        return failure(check.detail, roots);
      }
    }
    return { roots, problem: null };
  }

  /** Runs one file operation with a timeout. A timed-out operation cannot be cancelled, only abandoned. */
  private async attempt<T>(distro: string, operation: () => Promise<T>): Promise<Attempt<T>> {
    const pending = Promise.resolve().then(operation);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), this.fsTimeoutMs)));
    try {
      const value = await Promise.race([pending, timeout]);
      if (value !== TIMED_OUT) return { ok: true, value };
      // Each abandoned operation keeps one of Node's four file threads busy until it returns:
      // do not send more work to this distro before then.
      this.unanswered.add(distro);
      const release = () => this.unanswered.delete(distro);
      pending.then(release, release);
      return { ok: false, timedOut: true, code: 'ETIMEDOUT', detail: `no answer within ${Math.round(this.fsTimeoutMs / 1000)} seconds` };
    } catch (error) {
      const code = typeof (error as NodeJS.ErrnoException)?.code === 'string' ? ((error as NodeJS.ErrnoException).code as string) : 'UNKNOWN';
      return { ok: false, timedOut: false, code, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}
