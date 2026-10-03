// The POSIX takeover cannot run on the machine these tests were written on, so its decisions are
// exercised against a fake file system and fake sockets. What this does NOT cover: the real
// bindings to node:fs / node:net at the bottom of posixEndpoint.ts.

import type * as net from 'node:net';

import { describe, expect, it } from 'vitest';

import type { Claim, ConnectResult, ListenResult } from '../../src/coordination/endpoint';
import {
  acquireGuard,
  directoryProblem,
  MAX_SOCKET_PATH_BYTES,
  permitsTakeover,
  releaseGuard,
  SocketClaimer,
  socketIdentity,
  socketPathProblem,
  type SocketFs,
} from '../../src/coordination/posixEndpoint';
import { TAKEOVER_GUARD_WAIT_MS } from '../../src/coordination/timing';

const FOLDER = '/home/me/.claude-auto-shutdown';
const SOCKET = `${FOLDER}/leader.sock`;
const GUARD = `${SOCKET}.takeover`;
const ME = 1000;

interface Entry {
  kind: 'folder' | 'socket' | 'file';
  uid: number;
  mode: number;
  identity: string;
  modifiedMs: number;
  listening: boolean;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** An in-memory stand-in for the file system and the unix sockets in it. */
class FakeSystem {
  readonly entries = new Map<string, Entry>();
  /** Every change made, in order. */
  readonly changes: string[] = [];
  /** Errors the next connect() calls are forced to fail with. */
  readonly connectFailures: string[] = [];
  /** Runs right before the n-th connect() answers (1-based): lets a test move the world in between. */
  readonly beforeConnect = new Map<number, () => void>();
  nowMs = 5_000_000;
  connects = 0;
  private nextInode = 100;

  constructor() {
    this.put(FOLDER, { kind: 'folder', mode: 0o40700 });
  }

  put(target: string, entry: Partial<Entry> & { kind: Entry['kind'] }): Entry {
    const complete: Entry = {
      uid: ME,
      mode: 0o600,
      identity: `8:${this.nextInode++}`,
      modifiedMs: this.nowMs,
      listening: false,
      ...entry,
    };
    this.entries.set(target, complete);
    return complete;
  }

  private need(target: string): Entry {
    const entry = this.entries.get(target);
    if (!entry) throw errno('ENOENT');
    return entry;
  }

  readonly fs: SocketFs = {
    describe: (target) => {
      const entry = this.need(target);
      return { directory: entry.kind === 'folder', uid: entry.uid, mode: entry.mode };
    },
    identity: (target) => this.need(target).identity,
    modifiedMs: (target) => this.need(target).modifiedMs,
    makeDirectory: (target) => {
      if (this.entries.has(target)) throw errno('EEXIST');
      this.put(target, { kind: 'folder', mode: 0o40700 });
      this.changes.push(`mkdir ${target}`);
    },
    removeDirectory: (target) => {
      this.need(target);
      this.entries.delete(target);
      this.changes.push(`rmdir ${target}`);
    },
    removeFile: (target) => {
      this.need(target);
      this.entries.delete(target);
      this.changes.push(`unlink ${target}`);
    },
  };

  readonly listen = async (target: string): Promise<ListenResult> => {
    if (this.entries.has(target)) return { error: 'EADDRINUSE' };
    const entry = this.put(target, { kind: 'socket', listening: true });
    this.changes.push(`listen ${target}`);
    const server = {
      get listening() {
        return entry.listening;
      },
      close: () => {
        entry.listening = false;
      },
    };
    return { server: server as unknown as net.Server };
  };

  readonly connect = async (target: string): Promise<ConnectResult> => {
    this.connects += 1;
    this.beforeConnect.get(this.connects)?.();
    const forced = this.connectFailures.shift();
    if (forced) return { error: forced };
    const entry = this.entries.get(target);
    if (!entry) return { error: 'ENOENT' };
    if (!entry.listening) return { error: 'ECONNREFUSED' };
    return { socket: { leader: entry.identity } as unknown as net.Socket };
  };

  claimer(overrides: { uid?: number | null; socketPath?: string } = {}): SocketClaimer {
    return new SocketClaimer(overrides.socketPath ?? SOCKET, {
      fs: this.fs,
      listen: this.listen,
      connect: this.connect,
      uid: overrides.uid === undefined ? ME : overrides.uid,
      now: () => this.nowMs,
    });
  }

  attempt(): Promise<Claim> {
    return this.claimer().attempt(new AbortController().signal);
  }
}

describe('who may use the socket folder', () => {
  it('accepts a folder that is the user\'s own and closed to everybody else', () => {
    const system = new FakeSystem();

    expect(directoryProblem(system.fs, FOLDER, ME)).toBeNull();
  });

  it.each<[string, Partial<Entry> | null, RegExp]>([
    ['is missing', null, /can't inspect .* \(ENOENT\)/],
    ['is a file', { kind: 'file' }, /not a folder/],
    ['belongs to somebody else', { mode: 0o40700, uid: 0 }, /not owned/],
    ['is readable by the group', { mode: 0o40750 }, /open to other users/],
    ['is writable by everybody', { mode: 0o40777 }, /open to other users/],
  ])('refuses a folder that %s, and touches nothing', async (_name, folder, problem) => {
    const system = new FakeSystem();
    if (folder === null) system.entries.delete(FOLDER);
    else system.put(FOLDER, { kind: 'folder', ...folder });

    expect(directoryProblem(system.fs, FOLDER, ME)).toMatch(problem);
    const claim = await system.attempt();
    expect(claim).toMatchObject({ kind: 'retry' });
    expect(system.connects).toBe(0);
    expect(system.changes).toEqual([]);
  });

  it('refuses when it cannot tell who this process runs as', async () => {
    const system = new FakeSystem();

    expect(directoryProblem(system.fs, FOLDER, null)).toMatch(/not owned/);
    expect(await system.claimer({ uid: null }).attempt(new AbortController().signal)).toMatchObject({ kind: 'retry' });
    expect(system.connects).toBe(0);
  });

  it('refuses a socket path that does not fit in sun_path', async () => {
    const system = new FakeSystem();
    const longPath = `/${'d'.repeat(MAX_SOCKET_PATH_BYTES)}/leader.sock`;

    expect(socketPathProblem(SOCKET)).toBeNull();
    expect(socketPathProblem('x'.repeat(MAX_SOCKET_PATH_BYTES))).toBeNull();
    expect(socketPathProblem('x'.repeat(MAX_SOCKET_PATH_BYTES + 1))).toMatch(/longer than 103 bytes/);
    expect(socketPathProblem('ż'.repeat(60))).toMatch(/longer than 103 bytes/);
    expect(await system.claimer({ socketPath: longPath }).attempt(new AbortController().signal)).toMatchObject({
      kind: 'retry',
    });
    expect(system.connects).toBe(0);
  });
});

describe('which connect errors permit a takeover', () => {
  it('only "nothing there" and "nobody listening"', () => {
    expect(permitsTakeover('ENOENT')).toBe(true);
    expect(permitsTakeover('ECONNREFUSED')).toBe(true);
    for (const other of ['TIMEOUT', 'ABORTED', 'EACCES', 'EPERM', 'ENOTSOCK', 'EAGAIN', 'UNKNOWN', '']) {
      expect(permitsTakeover(other)).toBe(false);
    }
  });
});

describe('the takeover guard', () => {
  it('goes to exactly one contender and can be taken again after release', () => {
    const system = new FakeSystem();

    expect(acquireGuard(system.fs, GUARD, system.nowMs)).toBe(true);
    expect(acquireGuard(system.fs, GUARD, system.nowMs)).toBe(false);
    expect(system.entries.has(GUARD)).toBe(true);

    releaseGuard(system.fs, GUARD);
    releaseGuard(system.fs, GUARD);
    expect(acquireGuard(system.fs, GUARD, system.nowMs)).toBe(true);
  });

  it('is left alone while it is at most 10 s old', () => {
    const system = new FakeSystem();
    system.put(GUARD, { kind: 'folder', modifiedMs: system.nowMs - 10_000 });

    expect(acquireGuard(system.fs, GUARD, system.nowMs)).toBe(false);
    expect(system.entries.has(GUARD)).toBe(true);
  });

  it('is removed, not taken, when it is older than 10 s: the contender starts over', () => {
    const system = new FakeSystem();
    system.put(GUARD, { kind: 'folder', modifiedMs: system.nowMs - 10_001 });

    expect(acquireGuard(system.fs, GUARD, system.nowMs)).toBe(false);
    expect(system.entries.has(GUARD)).toBe(false);
    expect(acquireGuard(system.fs, GUARD, system.nowMs)).toBe(true);
  });

  it('is not taken when the folder cannot be written', () => {
    const system = new FakeSystem();
    const readOnly: SocketFs = {
      ...system.fs,
      makeDirectory: () => {
        throw errno('EACCES');
      },
    };

    expect(acquireGuard(readOnly, GUARD, system.nowMs)).toBe(false);
  });
});

describe('one round of the election', () => {
  it('follows a leader that answers, without touching the file system', async () => {
    const system = new FakeSystem();
    const leader = system.put(SOCKET, { kind: 'socket', listening: true });

    const claim = await system.attempt();

    expect(claim).toMatchObject({ kind: 'follower', socket: { leader: leader.identity } });
    expect(system.changes).toEqual([]);
  });

  it('becomes leader on a free endpoint, creating the socket under the guard', async () => {
    const system = new FakeSystem();

    const claim = await system.attempt();

    expect(claim.kind).toBe('leader');
    expect(system.changes).toEqual([`mkdir ${GUARD}`, `listen ${SOCKET}`, `rmdir ${GUARD}`]);
    expect(system.connects).toBe(2);
  });

  it('takes over from a crashed leader: guard, look again, remove the dead file, listen, release', async () => {
    const system = new FakeSystem();
    system.put(SOCKET, { kind: 'socket', listening: false });

    const claim = await system.attempt();

    expect(claim.kind).toBe('leader');
    expect(system.changes).toEqual([`mkdir ${GUARD}`, `unlink ${SOCKET}`, `listen ${SOCKET}`, `rmdir ${GUARD}`]);
  });

  it('follows a leader that appeared while it was taking the guard, and removes nothing', async () => {
    const system = new FakeSystem();
    system.put(SOCKET, { kind: 'socket', listening: false });
    system.beforeConnect.set(2, () => system.put(SOCKET, { kind: 'socket', listening: true }));

    const claim = await system.attempt();

    expect(claim.kind).toBe('follower');
    expect(system.changes).toEqual([`mkdir ${GUARD}`, `rmdir ${GUARD}`]);
    expect(system.entries.get(SOCKET)?.listening).toBe(true);
  });

  it('waits 50-150 ms and starts over when another window holds the guard', async () => {
    const system = new FakeSystem();
    system.put(SOCKET, { kind: 'socket', listening: false });
    system.put(GUARD, { kind: 'folder' });

    const claim = await system.attempt();

    expect(claim).toMatchObject({ kind: 'retry', delayMs: TAKEOVER_GUARD_WAIT_MS });
    expect(TAKEOVER_GUARD_WAIT_MS).toEqual([50, 150]);
    expect(system.changes).toEqual([]);
    expect(system.entries.has(SOCKET)).toBe(true);
    expect(system.entries.has(GUARD)).toBe(true);
  });

  it('clears a guard left by a window that died holding it, then wins the next round', async () => {
    const system = new FakeSystem();
    system.put(SOCKET, { kind: 'socket', listening: false });
    system.put(GUARD, { kind: 'folder', modifiedMs: system.nowMs - 60_000 });

    const first = await system.attempt();
    expect(first.kind).toBe('retry');
    expect(system.changes).toEqual([`rmdir ${GUARD}`]);
    expect(system.entries.has(SOCKET)).toBe(true);

    const second = await system.attempt();
    expect(second.kind).toBe('leader');
  });

  it.each(['TIMEOUT', 'EACCES', 'ABORTED'])('never takes over after a connect that failed with %s', async (failure) => {
    const system = new FakeSystem();
    system.put(SOCKET, { kind: 'socket', listening: true });
    system.connectFailures.push(failure);

    const claim = await system.attempt();

    expect(claim.kind).toBe('retry');
    expect(system.changes).toEqual([]);
    expect(system.entries.has(SOCKET)).toBe(true);
  });

  it.each(['TIMEOUT', 'EACCES', 'ABORTED'])(
    'gives the guard back and removes nothing when the second look fails with %s',
    async (failure) => {
      const system = new FakeSystem();
      system.put(SOCKET, { kind: 'socket', listening: false });
      system.connectFailures.push('ECONNREFUSED', failure);

      const claim = await system.attempt();

      expect(claim.kind).toBe('retry');
      expect(system.changes).toEqual([`mkdir ${GUARD}`, `rmdir ${GUARD}`]);
      expect(system.entries.has(SOCKET)).toBe(true);
    },
  );

  it('gives the guard back when listening fails', async () => {
    const system = new FakeSystem();
    // Both looks say "nothing there", yet something occupies the path by the time of the bind.
    system.connectFailures.push('ENOENT', 'ENOENT');
    system.put(SOCKET, { kind: 'file' });

    const claim = await system.attempt();

    expect(claim).toMatchObject({ kind: 'retry', reason: expect.stringContaining('EADDRINUSE') });
    expect(system.changes).toEqual([`mkdir ${GUARD}`, `rmdir ${GUARD}`]);
  });

  it('gives the guard back even when listening throws', async () => {
    const system = new FakeSystem();
    const claimer = new SocketClaimer(SOCKET, {
      fs: system.fs,
      connect: system.connect,
      listen: () => Promise.reject(new Error('boom')),
      uid: ME,
      now: () => system.nowMs,
    });

    await expect(claimer.attempt(new AbortController().signal)).rejects.toThrow('boom');
    expect(system.entries.has(GUARD)).toBe(false);
  });
});

describe('a leader re-checking that the endpoint is still its own', () => {
  async function lead(system: FakeSystem): Promise<Extract<Claim, { kind: 'leader' }>> {
    const claim = await system.attempt();
    if (claim.kind !== 'leader') throw new Error(`expected to lead, got ${claim.kind}`);
    return claim;
  }

  it('says yes while its socket file is the one at the path', async () => {
    const system = new FakeSystem();
    const claim = await lead(system);

    expect(claim.stillOwned()).toBe(true);
    expect(socketIdentity(system.fs, SOCKET)).toBe(system.entries.get(SOCKET)?.identity);
  });

  it('says no once another process replaced the file', async () => {
    const system = new FakeSystem();
    const claim = await lead(system);

    system.put(SOCKET, { kind: 'socket', listening: true });

    expect(claim.stillOwned()).toBe(false);
  });

  it('says no once the file is gone', async () => {
    const system = new FakeSystem();
    const claim = await lead(system);

    system.entries.delete(SOCKET);

    expect(socketIdentity(system.fs, SOCKET)).toBeNull();
    expect(claim.stillOwned()).toBe(false);
  });

  it('says no once its server stopped listening', async () => {
    const system = new FakeSystem();
    const claim = await lead(system);

    claim.server.close();

    expect(claim.stillOwned()).toBe(false);
  });

  it('does not lead when the file it just created cannot be found', async () => {
    const system = new FakeSystem();
    const vanishing = new SocketClaimer(SOCKET, {
      fs: system.fs,
      connect: system.connect,
      listen: async (target) => {
        const listened = await system.listen(target);
        system.entries.delete(target);
        return listened;
      },
      uid: ME,
      now: () => system.nowMs,
    });

    const claim = await vanishing.attempt(new AbortController().signal);

    expect(claim).toMatchObject({ kind: 'retry', reason: expect.stringContaining('vanished') });
    expect(system.entries.has(GUARD)).toBe(false);
  });
});
