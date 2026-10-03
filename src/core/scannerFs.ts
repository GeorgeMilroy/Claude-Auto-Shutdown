// The scanner's file access: three operations, and a guard that keeps a network path that stopped
// answering (a WSL share, \\wsl.localhost\...) from stalling the whole scan.

import * as fs from 'node:fs';

import { errorText, isMissing } from './scannerSupport';

export type EntryKind = 'file' | 'dir' | 'other';

export interface DirEntry {
  name: string;
  /** 'other' = a link or something else that only a stat can tell apart. */
  kind: EntryKind;
}

export interface FileInfo {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface SmallFile {
  text: string;
  /** Last write, read AFTER the content. */
  mtimeMs: number;
}

export interface FsApi {
  readdir(dir: string): Promise<DirEntry[]>;
  /** Follows links. */
  stat(file: string): Promise<FileInfo>;
  /** Rejects (code EFBIG) instead of loading a file larger than `maxBytes`. */
  readSmallFile(file: string, maxBytes: number): Promise<SmallFile>;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function readdir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other',
  }));
}

async function stat(file: string): Promise<FileInfo> {
  const stats = await fs.promises.stat(file);
  return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
}

async function readSmallFile(file: string, maxBytes: number): Promise<SmallFile> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw codedError('EISDIR', 'not a regular file');
    if (before.size > maxBytes) throw codedError('EFBIG', `larger than ${maxBytes} bytes`);
    const text = await handle.readFile('utf8');
    // The write time is taken after the content, so it is never older than what was read. Liveness
    // treats "the process started after this file was written" as proof of a reused PID, and a
    // write time older than the content could prove that about the very process that wrote it.
    const after = await handle.stat();
    return { text, mtimeMs: after.mtimeMs };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const nodeFs: FsApi = { readdir, stat, readSmallFile };

class FsTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(timeoutMs: number) {
    super(`no answer within ${timeoutMs / 1000} s`);
  }
}

/**
 * File access for one Claude folder during one scan. With a timeout (folders in another system)
 * every operation gives up after that long, and after the first one that did, the rest fail at
 * once: each hung call parks a thread of Node's small I/O pool, and a few of them would stall the
 * reads of every healthy folder too.
 */
export class GuardedFs implements FsApi {
  private stalled = false;

  constructor(
    private readonly api: FsApi,
    private readonly timeoutMs: number | null,
  ) {}

  readdir(dir: string): Promise<DirEntry[]> {
    return this.guard(() => this.api.readdir(dir));
  }

  stat(file: string): Promise<FileInfo> {
    return this.guard(() => this.api.stat(file));
  }

  readSmallFile(file: string, maxBytes: number): Promise<SmallFile> {
    return this.guard(() => this.api.readSmallFile(file, maxBytes));
  }

  /** Applies the same limit to a read that is done elsewhere (the transcript module). */
  async guard<T>(operation: () => Promise<T>): Promise<T> {
    const timeoutMs = this.timeoutMs;
    if (timeoutMs === null) return operation();
    if (this.stalled) throw new FsTimeoutError(timeoutMs);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.stalled = true;
        reject(new FsTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type Listing =
  | { state: 'ok'; entries: DirEntry[] }
  | { state: 'missing' }
  | { state: 'failed'; reason: string };

/** A folder's entries. Not existing is an answer of its own; anything else that fails is `failed`. */
export async function listDir(api: FsApi, dir: string): Promise<Listing> {
  try {
    return { state: 'ok', entries: await api.readdir(dir) };
  } catch (error) {
    return isMissing(error) ? { state: 'missing' } : { state: 'failed', reason: errorText(error) };
  }
}
