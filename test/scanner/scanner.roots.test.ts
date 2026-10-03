// Several Claude folders at once, folders in another system, and a platform that fails.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Scanner } from '../../src/core/scanner';
import { nodeFs, type FsApi } from '../../src/core/scannerFs';
import type { Platform } from '../../src/platform/types';
import { CLAUDE_EXE, CLOSED, DEFAULT_REQUEST, NOW, OPEN, SESSION_START, createWorkspace, filetime, only, sessionNamed, type Workspace } from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const ago = (seconds: number): number => NOW - seconds * 1000;

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
});
afterEach(() => ws.cleanup());

describe('roots', () => {
  it('is fine with a ~/.claude that does not exist', async () => {
    const result = await ws.scan();
    expect(result.errors).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.roots).toEqual([
      { path: path.join(ws.home, '.claude'), label: '~/.claude', kind: 'local', ok: true, missing: true, detail: 'No sessions or projects folder here.' },
    ]);
  });

  it('is fine with a ~/.claude that has only one of its two folders', async () => {
    ws.claude.transcript('p', ID, CLOSED, ago(9000));
    const result = await ws.scan();
    expect(result.errors).toEqual([]);
    expect(result.roots).toMatchObject([{ ok: true, missing: false, detail: null }]);
  });

  it('watches $CLAUDE_CONFIG_DIR in addition to ~/.claude', async () => {
    const work = ws.otherDir('work-config');
    const scanner = new Scanner({ platform: ws.platform, homeDir: ws.home, env: { CLAUDE_CONFIG_DIR: work.dir }, now: () => NOW });
    ws.liveSession(4242, ID, { name: 'at home' });
    ws.claude.transcript('p', ID, CLOSED, ago(9000));
    ws.liveSession(4343, OTHER_ID, { name: 'at work' }, work);
    work.transcript('p', OTHER_ID, OPEN, ago(10));

    const result = await scanner.scan(DEFAULT_REQUEST);

    expect(result.errors).toEqual([]);
    expect(result.roots.map((root) => [root.label, root.path, root.ok, root.missing])).toEqual([
      ['~/.claude', ws.claude.dir, true, false],
      ['$CLAUDE_CONFIG_DIR', work.dir, true, false],
    ]);
    expect(sessionNamed(result, 'at home')).toMatchObject({ key: `0:4242:${ID}`, rootLabel: '~/.claude', status: 'finished' });
    expect(sessionNamed(result, 'at work')).toMatchObject({ key: `1:4343:${OTHER_ID}`, rootLabel: '$CLAUDE_CONFIG_DIR', status: 'working' });
    expect(sessionNamed(result, 'at work').ignoreKey.startsWith(`session:1:4343:${OTHER_ID}:`)).toBe(true);
    expect(result.strays).toEqual([]);
  });

  it('is fine with a $CLAUDE_CONFIG_DIR that does not exist', async () => {
    const scanner = new Scanner({ platform: ws.platform, homeDir: ws.home, env: { CLAUDE_CONFIG_DIR: path.join(ws.home, 'nope') }, now: () => NOW });
    const result = await scanner.scan(DEFAULT_REQUEST);
    expect(result.errors).toEqual([]);
    expect(result.roots.map((root) => [root.ok, root.missing])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it('watches the extra folders from the settings', async () => {
    const second = ws.otherDir('second-account');
    ws.liveSession(4343, OTHER_ID, { name: 'second' }, second);
    second.transcript('p', OTHER_ID, CLOSED, ago(9000));

    const result = await ws.scan({ extraClaudeDirs: [second.dir] });

    expect(result.errors).toEqual([]);
    expect(result.roots[1]).toEqual({ path: second.dir, label: second.dir, kind: 'local', ok: true, missing: false, detail: null });
    expect(only(result)).toMatchObject({ key: `1:4343:${OTHER_ID}`, rootLabel: second.dir, liveness: 'verified' });
  });

  it('reports an extra folder that does not exist', async () => {
    const missing = path.join(ws.home, 'typo');
    const result = await ws.scan({ extraClaudeDirs: [missing] });
    const problem = `The extra Claude folder ${missing} doesn't exist, or has no sessions and no projects folder.`;
    expect(result.errors).toEqual([problem]);
    expect(result.roots[1]).toEqual({ path: missing, label: missing, kind: 'local', ok: false, missing: true, detail: problem });
  });

  it('reports a Claude folder that cannot be listed', async () => {
    ws.cleanup();
    const denied: FsApi = {
      ...nodeFs,
      readdir: (dir) =>
        path.basename(dir) === 'projects'
          ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' }))
          : nodeFs.readdir(dir),
    };
    ws = createWorkspace({ fs: denied });
    ws.liveSession(4242, ID);

    const result = await ws.scan();

    expect(result.errors).toEqual([`The Claude folder ~/.claude (${ws.claude.dir}) couldn't be read: EACCES: permission denied.`]);
    expect(result.roots).toMatchObject([{ ok: false, missing: false }]);
    expect(only(result)).toMatchObject({ pid: 4242, status: 'cantTell' });
  });

  it('gives the same session in two folders two different keys', async () => {
    const copy = ws.otherDir('copy');
    ws.liveSession(4242, ID);
    copy.session({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) });
    const result = await ws.scan({ extraClaudeDirs: [copy.dir] });
    expect(result.sessions.map((session) => session.key).sort()).toEqual([`0:4242:${ID}`, `1:4242:${ID}`]);
  });

  it('gives two registry files that name the same session two different keys', async () => {
    ws.liveSession(4242, ID);
    ws.claude.rawSession('copy.json', JSON.stringify({ pid: 4242, sessionId: ID, procStart: filetime(SESSION_START) }));
    const result = await ws.scan();
    expect(result.sessions.map((session) => session.key).sort()).toEqual([`0:4242:${ID}`, `0:4242:${ID}#2`]);
  });
});

describe('a Claude folder in another system', () => {
  /** A folder that plays \\wsl.localhost\Ubuntu\home\me\.claude. */
  function ubuntu() {
    const dir = ws.otherDir('ubuntu-home');
    ws.platform.foreign = { roots: [{ path: dir.dir, label: 'WSL: Ubuntu' }], problem: null };
    return dir;
  }

  it('keeps every entry and judges it by its transcript alone', async () => {
    const wsl = ubuntu();
    wsl.session({ pid: 4242, sessionId: ID, name: 'in wsl', cwd: '/home/me/shop' });
    wsl.transcript('-home-me-shop', ID, OPEN, ago(4000));
    wsl.session({ pid: 77, sessionId: OTHER_ID, name: 'done in wsl' });
    wsl.transcript('-home-me-shop', OTHER_ID, CLOSED, ago(4000));
    // A Windows process that happens to have the same PID, and is provably not Claude.
    ws.platform.run(4242, 'svchost', 1, { state: 'gone' });
    ws.platform.run(300, 'node', 4242);

    const result = await ws.scan({ scanWsl: true, waitForChildProcesses: true });

    expect(result.errors).toEqual([]);
    expect(result.roots[1]).toEqual({ path: wsl.dir, label: 'WSL: Ubuntu', kind: 'foreign', ok: true, missing: false, detail: null });
    expect(sessionNamed(result, 'in wsl')).toMatchObject({
      liveness: 'foreign',
      pid: 4242,
      folder: 'shop',
      rootLabel: 'WSL: Ubuntu',
      status: 'working',
      children: [],
    });
    expect(sessionNamed(result, 'done in wsl')).toMatchObject({ liveness: 'foreign', status: 'finished', working: false });
    expect(ws.platform.snapshotRequests[0]?.detailPids).toEqual([]);
    expect(ws.platform.probeRequests).toEqual([]);
  });

  it('does not let a foreign PID hide a Claude process of this system', async () => {
    const wsl = ubuntu();
    wsl.session({ pid: 4242, sessionId: ID });
    ws.platform.run(4242, 'claude', 1, { path: CLAUDE_EXE });
    const result = await ws.scan({ scanWsl: true });
    expect(result.strays?.map((stray) => stray.pid)).toEqual([4242]);
  });

  it('passes on what the platform could not look at', async () => {
    ws.platform.foreign = { roots: [], problem: "Couldn't list the Claude folders of WSL: Debian." };
    expect((await ws.scan({ scanWsl: true })).errors).toEqual(["Couldn't list the Claude folders of WSL: Debian."]);
  });

  it('does not ask the platform while WSL scanning is off', async () => {
    ubuntu().session({ pid: 4242, sessionId: ID });
    const result = await ws.scan({ scanWsl: false });
    expect(ws.platform.foreignRootCalls).toBe(0);
    expect(result.roots).toHaveLength(1);
    expect(result.sessions).toEqual([]);
  });

  it('is fine with a foreign folder that is gone again (the distro stopped)', async () => {
    ubuntu();
    const result = await ws.scan({ scanWsl: true });
    expect(result.errors).toEqual([]);
    expect(result.roots[1]).toMatchObject({ kind: 'foreign', ok: true, missing: true });
  });

  it('gives up on a foreign folder that does not answer, and still scans the others', async () => {
    ws.cleanup();
    let foreignDir = '';
    const hanging: FsApi = {
      ...nodeFs,
      readdir: (dir) => (foreignDir !== '' && dir.startsWith(foreignDir) ? new Promise(() => undefined) : nodeFs.readdir(dir)),
    };
    ws = createWorkspace({ fs: hanging, foreignFsTimeoutMs: 40 });
    foreignDir = ubuntu().dir;
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, ago(9000));

    const result = await ws.scan({ scanWsl: true });

    expect(result.errors).toEqual([`The Claude folder WSL: Ubuntu (${foreignDir}) couldn't be read: no answer within 0.04 s.`]);
    expect(result.roots[1]).toMatchObject({ label: 'WSL: Ubuntu', kind: 'foreign', ok: false, missing: false });
    expect(only(result)).toMatchObject({ pid: 4242, status: 'finished' });
  });

  it('survives a platform that cannot look for other systems at all', async () => {
    ws.platform.failing.add('foreignRoots');
    const result = await ws.scan({ scanWsl: true });
    expect(result.errors).toEqual(["Couldn't look for Claude sessions in other systems on this PC (WSL): wsl exploded."]);
    expect(result.roots).toHaveLength(1);
  });
});

describe('what the platform reports', () => {
  it('lists the running processes of the keep-on list', async () => {
    ws.platform.run(50, 'ffmpeg');
    ws.platform.run(51, 'ffmpeg');
    ws.platform.run(52, 'blender');
    ws.platform.run(53, 'code');
    const result = await ws.scan({ guardPatterns: ['ffmpeg.exe', 'Blend*'] });
    expect(result.guardHits).toEqual(['blender', 'ffmpeg']);
    expect((await ws.scan()).guardHits).toEqual([]);
  });

  it("can't tell about the keep-on list without a process list", async () => {
    ws.platform.processes = null;
    expect((await ws.scan({ guardPatterns: ['ffmpeg'] })).guardHits).toBeNull();
    expect((await ws.scan()).guardHits).toBeNull();
  });

  it('passes idle time and the helper problem through', async () => {
    ws.platform.idle = 42.5;
    ws.platform.helper = { tier: 'limited', problem: 'Windows blocked part of the helper.' };
    expect(await ws.scan()).toMatchObject({ idleSeconds: 42.5, helperProblem: 'Windows blocked part of the helper.' });
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, undefined, '600'])('does not know the idle time when the platform says %s', async (idle) => {
    ws.platform.idle = idle as number;
    expect((await ws.scan()).idleSeconds).toBeNull();
  });

  it('distrusts a process list with a row it cannot read, or with no rows', async () => {
    ws.platform.processes = [{ pid: 4, ppid: 0, name: 'system' }, { pid: 'x', ppid: 0, name: 'odd' } as never];
    const result = await ws.scan({ guardPatterns: ['system'] });
    expect(result).toMatchObject({ processListOk: false, strays: null, guardHits: null });
    expect(result.errors).toEqual(["The list of running programs held entries that couldn't be understood."]);

    ws.platform.processes = [];
    expect(await ws.scan()).toMatchObject({ processListOk: false, strays: null });
  });

  it('reads process names with or without .exe, in any case', async () => {
    ws.claude.session({ pid: 4242, sessionId: ID });
    ws.platform.run(4242, 'Node.EXE', 1, { path: null, startRaw: null, startEpochMs: null });
    ws.platform.run(7000, 'CLAUDE.exe', 1, { path: CLAUDE_EXE });
    const result = await ws.scan();
    expect(only(result).liveness).toBe('unverified');
    expect(result.strays).toMatchObject([{ pid: 7000, name: 'claude' }]);
  });
});

describe('never rejects', () => {
  it('returns a blocking result when every platform call throws', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, ago(9000));
    for (const call of ['snapshot', 'probe', 'foreignRoots', 'helperStatus'] as const) ws.platform.failing.add(call);

    const result = await ws.scan({ scanWsl: true, waitForChildProcesses: true, guardPatterns: ['ffmpeg'] });

    expect(only(result)).toMatchObject({ liveness: 'unverified', turn: 'CLOSED' });
    expect(result).toMatchObject({ strays: null, guardHits: null, processListOk: false, idleSeconds: null });
    expect(result.helperProblem).toBe("The process helper's status couldn't be read: helper status exploded.");
    expect(result.errors).toEqual([
      "Couldn't look for Claude sessions in other systems on this PC (WSL): wsl exploded.",
      "The list of running programs couldn't be read: snapshot exploded.",
    ]);
  });

  it('returns a blocking result when the platform answers with garbage', async () => {
    const garbage = {
      procStartUnitsPerSecond: 'fast',
      helperStatus: () => undefined,
      snapshot: async () => 'no idea',
      probe: async () => null,
      foreignRoots: async () => null,
    } as unknown as Platform;
    ws.claude.session({ pid: 4242, sessionId: ID });
    const scanner = new Scanner({ platform: garbage, homeDir: ws.home, env: {}, now: () => NOW });

    const result = await scanner.scan({ ...DEFAULT_REQUEST, scanWsl: true, waitForChildProcesses: true });

    expect(only(result)).toMatchObject({ liveness: 'unverified', working: true });
    expect(result).toMatchObject({ strays: null, guardHits: null, processListOk: false, idleSeconds: null });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns a blocking result for a request that is not one', async () => {
    const result = await ws.scanner.scan(undefined as never);
    expect(result.errors).toEqual(["The quiet time for this check is missing or too short, so no session can count as finished."]);
    expect(result.sessions).toEqual([]);
  });

  it('keeps working with a clock that fails', async () => {
    const scanner = new Scanner({
      platform: ws.platform,
      homeDir: ws.home,
      env: {},
      now: () => {
        throw new Error('no clock');
      },
    });
    const before = Date.now();
    const result = await scanner.scan(DEFAULT_REQUEST);
    expect(result.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(result.errors).toEqual([]);
  });

  it('runs overlapping scans one after another', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, ago(9000));
    const events: string[] = [];
    const snapshot = ws.platform.snapshot.bind(ws.platform);
    ws.platform.snapshot = async (request) => {
      events.push('snapshot');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return snapshot(request);
    };
    const finished = <T>(result: T): T => {
      events.push('finished');
      return result;
    };

    const [first, second] = await Promise.all([ws.scan().then(finished), ws.scan({ forceWide: true }).then(finished)]);

    expect(events).toEqual(['snapshot', 'finished', 'snapshot', 'finished']);
    expect(first.sessions).toHaveLength(1);
    expect(second.sessions).toEqual(first.sessions);
  });

  it('lists at most 25 problems and counts the rest', async () => {
    for (let index = 0; index < 30; index++) ws.claude.rawSession(`bad-${String(index).padStart(2, '0')}.json`, '{');
    const result = await ws.scan();
    expect(result.errors).toHaveLength(26);
    expect(result.errors[25]).toBe('...and 5 more problems.');
  });

  it('treats a file where the sessions folder should be as no folder', async () => {
    fs.mkdirSync(ws.claude.dir, { recursive: true });
    fs.writeFileSync(path.join(ws.claude.dir, 'sessions'), 'not a folder');
    const result = await ws.scan();
    expect(result.sessions).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.roots).toMatchObject([{ ok: true, missing: true }]);
  });
});
