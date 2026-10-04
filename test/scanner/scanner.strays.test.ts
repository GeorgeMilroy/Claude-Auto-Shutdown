// Claude Code processes the registry does not know, and the transcript sweep that backs it up.

import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluate } from '../../src/core/evaluate';
import type { ScanResult } from '../../src/core/types';
import { accountedStrays, planBackstop, type SweptTranscript } from '../../src/core/wideSweep';
import { input, stateOf } from '../evaluate/fixtures';
import { CLAUDE_EXE, CLOSED, NOW, OPEN, createWorkspace, detail, only, sessionNamed, type Workspace } from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const ORPHAN = 'cccccccc-1111-2222-3333-444444444444';
const ago = (seconds: number): number => NOW - seconds * 1000;
/** When the unregistered Claude process of these tests started. */
const STRAY_START = ago(600);

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
});
afterEach(() => ws.cleanup());

function runStray(pid = 7000, info: Parameters<Workspace['platform']['run']>[3] = {}): void {
  ws.platform.run(pid, 'claude', 1, info === null ? null : { path: CLAUDE_EXE, startRaw: '777', startEpochMs: STRAY_START, ...info });
}

/** The checks a scan leads to, with everything that does not come from the scan passing. */
function checksFor(result: ScanResult) {
  return evaluate(input({ scan: result, secondsSinceLastSession: 900 }));
}

describe('strays', () => {
  it('reports a Claude Code process that has no registry entry', async () => {
    runStray();
    const result = await ws.scan();
    expect(result.strays).toEqual([
      { pid: 7000, name: 'claude', path: CLAUDE_EXE, accounted: false, ignoreKey: 'proc:7000:777', ignored: false, children: [] },
    ]);
    expect(result.sessions).toEqual([]);
  });

  it('reports a process named claude whose path cannot be read', async () => {
    runStray(7000, { state: 'denied', path: null, startRaw: null, startEpochMs: null });
    runStray(7001, null);
    const result = await ws.scan();
    expect(result.strays).toEqual([
      { pid: 7000, name: 'claude', path: null, accounted: false, ignoreKey: 'proc:7000:0', ignored: false, children: [] },
      { pid: 7001, name: 'claude', path: null, accounted: false, ignoreKey: 'proc:7001:0', ignored: false, children: [] },
    ]);
  });

  it('does not report the desktop app, exited processes or other programs', async () => {
    runStray(7000, { path: 'C:\\Users\\X\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe' });
    runStray(7001, { path: '/Applications/Claude.app/Contents/MacOS/Claude' });
    runStray(7002, { state: 'exited' });
    ws.platform.run(7003, 'node', 1, { path: 'C:\\Program Files\\nodejs\\node.exe' });
    ws.platform.run(7004, 'chrome-native-host', 1, { path: 'C:\\Users\\X\\AppData\\Roaming\\Claude\\ChromeNativeHost\\chrome-native-host.exe' });
    expect((await ws.scan()).strays).toEqual([]);
  });

  it('does not report registered sessions, verified or not', async () => {
    ws.liveSession(4242, ID);
    ws.claude.session({ pid: 4343, sessionId: 'bbbbbbbb' });
    ws.platform.run(4343, 'claude', 1, { state: 'denied', path: null, startRaw: null, startEpochMs: null });

    const result = await ws.scan();

    expect(result.sessions.map((session) => session.liveness).sort()).toEqual(['unverified', 'verified']);
    expect(result.strays).toEqual([]);
  });

  it('is null - not empty - when the process list cannot be read', async () => {
    ws.platform.processes = null;
    expect((await ws.scan()).strays).toBeNull();
  });

  it('honours an ignore for one run of a process', async () => {
    runStray();
    const result = await ws.scan({ ignores: new Set(['proc:7000:777', 'proc:7000:778']) });
    expect(result.strays).toMatchObject([{ pid: 7000, ignoreKey: 'proc:7000:777', ignored: true }]);
  });
});

describe('transcripts nobody claims, while a stray is running', () => {
  it('judges a transcript written since the stray started like a session', async () => {
    runStray();
    const transcript = ws.claude.transcript('C--work-shop', ORPHAN, OPEN, ago(50));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', OPEN, ago(5));

    const result = await ws.scan();

    expect(only(result)).toMatchObject({
      key: `0:0:C--work-shop/${ORPHAN}`,
      origin: 'transcript',
      liveness: 'none',
      pid: null,
      sessionId: ORPHAN,
      name: 'cccccccc',
      cwd: '',
      folder: 'C--work-shop',
      entrypoint: '',
      rootLabel: '~/.claude',
      startedAtMs: null,
      transcriptPath: transcript,
      turn: 'OPEN',
      status: 'working',
      working: true,
      activeSubagents: 1,
      lastActivityMs: ago(5),
      children: [],
      ignoreKey: `session:0:0:${ORPHAN}:${fs.statSync(transcript).size}:${ago(50)}:${ago(5)}:0`,
    });
    expect(result.strays).toMatchObject([{ pid: 7000, accounted: true }]);
    expect(result.unclaimedRecent).toEqual([]);
  });

  it('lets such a session finish like any other, and then the stray blocks by itself', async () => {
    runStray();
    ws.claude.transcript('p', ORPHAN, CLOSED, ago(400));

    const result = await ws.scan();

    expect(only(result)).toMatchObject({ origin: 'transcript', status: 'finished', working: false });
    expect(result.strays).toMatchObject([{ pid: 7000, accounted: false }]);
    expect(stateOf(checksFor(result), 'registry')).toBe('cantTell');
  });

  it('does not let a finished transcript of another session stand in for a working stray', async () => {
    // The stray's own conversation is in a config folder nobody watches; a session in ~/.claude
    // that ended after the stray started leaves a finished transcript behind.
    runStray(7000, { startEpochMs: ago(3600) });
    ws.platform.run(7100, 'node', 7000, { cpuSeconds: 100 });
    ws.claude.transcript('another-project', ORPHAN, CLOSED, ago(900));

    const result = await ws.scan({ waitForChildProcesses: true });
    const verdict = checksFor(result);

    expect(only(result)).toMatchObject({ status: 'finished' });
    expect(result.strays).toMatchObject([{ pid: 7000, accounted: false }]);
    expect(stateOf(verdict, 'registry')).toBe('cantTell');
    expect(verdict.ok).toBe(false);
  });

  it('keeps a stray accounted for while its adopted transcript has only just finished', async () => {
    runStray();
    ws.claude.transcript('p', ORPHAN, CLOSED, ago(100));
    const result = await ws.scan();
    expect(only(result)).toMatchObject({ status: 'justFinished', working: true });
    expect(result.strays).toMatchObject([{ accounted: true }]);
  });

  it('does not let a transcript the user waived stand in for a stray', async () => {
    runStray();
    ws.claude.transcript('p', ORPHAN, OPEN, ago(50));
    const ignoreKey = only(await ws.scan()).ignoreKey;

    const result = await ws.scan({ ignores: new Set([ignoreKey]) });

    expect(only(result)).toMatchObject({ working: true, ignored: true });
    expect(result.strays).toMatchObject([{ accounted: false }]);
    expect(stateOf(checksFor(result), 'registry')).toBe('cantTell');
  });

  it('judges an adopted transcript with a quiet time of at least 120 s: a stray never shortens the wait', async () => {
    runStray();
    ws.claude.transcript('p', ORPHAN, CLOSED, ago(70));
    expect(only(await ws.scan({ quietSeconds: 60 }))).toMatchObject({ status: 'justFinished', working: true, why: { id: 'recentWrite' } });

    ws.clock.now = NOW + 50_000;
    expect(only(await ws.scan({ quietSeconds: 60, forceWide: true }))).toMatchObject({ status: 'finished', working: false });
  });

  it('accepts a transcript written up to 5 s before the stray reports having started', async () => {
    runStray();
    ws.claude.transcript('p', 'on-the-edge', OPEN, STRAY_START - 5000);
    ws.claude.transcript('p', 'too-early', OPEN, STRAY_START - 5001);

    const result = await ws.scan();

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['on-the-edge']);
    expect(result.strays).toMatchObject([{ accounted: true }]);
  });

  it('does not account for a stray with a transcript written before it started', async () => {
    runStray();
    ws.claude.transcript('p', ORPHAN, OPEN, STRAY_START - 60_000);
    const result = await ws.scan();
    expect(result.sessions).toEqual([]);
    expect(result.strays).toMatchObject([{ pid: 7000, accounted: false }]);
  });

  it('does not account for a stray whose start time is unknown', async () => {
    runStray(7000, { startEpochMs: null });
    ws.claude.transcript('p', ORPHAN, OPEN, ago(50));
    const result = await ws.scan();
    expect(result.sessions).toEqual([]);
    expect(result.strays).toMatchObject([{ pid: 7000, accounted: false }]);
    // Not judged as a session, so it still blocks as a recent unclaimed transcript.
    expect(result.unclaimedRecent.map((file) => file.project)).toEqual(['p']);
  });

  it('goes back as far as the earliest stray, and accounts for each one separately', async () => {
    runStray(7000, { startEpochMs: ago(600) });
    runStray(7001, { startRaw: '888', startEpochMs: ago(100) });
    ws.claude.transcript('p', ORPHAN, OPEN, ago(400));

    const result = await ws.scan();

    expect(only(result).sessionId).toBe(ORPHAN);
    expect(result.strays?.map((stray) => [stray.pid, stray.accounted])).toEqual([
      [7000, true],
      [7001, false],
    ]);
  });

  it('leaves transcripts of registered sessions to those sessions', async () => {
    runStray();
    ws.liveSession(4242, ID, { name: 'registered' });
    ws.claude.transcript('p', ID, CLOSED, ago(50));
    ws.claude.transcript('p', ORPHAN, CLOSED, ago(40));

    const result = await ws.scan();

    expect(result.sessions.map((session) => [session.origin, session.sessionId]).sort()).toEqual([
      ['registry', ID],
      ['transcript', ORPHAN],
    ]);
    expect(sessionNamed(result, 'registered').liveness).toBe('verified');
  });

  it('keeps two files of the same name apart', async () => {
    runStray();
    ws.claude.transcript('p1', ORPHAN, CLOSED, ago(50));
    ws.claude.transcript('p2', ORPHAN, CLOSED, ago(40));
    const result = await ws.scan();
    expect(result.sessions.map((session) => session.key).sort()).toEqual([`0:0:p1/${ORPHAN}`, `0:0:p2/${ORPHAN}`]);
  });

  it('judges the 30 newest and keeps the rest blocking while they are recent', async () => {
    runStray();
    for (let index = 0; index < 33; index++) ws.claude.transcript('p', `orphan-${String(index).padStart(2, '0')}`, CLOSED, ago(10 + index));

    const result = await ws.scan();

    expect(result.sessions).toHaveLength(30);
    expect(result.sessions.map((session) => session.sessionId)).not.toContain('orphan-30');
    expect(result.unclaimedRecent.map((file) => file.path.slice(-15))).toEqual(['orphan-30.jsonl', 'orphan-31.jsonl', 'orphan-32.jsonl']);
  });

  it('judges nothing as a session for a stray the user chose to ignore', async () => {
    runStray();
    ws.claude.transcript('p', ORPHAN, OPEN, ago(50));

    const result = await ws.scan({ ignores: new Set(['proc:7000:777']) });

    expect(result.sessions).toEqual([]);
    expect(result.strays).toMatchObject([{ ignored: true, accounted: false }]);
    expect(result.unclaimedRecent).toHaveLength(1);
  });
});

describe('processes an unregistered Claude process started', () => {
  const WATCH = { waitForChildProcesses: true };

  /** Stray 7000 -> bash 7100 -> node 7200, both started after the stray. */
  function strayWithBuild(): void {
    runStray();
    ws.platform.run(7100, 'bash', 7000, { startEpochMs: ago(500), startRaw: '7100', cpuSeconds: 1 });
    ws.platform.run(7200, 'node', 7100, { startEpochMs: ago(400), startRaw: '7200', cpuSeconds: 100 });
  }

  it('measures them like the children of a session and lists the busy ones under the stray', async () => {
    strayWithBuild();
    ws.platform.run(7300, 'conhost', 7000, { startEpochMs: ago(500) });

    const result = await ws.scan(WATCH);

    expect(ws.platform.probeRequests).toEqual([[7100, 7200]]);
    expect(result.strays?.[0]?.children).toEqual([
      { pid: 7100, name: 'bash', cpuPercent: null, ioBytesPerSecond: null, busy: true, ignoreKey: 'proc:7100:7100', ignored: false },
      { pid: 7200, name: 'node', cpuPercent: null, ioBytesPerSecond: null, busy: true, ignoreKey: 'proc:7200:7200', ignored: false },
    ]);
  });

  it('keeps waiting for a busy build after its transcript finished, even when the stray is waived', async () => {
    strayWithBuild();
    ws.claude.transcript('p', ORPHAN, CLOSED, ago(400));
    await ws.scan(WATCH);

    ws.clock.now = NOW + 10_000;
    ws.platform.probeSamples[7100] = detail({ startEpochMs: ago(500), startRaw: '7100', cpuSeconds: 1 });
    ws.platform.probeSamples[7200] = detail({ startEpochMs: ago(400), startRaw: '7200', cpuSeconds: 110 });
    const result = await ws.scan({ ...WATCH, ignores: new Set(['proc:7000:777']) });
    const verdict = checksFor(result);

    expect(result.strays).toMatchObject([{ ignored: true, children: [{ pid: 7200, cpuPercent: 100, busy: true }] }]);
    expect(stateOf(verdict, 'childProcesses')).toBe('waiting');
    expect(verdict.checks.find((check) => check.id === 'childProcesses')?.data).toEqual({
      items: ['node (PID 7200) started by an unmatched Claude process (PID 7000)'],
    });
  });

  it('lets the stray go once its children are idle or waived', async () => {
    strayWithBuild();
    await ws.scan(WATCH);

    ws.clock.now = NOW + 10_000;
    ws.platform.probeSamples[7100] = detail({ startEpochMs: ago(500), startRaw: '7100', cpuSeconds: 1 });
    ws.platform.probeSamples[7200] = detail({ startEpochMs: ago(400), startRaw: '7200', cpuSeconds: 110 });
    const result = await ws.scan({ ...WATCH, ignores: new Set(['proc:7000:777', 'proc:7200:7200']) });

    expect(result.strays?.[0]?.children).toMatchObject([{ pid: 7200, ignored: true }]);
    expect(stateOf(checksFor(result), 'childProcesses')).toBe('pass');
  });

  it('leaves out a leftover of a reused parent PID: a process that started before the stray', async () => {
    runStray();
    ws.platform.run(7100, 'old-daemon', 7000, { startEpochMs: STRAY_START - 1001 });
    ws.platform.run(7200, 'its-child', 7100);
    expect((await ws.scan(WATCH)).strays?.[0]?.children).toEqual([]);
  });

  it('gives each process to the nearest Claude process above it', async () => {
    runStray();
    runStray(7001, { startRaw: '888' });
    const nested = ws.platform.processes?.find((row) => row.pid === 7001);
    if (nested) nested.ppid = 7000;
    ws.platform.run(7100, 'npm', 7001, { startEpochMs: ago(10) });

    const result = await ws.scan(WATCH);

    expect(result.strays?.map((stray) => [stray.pid, stray.children.map((child) => child.pid)])).toEqual([
      [7000, []],
      [7001, [7100]],
    ]);
  });

  it('asks the next snapshot for the detail of what it found', async () => {
    strayWithBuild();
    await ws.scan();
    await ws.scan();
    expect([...(ws.platform.snapshotRequests[1]?.detailPids ?? [])].sort()).toEqual([7100, 7200]);
  });

  it('measures nothing while the check is off', async () => {
    strayWithBuild();
    const result = await ws.scan({ waitForChildProcesses: false });
    expect(ws.platform.probeRequests).toEqual([]);
    expect(result.strays?.[0]?.children).toEqual([]);
  });

  it('says so when no process has a known parent: with only a stray running, "no children" would be a guess', async () => {
    strayWithBuild();
    ws.platform.processes = (ws.platform.processes ?? []).map((row) => ({ ...row, ppid: null }));
    const result = await ws.scan(WATCH);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/which program started which/);
  });
});

describe('transcripts nobody claims, without strays', () => {
  it('lists the ones written within max(120 s, quiet time), newest first', async () => {
    const newest = ws.claude.transcript('p2', 'recent-b', CLOSED, ago(10));
    const older = ws.claude.transcript('p1', 'recent-a', OPEN, ago(300));
    ws.claude.transcript('p1', 'old', OPEN, ago(301));

    const result = await ws.scan({ quietSeconds: 300 });

    expect(result.unclaimedRecent).toEqual([
      { path: newest, project: 'p2', mtimeMs: ago(10), secondsAgo: 10 },
      { path: older, project: 'p1', mtimeMs: ago(300), secondsAgo: 300 },
    ]);
    expect(result.sessions).toEqual([]);
  });

  it('never looks back less than 120 s', async () => {
    ws.claude.transcript('p', 'recent', CLOSED, ago(120));
    ws.claude.transcript('p', 'old', CLOSED, ago(121));
    const result = await ws.scan({ quietSeconds: 30 });
    expect(result.unclaimedRecent.map((file) => file.secondsAgo)).toEqual([120]);
  });

  it('does not list the transcript of a live session, a subagent or a file that is not a transcript', async () => {
    ws.liveSession(4242, ID);
    const transcript = ws.claude.transcript('p', ID, CLOSED, ago(10));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(5));
    fs.writeFileSync(`${transcript}.bak`, 'x');
    expect((await ws.scan()).unclaimedRecent).toEqual([]);
  });

  it('lists the transcript of a session whose process is gone', async () => {
    ws.claude.session({ pid: 4242, sessionId: ID });
    ws.platform.details[4242] = detail({ state: 'gone', path: null, startRaw: null, startEpochMs: null });
    ws.claude.transcript('p', ID, OPEN, ago(10));

    const result = await ws.scan();

    expect(result.sessions).toEqual([]);
    expect(result.unclaimedRecent).toMatchObject([{ project: 'p', secondsAgo: 10 }]);
  });

  it('counts a write time in the future as recent', async () => {
    ws.claude.transcript('p', 'from-the-future', CLOSED, NOW + 5000_000);
    expect((await ws.scan()).unclaimedRecent).toMatchObject([{ secondsAgo: 0 }]);
  });
});

describe('the sweep cache', () => {
  it('reuses a sweep for 30 s, unless a fresh one is asked for', async () => {
    ws.claude.transcript('p', 'first', CLOSED, ago(10));
    expect((await ws.scan()).unclaimedRecent).toHaveLength(1);

    ws.claude.transcript('p', 'second', CLOSED, ago(5));
    ws.clock.now = NOW + 29_000;
    expect((await ws.scan()).unclaimedRecent).toHaveLength(1);
    expect((await ws.scan({ forceWide: true })).unclaimedRecent).toHaveLength(2);
  });

  it('sweeps again once the cached sweep is 30 s old', async () => {
    ws.claude.transcript('p', 'first', CLOSED, ago(10));
    await ws.scan();
    ws.claude.transcript('p', 'second', CLOSED, ago(5));
    ws.clock.now = NOW + 30_000;
    expect((await ws.scan()).unclaimedRecent).toHaveLength(2);
  });

  it('sweeps again when the clock went backwards', async () => {
    ws.claude.transcript('p', 'first', CLOSED, ago(10));
    await ws.scan();
    ws.claude.transcript('p', 'second', CLOSED, ago(5));
    ws.clock.now = NOW - 1000;
    expect((await ws.scan()).unclaimedRecent).toHaveLength(2);
  });

  it('judges an adopted transcript on the file as it is now, not as the sweep saw it', async () => {
    runStray();
    const transcript = ws.claude.transcript('p', ORPHAN, OPEN, ago(50));
    expect(only(await ws.scan()).turn).toBe('OPEN');

    ws.claude.append(transcript, CLOSED[1], ago(1));
    ws.clock.now = NOW + 5000;
    expect(only(await ws.scan())).toMatchObject({ turn: 'CLOSED', lastActivityMs: ago(1) });

    fs.rmSync(transcript);
    ws.clock.now = NOW + 6000;
    expect((await ws.scan()).sessions).toEqual([]);
  });
});

describe('planBackstop', () => {
  const file = (sessionId: string, mtimeMs: number): SweptTranscript => ({
    path: `/claude/projects/p/${sessionId}.jsonl`,
    size: 10,
    mtimeMs,
    rootIndex: 0,
    project: 'p',
    sessionId,
  });
  const stray = (pid: number, startEpochMs: number | null, ignored = false) => ({
    pid,
    name: 'claude',
    path: CLAUDE_EXE,
    startEpochMs,
    ignoreKey: `proc:${pid}:0`,
    ignored,
  });

  it('never waits for less because a stray is running', () => {
    const unclaimed = [file('before-the-stray', ago(100)), file('since-the-stray', ago(20))];
    const without = planBackstop(unclaimed, [], NOW, 300);
    const withStray = planBackstop(unclaimed, [stray(1, ago(60))], NOW, 300);

    expect(without.unclaimedRecent.map((entry) => entry.secondsAgo)).toEqual([20, 100]);
    expect(withStray.adopted.map((entry) => entry.sessionId)).toEqual(['since-the-stray']);
    expect(withStray.unclaimedRecent.map((entry) => entry.secondsAgo)).toEqual([100]);
  });

  it('treats an unreadable process list like no strays', () => {
    const plan = planBackstop([file('a', ago(20))], null, NOW, 300);
    expect(plan).toMatchObject({ adopted: [], unclaimedRecent: [{ secondsAgo: 20 }] });
    expect(plan.adoptedFor.size).toBe(0);
  });

  it('adopts nothing for an ignored stray', () => {
    const plan = planBackstop([file('a', ago(20))], [stray(1, ago(60), true)], NOW, 300);
    expect(plan.adopted).toEqual([]);
    expect(plan.adoptedFor.size).toBe(0);
  });

  it('remembers which adopted transcripts were written since each stray started', () => {
    const files = [file('old', ago(500)), file('new', ago(50))];
    const plan = planBackstop(files, [stray(1, ago(600)), stray(2, ago(100)), stray(3, null)], NOW, 300);
    expect([...plan.adoptedFor]).toEqual([
      [1, ['/claude/projects/p/new.jsonl', '/claude/projects/p/old.jsonl']],
      [2, ['/claude/projects/p/new.jsonl']],
    ]);
  });

  it('accounts for a stray only through an adopted transcript that still blocks', () => {
    const plan = planBackstop([file('old', ago(500)), file('new', ago(50))], [stray(1, ago(600)), stray(2, ago(100))], NOW, 300);
    const oldBlocks = new Map([
      ['/claude/projects/p/old.jsonl', true],
      ['/claude/projects/p/new.jsonl', false],
    ]);
    expect([...accountedStrays(plan, oldBlocks)]).toEqual([1]);
    expect([...accountedStrays(plan, new Map())]).toEqual([]);
  });

  it('lists every unclaimed transcript as recent when the quiet time is unknown', () => {
    const plan = planBackstop([file('ancient', ago(9_000_000))], [], NOW, Infinity);
    expect(plan.unclaimedRecent).toHaveLength(1);
  });
});
