// Registry entries and liveness, through the whole scanner: what is listed, what is dropped, and
// what is reported.

import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeFs, type FsApi } from '../../src/core/scannerFs';
import { CLAUDE_EXE, CLOSED, NOW, OPEN, SESSION_START, createWorkspace, filetime, only, type Workspace } from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
/** Registry files are written an hour before NOW unless a test says otherwise. */
const ENTRY_WRITTEN = NOW - 3600_000;

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
});
afterEach(() => ws.cleanup());

describe('a verified session', () => {
  it('is listed with everything the registry says about it', async () => {
    ws.liveSession(4242, ID, { name: 'checkout flow', startedAt: SESSION_START + 500 });
    const transcript = ws.claude.transcript('C--work-shop', ID, CLOSED, NOW - 1000_000);

    const result = await ws.scan();

    expect(result.errors).toEqual([]);
    expect(only(result)).toMatchObject({
      key: `0:4242:${ID}`,
      origin: 'registry',
      liveness: 'verified',
      pid: 4242,
      sessionId: ID,
      name: 'checkout flow',
      cwd: 'C:\\work\\shop',
      folder: 'shop',
      entrypoint: 'cli',
      rootLabel: '~/.claude',
      startedAtMs: SESSION_START + 500,
      transcriptPath: transcript,
      lastActivityMs: NOW - 1000_000,
      silenceSeconds: 1000,
      turn: 'CLOSED',
      turnReason: 'turnEnded',
      status: 'finished',
      working: false,
      ignored: false,
    });
    expect(result).toMatchObject({ startedAtMs: NOW, completedAtMs: NOW, processListOk: true, idleSeconds: 900, helperProblem: null });
  });

  it('asks the platform about every registry PID and about processes named claude', async () => {
    ws.liveSession(4242, ID);
    ws.liveSession(4343, 'bbbbbbbb-1111-2222-3333-444444444444');
    await ws.scan();
    expect(ws.platform.snapshotRequests).toHaveLength(1);
    expect(ws.platform.snapshotRequests[0]?.detailNames).toEqual(['claude']);
    expect([...(ws.platform.snapshotRequests[0]?.detailPids ?? [])].sort()).toEqual([4242, 4343]);
  });

  it('is named after its id, or its file, when the registry gives no name', async () => {
    ws.liveSession(4242, ID);
    ws.claude.rawSession('legacy.json', JSON.stringify({ pid: 4343, procStart: filetime(SESSION_START) }));
    ws.platform.run(4343, 'claude', 1, { path: CLAUDE_EXE });

    const result = await ws.scan();

    expect(result.sessions.map((session) => [session.name, session.key]).sort()).toEqual([
      ['aaaaaaaa', `0:4242:${ID}`],
      ['legacy.json', '0:4343:legacy.json'],
    ]);
  });
});

describe('liveness', () => {
  it('drops an entry whose PID was reused after the entry was written', async () => {
    ws.claude.session({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) });
    const reusedAt = ENTRY_WRITTEN + 2001;
    ws.platform.run(4242, 'claude', 1, { path: CLAUDE_EXE, startRaw: filetime(reusedAt), startEpochMs: reusedAt });

    const result = await ws.scan();

    expect(result.sessions).toEqual([]);
    expect(result.errors).toEqual([]);
    // The process that has the PID now is a Claude process nobody registered.
    expect(result.strays?.map((stray) => stray.pid)).toEqual([4242]);
  });

  it('keeps an entry as unverified when the start time differs without proof of reuse', async () => {
    ws.claude.session({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) });
    ws.claude.transcript('p', ID, CLOSED, NOW - 1000_000);
    const startedAt = ENTRY_WRITTEN - 60_000;
    ws.platform.run(4242, 'claude', 1, { path: CLAUDE_EXE, startRaw: filetime(startedAt), startEpochMs: startedAt });

    const result = await ws.scan();

    expect(only(result)).toMatchObject({ liveness: 'unverified', pid: 4242, status: 'finished' });
    expect(result.strays).toEqual([]);
  });

  it('drops an entry whose PID now belongs to a program that cannot be Claude', async () => {
    ws.claude.session({ pid: 4242, sessionId: ID });
    ws.platform.run(4242, 'svchost', 1, { state: 'denied', path: null, startRaw: null, startEpochMs: null });
    expect((await ws.scan()).sessions).toEqual([]);
  });

  it.each(['denied', 'partial'] as const)('keeps an entry as unverified when the process is %s', async (state) => {
    ws.claude.session({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) });
    ws.platform.run(4242, 'claude', 1, { state, path: null, startRaw: null, startEpochMs: null });
    expect(only(await ws.scan())).toMatchObject({ liveness: 'unverified', working: true });
  });

  it.each(['gone', 'exited'] as const)('drops an entry whose process is %s', async (state) => {
    ws.claude.session({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) });
    ws.platform.details[4242] = { state, path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null };
    const result = await ws.scan();
    expect(result.sessions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  describe('an entry another system wrote into a folder shared with this one', () => {
    const GONE = { state: 'gone', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null } as const;

    it('is judged by its transcript, never dropped because this system has no such PID', async () => {
      // Claude Code in WSL, with ~/.claude a symlink to the Windows one: Linux cwd, clock ticks.
      ws.claude.session({ pid: 813, sessionId: ID, cwd: '/home/me/proj', procStart: '123456' });
      ws.claude.transcript('-home-me-proj', ID, [...CLOSED, ...OPEN], NOW - 900_000);
      ws.platform.details[813] = GONE;

      const result = await ws.scan();

      expect(only(result)).toMatchObject({ pid: 813, liveness: 'foreign', turn: 'OPEN', working: true, children: [] });
      expect(result.errors).toEqual([]);
      expect(ws.platform.snapshotRequests[0]?.detailPids).toEqual([]);
    });

    it('is recognised by a start time that is no FILETIME as well', async () => {
      ws.claude.session({ pid: 814, sessionId: ID, cwd: 'C:\\work\\shop', procStart: 633_076 });
      ws.platform.details[814] = GONE;
      expect(only(await ws.scan())).toMatchObject({ liveness: 'foreign' });
    });

    it('is recognised on Linux and macOS by a Windows working directory', async () => {
      ws.platform.id = 'linux';
      ws.platform.procStartUnitsPerSecond = 100;
      ws.claude.session({ pid: 815, sessionId: ID, cwd: 'C:\\work\\shop', procStart: filetime(SESSION_START) });
      ws.platform.details[815] = GONE;
      expect(only(await ws.scan())).toMatchObject({ liveness: 'foreign' });
    });

    it('does not make a process of this system foreign', async () => {
      ws.claude.session({ pid: 4242, sessionId: ID, cwd: 'C:\\work\\shop', procStart: filetime(SESSION_START) });
      ws.platform.details[4242] = GONE;
      expect((await ws.scan()).sessions).toEqual([]);
    });
  });

  it('keeps an entry as unverified when the platform says nothing about its PID', async () => {
    ws.claude.session({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) });
    expect(only(await ws.scan())).toMatchObject({ liveness: 'unverified', pid: 4242 });
  });

  it('keeps every entry as unverified when the process list cannot be read', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, NOW - 1000_000);
    ws.platform.processes = null;
    ws.platform.details = {};
    ws.platform.snapshotProblem = 'The process helper timed out.';
    ws.platform.idle = null;

    const result = await ws.scan({ guardPatterns: ['ffmpeg'] });

    expect(only(result)).toMatchObject({ liveness: 'unverified', turn: 'CLOSED' });
    expect(result).toMatchObject({ strays: null, guardHits: null, processListOk: false, idleSeconds: null });
    expect(result.errors).toEqual(['The process helper timed out.']);
  });

  it('compares start times as BigInt: one unit beyond the tolerance is not a match', async () => {
    const start = 134355037717240959n;
    ws.claude.session({ pid: 4242, sessionId: ID, procStart: (start - 10_000_000n).toString() });
    ws.claude.session({ pid: 4343, sessionId: 'bbbbbbbb', procStart: (start - 10_000_001n).toString() });
    for (const pid of [4242, 4343]) ws.platform.run(pid, 'claude', 1, { path: CLAUDE_EXE, startRaw: start.toString() });

    const result = await ws.scan();

    expect(result.sessions.map((session) => [session.pid, session.liveness]).sort()).toEqual([
      [4242, 'verified'],
      [4343, 'unverified'],
    ]);
  });
});

describe('registry files that cannot be used', () => {
  it.each([
    ['broken JSON', '{"pid": 4242, "sess', "isn't valid JSON"],
    ['an array', '[]', "isn't a JSON object"],
    ['a pid given as a string', '{"pid": "4242"}', 'has no usable process id (pid)'],
    ['a pid given as a float', '{"pid": 42.5}', 'has no usable process id (pid)'],
    ['a negative pid', '{"pid": -4242}', 'has no usable process id (pid)'],
    ['no fields at all', '{}', 'has no usable process id (pid)'],
  ])('reports %s and carries on with the other entries', async (_label, content, problem) => {
    ws.claude.rawSession('bad.json', content);
    ws.liveSession(4343, ID);

    const result = await ws.scan();

    expect(result.errors).toEqual([`The session file bad.json in ~/.claude ${problem}.`]);
    expect(only(result).pid).toBe(4343);
  });

  it('lists a session whose startedAt is an ISO string, with an unknown start instead of NaN', async () => {
    ws.liveSession(4242, ID, { startedAt: '2026-10-03T10:00:00.000Z' });
    ws.claude.transcript('p', ID, CLOSED, NOW - 2000);

    const result = await ws.scan();

    expect(result.errors).toEqual([]);
    expect(only(result)).toMatchObject({ startedAtMs: null, lastActivityMs: NOW - 2000, silenceSeconds: 2, status: 'justFinished', working: true });
  });

  it('ignores files in the sessions folder that are not .json', async () => {
    ws.claude.rawSession('notes.txt', 'not a registry entry');
    ws.claude.rawSession('4242.json.tmp', '{');
    const result = await ws.scan();
    expect(result.errors).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it('skips an entry that vanished between listing and reading without calling it an error', async () => {
    ws.cleanup();
    const vanishing: FsApi = {
      ...nodeFs,
      readSmallFile: (file, maxBytes) =>
        path.basename(file) === '4242.json'
          ? Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' }))
          : nodeFs.readSmallFile(file, maxBytes),
    };
    ws = createWorkspace({ fs: vanishing });
    ws.liveSession(4242, ID);
    ws.liveSession(4343, 'bbbbbbbb');

    const result = await ws.scan();

    expect(result.errors).toEqual([]);
    expect(only(result).pid).toBe(4343);
  });

  it('reports an entry that cannot be read for any other reason', async () => {
    ws.cleanup();
    const denied: FsApi = {
      ...nodeFs,
      readSmallFile: (file) => Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' })),
    };
    ws = createWorkspace({ fs: denied });
    ws.liveSession(4242, ID);

    const result = await ws.scan();

    expect(result.sessions).toEqual([]);
    expect(result.errors).toEqual(["The session file 4242.json in ~/.claude couldn't be read: EACCES: permission denied."]);
  });

  it('reports a registry file that is far too large instead of loading it', async () => {
    ws.claude.rawSession('4242.json', `{"pid": 4242, "name": "${'x'.repeat(1024 * 1024)}"}`);
    const result = await ws.scan();
    expect(result.sessions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('The session file 4242.json in ~/.claude couldn\'t be read: larger than');
  });
});
