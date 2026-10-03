// Linux / macOS: the endpoint is a unix socket file, and a crashed leader leaves that file
// behind. Removing it is check-then-act - the same shape as a lock steal - so every creation and
// removal of the socket file happens under an atomic mkdir guard, and the leader keeps re-checking
// that the file at the path is still the one it created.
//
// NOT RUN ON A REAL POSIX SYSTEM YET. The OS calls sit behind SocketFs / listen / connect so the
// decisions below are unit-tested with fakes; the default bindings at the bottom are the part
// that still has to be exercised on Linux and macOS.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  errorCode,
  retry,
  tryConnect,
  tryListen,
  type Claim,
  type ConnectResult,
  type EndpointClaimer,
  type ListenResult,
} from './endpoint';
import { CONNECT_TIMEOUT_MS, TAKEOVER_GUARD_STALE_MS, TAKEOVER_GUARD_WAIT_MS } from './timing';

/** sun_path holds 104 bytes on macOS (108 on Linux), including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

/** The file-system calls the takeover needs. Every method throws like node:fs does. */
export interface SocketFs {
  /** The path itself, without following a symlink. */
  describe(target: string): { directory: boolean; uid: number; mode: number };
  /** `<device>:<inode>` of whatever is at the path now. */
  identity(target: string): string;
  modifiedMs(target: string): number;
  makeDirectory(target: string): void;
  removeDirectory(target: string): void;
  removeFile(target: string): void;
}

export interface SocketClaimerDeps {
  fs: SocketFs;
  listen(socketPath: string): Promise<ListenResult>;
  connect(socketPath: string, timeoutMs: number, signal: AbortSignal): Promise<ConnectResult>;
  /** This process's user id; null = cannot tell (which refuses the endpoint). */
  uid: number | null;
  now(): number;
}

export function socketPathProblem(socketPath: string): string | null {
  return Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES
    ? `the socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes: ${socketPath}`
    : null;
}

/**
 * The socket's folder must belong to this user and be closed to everybody else; otherwise another
 * account could plant or replace the endpoint. A folder that cannot be inspected is refused too.
 */
export function directoryProblem(files: SocketFs, directory: string, uid: number | null): string | null {
  let info: ReturnType<SocketFs['describe']>;
  try {
    info = files.describe(directory);
  } catch (error) {
    return `can't inspect ${directory} (${errorCode(error)})`;
  }
  if (!info.directory) return `${directory} is not a folder`;
  if (uid === null || info.uid !== uid) return `${directory} is not owned by this user`;
  if ((info.mode & 0o077) !== 0) return `${directory} is open to other users (it must be mode 0700)`;
  return null;
}

/**
 * Only "nothing is there" (ENOENT) and "a file is there but nobody listens behind it"
 * (ECONNREFUSED) can mean the endpoint is free. A timeout, or any other error, says nothing about
 * the leader being dead and never permits a takeover.
 */
export function permitsTakeover(connectError: string): boolean {
  return connectError === 'ENOENT' || connectError === 'ECONNREFUSED';
}

/**
 * mkdir is atomic: exactly one contender gets the guard. A guard older than 10 s belongs to a
 * window that died while holding it; it is removed and the caller starts over.
 */
export function acquireGuard(files: SocketFs, guard: string, nowMs: number): boolean {
  try {
    files.makeDirectory(guard);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') removeGuardIfStale(files, guard, nowMs);
    return false;
  }
}

function removeGuardIfStale(files: SocketFs, guard: string, nowMs: number): void {
  try {
    const ageMs = nowMs - files.modifiedMs(guard);
    if (Number.isFinite(ageMs) && ageMs > TAKEOVER_GUARD_STALE_MS) files.removeDirectory(guard);
  } catch {
    // its holder released it in the meantime, or it cannot be read: the next round finds out
  }
}

export function releaseGuard(files: SocketFs, guard: string): void {
  try {
    files.removeDirectory(guard);
  } catch {
    // already removed (a contender judged it stale); nothing left to release
  }
}

function removeSocketFile(files: SocketFs, socketPath: string): void {
  try {
    files.removeFile(socketPath);
  } catch {
    // already gone; listen() decides whether the path is really free
  }
}

/** null = there is no readable socket file at the path. */
export function socketIdentity(files: SocketFs, socketPath: string): string | null {
  try {
    return files.identity(socketPath);
  } catch {
    return null;
  }
}

export class SocketClaimer implements EndpointClaimer {
  private readonly socketPath: string;
  private readonly guard: string;
  private readonly deps: SocketClaimerDeps;

  constructor(socketPath: string, deps: Partial<SocketClaimerDeps> = {}) {
    this.socketPath = socketPath;
    this.guard = `${socketPath}.takeover`;
    this.deps = { ...defaultDeps(), ...deps };
  }

  async attempt(signal: AbortSignal): Promise<Claim> {
    const { fs: files, uid } = this.deps;
    const problem = socketPathProblem(this.socketPath) ?? directoryProblem(files, path.dirname(this.socketPath), uid);
    if (problem !== null) return retry(problem);

    const first = await this.connect(signal);
    if ('socket' in first) return { kind: 'follower', socket: first.socket };
    if (!permitsTakeover(first.error)) return retry(`could not connect to the leader (${first.error})`);
    return this.claimUnderGuard(signal);
  }

  /**
   * The guard is taken for a missing file as well as for a dead one. bind() and listen() are two
   * system calls; without the guard, a contender that probes in between sees ECONNREFUSED and
   * removes the socket file of a leader that is just being born.
   */
  private async claimUnderGuard(signal: AbortSignal): Promise<Claim> {
    const { fs: files } = this.deps;
    if (!acquireGuard(files, this.guard, this.deps.now())) {
      return retry('another window is claiming the endpoint', TAKEOVER_GUARD_WAIT_MS);
    }
    try {
      // Look again now that nobody else can create or remove the file.
      const second = await this.connect(signal);
      if ('socket' in second) return { kind: 'follower', socket: second.socket };
      if (!permitsTakeover(second.error)) return retry(`could not connect to the leader (${second.error})`);
      if (second.error === 'ECONNREFUSED') removeSocketFile(files, this.socketPath);
      return await this.listen();
    } finally {
      releaseGuard(files, this.guard);
    }
  }

  private async listen(): Promise<Claim> {
    const { fs: files } = this.deps;
    const listened = await this.deps.listen(this.socketPath);
    if ('error' in listened) return retry(`could not listen on the endpoint (${listened.error})`);
    const { server } = listened;
    const created = socketIdentity(files, this.socketPath);
    if (created === null) {
      server.close();
      return retry('the socket file vanished right after it was created');
    }
    // Backstop for the one race the guard cannot close (two contenders removing a stale guard):
    // a leader whose file was replaced or removed must notice and step down.
    // Stepping down closes the server, and libuv unlinks the socket PATH on close, whoever's file
    // is there by then. The window that replaced it then fails this same check and steps down as
    // well, and everybody re-elects on a free path: one extra election, never two leaders.
    const stillOwned = (): boolean => server.listening && socketIdentity(files, this.socketPath) === created;
    return { kind: 'leader', server, stillOwned };
  }

  private connect(signal: AbortSignal): Promise<ConnectResult> {
    return this.deps.connect(this.socketPath, CONNECT_TIMEOUT_MS, signal);
  }
}

const nodeSocketFs: SocketFs = {
  describe(target) {
    const stats = fs.lstatSync(target);
    return { directory: stats.isDirectory(), uid: stats.uid, mode: stats.mode };
  },
  identity(target) {
    // bigint: inode numbers do not fit a double on every file system
    const stats = fs.statSync(target, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  },
  modifiedMs: (target) => fs.statSync(target).mtimeMs,
  makeDirectory: (target) => void fs.mkdirSync(target, { mode: 0o700 }),
  removeDirectory: (target) => fs.rmdirSync(target),
  removeFile: (target) => fs.unlinkSync(target),
};

function defaultDeps(): SocketClaimerDeps {
  return {
    fs: nodeSocketFs,
    listen: tryListen,
    connect: tryConnect,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    now: () => Date.now(),
  };
}
