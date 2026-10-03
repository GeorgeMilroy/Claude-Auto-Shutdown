// The seam between the POSIX backends and the machine. Every file read and every child process of
// linux.ts / macos.ts goes through PosixSystem, so their complete snapshot / probe / capability /
// execute paths run in unit tests against a fake: neither backend can be exercised live on the
// machine this extension is developed on.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { run, type RunOptions, type RunResult } from './exec';

export interface HeldExit {
  /** Exit code; null when it did not start or was killed. */
  code: number | null;
  /** What it wrote to stderr, or the spawn error. */
  stderr: string;
}

/** A child that is kept running on purpose (a sleep inhibitor). */
export interface HeldProcess {
  /** Settles when the process has ended or could not be started. Never rejects. */
  readonly exited: Promise<HeldExit>;
  /** Close its stdin and terminate it. Idempotent. */
  stop(): void;
}

export interface PosixSystem {
  /** The live environment (not a copy): the power guard must see changes made after start-up. */
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  now(): number;
  delay(ms: number): Promise<void>;
  /** These three reject with a Node errno error (`code`: ENOENT, EACCES, ESRCH, ...). */
  readFile(file: string): Promise<string>;
  readlink(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  exists(file: string): boolean;
  /** One-shot tool: absolute path, args array, no shell, timeout. Never rejects. */
  run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** Long-lived tool with a stdin pipe that stays open until stop() or until this process dies. */
  hold(file: string, args: readonly string[], env: NodeJS.ProcessEnv): HeldProcess;
}

const HELD_STDERR_MAX_BYTES = 64 * 1024;

function holdProcess(file: string, args: readonly string[], env: NodeJS.ProcessEnv): HeldProcess {
  let child: ChildProcess | null = null;
  const exited = new Promise<HeldExit>((resolve) => {
    if (!path.isAbsolute(file)) {
      resolve({ code: null, stderr: `refusing to run a non-absolute path: ${file}` });
      return;
    }
    try {
      child = spawn(file, [...args], {
        cwd: path.dirname(file),
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const stderr: Buffer[] = [];
    let bytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (bytes < HELD_STDERR_MAX_BYTES) stderr.push(chunk);
      bytes += chunk.length;
    });
    child.on('error', (error) => resolve({ code: null, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin?.on('error', () => undefined);
  });
  return {
    exited,
    stop() {
      child?.stdin?.end();
      child?.kill();
    },
  };
}

export function createPosixSystem(): PosixSystem {
  return {
    env: process.env,
    pid: process.pid,
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readFile: (file) => fs.promises.readFile(file, 'utf8'),
    readlink: (file) => fs.promises.readlink(file),
    readdir: (dir) => fs.promises.readdir(dir),
    exists: (file) => fs.existsSync(file),
    run,
    hold: holdProcess,
  };
}

/**
 * Root-owned directories that hold system tools. Never PATH: a workspace must not be able to
 * supply its own `systemctl`. The last entry is where NixOS keeps every system tool.
 */
const TOOL_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/run/current-system/sw/bin'] as const;

/** Absolute path of a system tool, or null when it is not installed. */
export function findTool(system: Pick<PosixSystem, 'exists'>, name: string): string | null {
  for (const dir of TOOL_DIRS) {
    const file = `${dir}/${name}`;
    if (system.exists(file)) return file;
  }
  return null;
}

const SNAP_ORIGINAL_SUFFIX = '_VSCODE_SNAP_ORIG';

function leakedByEditor(key: string): boolean {
  return key === 'LD_LIBRARY_PATH' || key === 'GIO_MODULE_DIR' || key.startsWith('GTK_');
}

/**
 * Environment for a spawned system tool. An editor packaged as a snap points the loader and
 * GIO / GTK at its own bundled libraries, which breaks host tools such as gdbus; the snap wrapper
 * keeps each original value in `<NAME>_VSCODE_SNAP_ORIG` (empty = was not set), so put those back.
 */
export function sanitiseToolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.endsWith(SNAP_ORIGINAL_SUFFIX) || leakedByEditor(key)) continue;
    clean[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.endsWith(SNAP_ORIGINAL_SUFFIX)) continue;
    const name = key.slice(0, -SNAP_ORIGINAL_SUFFIX.length);
    if (name === '') continue;
    if (value === '') delete clean[name];
    else clean[name] = value;
  }
  return clean;
}
