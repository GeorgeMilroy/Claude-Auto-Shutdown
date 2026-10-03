// Runs a system tool the safe way: absolute path, args array, no shell, fixed cwd, timeout.
// Never rejects - a failure to start, a timeout and a non-zero exit all come back as a result.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunOptions {
  timeoutMs: number;
  /** Defaults to the directory of `file` (never the workspace folder). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  input?: string;
  /** Decode stdout / stderr with this encoding (wsl.exe prints UTF-16LE). Default utf8. */
  encoding?: BufferEncoding;
  /** Cap on collected output per stream; the rest is dropped. Default 1 MB. */
  maxBytes?: number;
}

export interface RunResult {
  /** The process was started. */
  started: boolean;
  /** Exit code; null when it did not start, was killed, or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error text (ENOENT, EACCES, ...), else null. */
  error: string | null;
  /** Wall-clock ms between spawn and exit / timeout (to detect "we slept through it"). */
  elapsedMs: number;
}

/** `file` must be an absolute path to an existing file; otherwise nothing is spawned. */
export function run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const failed = (error: string): RunResult => ({
    started: false,
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    error,
    elapsedMs: Date.now() - startedAt,
  });
  if (!path.isAbsolute(file)) return Promise.resolve(failed(`refusing to run a non-absolute path: ${file}`));
  if (!fs.existsSync(file)) return Promise.resolve(failed(`not found: ${file}`));

  return new Promise<RunResult>((resolve) => {
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const encoding = options.encoding ?? 'utf8';
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd ?? path.dirname(file),
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(failed(e instanceof Error ? e.message : String(e)));
      return;
    }

    const finish = (code: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        started: error === null || out.length > 0 || code !== null,
        code: timedOut ? null : code,
        stdout: Buffer.concat(out).toString(encoding),
        stderr: Buffer.concat(err).toString(encoding),
        timedOut,
        error,
        elapsedMs: Date.now() - startedAt,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null, null);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < maxBytes) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code, null));
    // A child that never reads stdin must not take the extension host down with EPIPE.
    child.stdin?.on('error', () => undefined);
    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

/** First existing absolute path out of the candidates, else null. */
export function firstExisting(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** POSIX: find a system tool in fixed directories only (never via PATH). */
export function findSystemTool(name: string): string | null {
  return firstExisting(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'].map((dir) => `${dir}/${name}`));
}

/** Windows: absolute path of a System32 binary, or null when it does not exist. */
export function system32(...segments: string[]): string | null {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) return null;
  const file = path.join(root, 'System32', ...segments);
  return fs.existsSync(file) ? file : null;
}
