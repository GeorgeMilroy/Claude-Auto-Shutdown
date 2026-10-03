import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GuardedFs, listDir, nodeFs, type FsApi } from '../../src/core/scannerFs';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** An fs that records its calls and answers each kind of call the way the test says. */
function scriptedFs(readdir: (dir: string) => Promise<never[]>): { api: FsApi; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: {
      readdir: (dir) => {
        calls.push(dir);
        return readdir(dir);
      },
      stat: () => never(),
      readSmallFile: () => never(),
    },
  };
}

describe('GuardedFs', () => {
  it('passes results and errors through', async () => {
    const guarded = new GuardedFs(scriptedFs(async (dir) => (dir === 'bad' ? Promise.reject(new Error('EIO: i/o error')) : [])).api, 50);
    await expect(guarded.readdir('good')).resolves.toEqual([]);
    await expect(guarded.readdir('bad')).rejects.toThrow('EIO');
  });

  it('gives up on an operation that does not answer in time', async () => {
    const guarded = new GuardedFs(scriptedFs(() => never()).api, 20);
    await expect(guarded.readdir('hung')).rejects.toMatchObject({ code: 'ETIMEDOUT', message: 'no answer within 0.02 s' });
  });

  it('fails every later operation at once after a timeout, without starting it', async () => {
    const { api, calls } = scriptedFs((dir) => (dir === 'hung' ? never() : Promise.resolve([])));
    const guarded = new GuardedFs(api, 20);
    await expect(guarded.readdir('fine')).resolves.toEqual([]);
    await expect(guarded.readdir('hung')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(guarded.readdir('fine')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(guarded.stat('fine')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(guarded.guard(async () => 'unreached')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(calls).toEqual(['fine', 'hung']);
  });

  it('applies the limit to a read done elsewhere', async () => {
    const guarded = new GuardedFs(nodeFs, 20);
    await expect(guarded.guard(async () => 'turn')).resolves.toBe('turn');
    await expect(guarded.guard(() => never())).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('never times out without a limit', async () => {
    const guarded = new GuardedFs(scriptedFs(() => new Promise((resolve) => setTimeout(() => resolve([]), 60))).api, null);
    await expect(guarded.readdir('slow')).resolves.toEqual([]);
  });

  it('turns a synchronous throw into a rejection and stays usable', async () => {
    const guarded = new GuardedFs(nodeFs, 20);
    await expect(
      guarded.guard(() => {
        throw new Error('thrown before any promise');
      }),
    ).rejects.toThrow('thrown before any promise');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(guarded.guard(async () => 'still fine')).resolves.toBe('still fine');
  });
});

describe('nodeFs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-scanner-fs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists entries with their kind', async () => {
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    fs.mkdirSync(path.join(dir, 'sub'));
    const entries = await nodeFs.readdir(dir);
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'a.json', kind: 'file' },
      { name: 'sub', kind: 'dir' },
    ]);
  });

  it('reads a small file together with its write time', async () => {
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, '{"pid": 1}');
    fs.utimesSync(file, new Date(1_790_000_000_000), new Date(1_790_000_000_000));
    await expect(nodeFs.readSmallFile(file, 1024)).resolves.toEqual({ text: '{"pid": 1}', mtimeMs: 1_790_000_000_000 });
  });

  it('refuses a file over the limit and a folder', async () => {
    const file = path.join(dir, 'big.json');
    fs.writeFileSync(file, 'x'.repeat(2000));
    await expect(nodeFs.readSmallFile(file, 1024)).rejects.toMatchObject({ code: 'EFBIG' });
    await expect(nodeFs.readSmallFile(dir, 1024)).rejects.toBeInstanceOf(Error);
  });

  it('says whether a path is a regular file', async () => {
    fs.writeFileSync(path.join(dir, 'a.jsonl'), 'abc');
    await expect(nodeFs.stat(path.join(dir, 'a.jsonl'))).resolves.toMatchObject({ size: 3, isFile: true });
    await expect(nodeFs.stat(dir)).resolves.toMatchObject({ isFile: false });
    await expect(nodeFs.stat(path.join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('listDir', () => {
  it('tells a missing folder from one that could not be read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-scanner-fs-'));
    try {
      fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
      await expect(listDir(nodeFs, dir)).resolves.toMatchObject({ state: 'ok' });
      await expect(listDir(nodeFs, path.join(dir, 'nope'))).resolves.toEqual({ state: 'missing' });
      const denied: FsApi = { ...nodeFs, readdir: () => Promise.reject(Object.assign(new Error("EACCES: permission denied, scandir 'x'"), { code: 'EACCES' })) };
      await expect(listDir(denied, dir)).resolves.toEqual({ state: 'failed', reason: 'EACCES: permission denied' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
