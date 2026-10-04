// What a session is doing, read from its transcript(s) and subagents.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { judgeSession, type SessionFacts } from '../../src/core/scannerSession';
import {
  CLOSED,
  NOISE_ONLY,
  NOW,
  OPEN,
  SESSION_START,
  closedWithWakeup,
  createWorkspace,
  only,
  sessionNamed,
  type Workspace,
} from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const ago = (seconds: number): number => NOW - seconds * 1000;

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
});
afterEach(() => ws.cleanup());

describe('finding the transcript', () => {
  it("can't tell about a session without a transcript", async () => {
    ws.liveSession(4242, ID, { startedAt: SESSION_START });
    expect(only(await ws.scan())).toMatchObject({
      transcriptPath: null,
      turn: 'UNKNOWN',
      turnReason: 'noTranscript',
      status: 'cantTell',
      working: true,
      why: { id: 'turnUnknown' },
      lastActivityMs: SESSION_START,
      silenceSeconds: 7200,
    });
  });

  it('knows no write time at all for a session without transcript and start time', async () => {
    ws.liveSession(4242, ID);
    expect(only(await ws.scan())).toMatchObject({ lastActivityMs: null, silenceSeconds: null, status: 'cantTell', working: true });
  });

  it("can't tell about a session without a session id", async () => {
    ws.liveSession(4242, '');
    ws.claude.transcript('p', ID, CLOSED, ago(1000));
    expect(only(await ws.scan({ forceWide: true }))).toMatchObject({ transcriptPath: null, turnReason: 'noTranscript', status: 'cantTell' });
  });

  it('never lets a session id walk out of the projects folder', async () => {
    ws.liveSession(4242, '..\\..\\outside');
    ws.claude.transcript('p', 'x', CLOSED, ago(1000));
    // Where projects\p\..\..\outside.jsonl would land.
    fs.writeFileSync(path.join(ws.claude.dir, 'outside.jsonl'), '');
    expect(only(await ws.scan())).toMatchObject({ transcriptPath: null, turnReason: 'noTranscript', sessionId: '..\\..\\outside' });
  });

  it('lets the newest of several copies decide', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('C--old-worktree', ID, CLOSED, ago(90_000));
    const live = ws.claude.transcript('C--work-shop', ID, OPEN, ago(1000));

    const session = only(await ws.scan());

    expect(session).toMatchObject({ transcriptPath: live, turn: 'OPEN', turnReason: 'toolInFlight', lastActivityMs: ago(1000), status: 'working' });
  });

  it("can't tell which copy is live when two were written within the quiet time", async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('C--old-worktree', ID, CLOSED, ago(299));
    ws.claude.transcript('C--work-shop', ID, CLOSED, ago(10));

    expect(only(await ws.scan())).toMatchObject({ turn: 'UNKNOWN', turnReason: 'ambiguousTranscripts', status: 'cantTell', working: true });
    expect(only(await ws.scan({ quietSeconds: 200 }))).toMatchObject({ turn: 'CLOSED', status: 'justFinished' });
  });

  it('claims every copy: none of them shows up as an unclaimed transcript', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('C--old-worktree', ID, CLOSED, ago(20));
    ws.claude.transcript('C--work-shop', ID, CLOSED, ago(10));
    expect((await ws.scan()).unclaimedRecent).toEqual([]);
  });

  it('searches the project folders again at most once a minute while a known copy exists', async () => {
    ws.liveSession(4242, ID);
    const first = ws.claude.transcript('C--old-worktree', ID, CLOSED, ago(5000));
    expect(only(await ws.scan()).transcriptPath).toBe(first);

    const second = ws.claude.transcript('C--work-shop', ID, OPEN, ago(1000));
    ws.clock.now = NOW + 59_000;
    expect(only(await ws.scan()).transcriptPath).toBe(first);
    ws.clock.now = NOW + 60_000;
    expect(only(await ws.scan())).toMatchObject({ transcriptPath: second, turn: 'OPEN' });
  });

  it('searches again at once when the known copy is gone', async () => {
    ws.liveSession(4242, ID);
    const first = ws.claude.transcript('C--old-worktree', ID, CLOSED, ago(5000));
    await ws.scan();

    fs.rmSync(first);
    const second = ws.claude.transcript('C--work-shop', ID, OPEN, ago(1000));
    ws.clock.now = NOW + 5000;
    expect(only(await ws.scan()).transcriptPath).toBe(second);
  });

  it('keeps looking for the transcript of a session that has none yet', async () => {
    ws.liveSession(4242, ID);
    expect(only(await ws.scan()).transcriptPath).toBeNull();
    const created = ws.claude.transcript('C--work-shop', ID, OPEN, NOW);
    ws.clock.now = NOW + 5000;
    expect(only(await ws.scan()).transcriptPath).toBe(created);
  });

  it('reads a turn again when the transcript changes', async () => {
    ws.liveSession(4242, ID);
    const transcript = ws.claude.transcript('p', ID, OPEN, ago(1000));
    expect(only(await ws.scan()).turn).toBe('OPEN');
    ws.claude.append(transcript, CLOSED[1], ago(500));
    expect(only(await ws.scan()).turn).toBe('CLOSED');
  });
});

describe('subagents', () => {
  /** A session whose own turn ended long ago: only its subagents can keep it working. */
  function quietSession(): string {
    ws.liveSession(4242, ID);
    return ws.claude.transcript('p', ID, CLOSED, ago(5000));
  }

  it('finds them recursively, workflow agents included, and ignores the workflow journal', async () => {
    const transcript = quietSession();
    const plain = ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(30));
    const workflow = ws.claude.subagent(transcript, path.join('workflows', 'wf_x', 'agent-b2.jsonl'), CLOSED, ago(20));
    ws.claude.subagent(transcript, path.join('workflows', 'wf_x', 'journal.jsonl'), OPEN, ago(1));
    ws.claude.subagent(transcript, 'notes.txt', OPEN, ago(1));

    const session = only(await ws.scan());

    expect(session.subagents).toEqual([
      { name: 'agent-b2', path: workflow, mtimeMs: ago(20), turn: 'CLOSED', active: true },
      { name: 'agent-a1', path: plain, mtimeMs: ago(30), turn: 'CLOSED', active: true },
    ]);
    expect(session).toMatchObject({ activeSubagents: 2, status: 'working', why: { id: 'subagentsActive', count: 2 }, lastActivityMs: ago(20) });
  });

  it('counts a subagent as active while it wrote within max(120 s, quiet time)', async () => {
    const transcript = quietSession();
    ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(300));
    expect(only(await ws.scan({ quietSeconds: 300 })).activeSubagents).toBe(1);
    expect(only(await ws.scan({ quietSeconds: 299 })).activeSubagents).toBe(0);

    ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(120));
    expect(only(await ws.scan({ quietSeconds: 30 })).activeSubagents).toBe(1);
    ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(121));
    expect(only(await ws.scan({ quietSeconds: 30 }))).toMatchObject({ activeSubagents: 0, status: 'finished', working: false });
  });

  it('counts a silent subagent with an open turn as active for 1800 s', async () => {
    const transcript = quietSession();
    ws.claude.subagent(transcript, 'agent-a1.jsonl', OPEN, ago(1800));
    expect(only(await ws.scan())).toMatchObject({
      activeSubagents: 1,
      status: 'working',
      subagents: [{ name: 'agent-a1', turn: 'OPEN', active: true }],
    });
  });

  it('stops counting it after 1800 s, without reading its turn', async () => {
    const transcript = quietSession();
    ws.claude.subagent(transcript, 'agent-a1.jsonl', OPEN, ago(1801));
    expect(only(await ws.scan())).toMatchObject({
      activeSubagents: 0,
      status: 'finished',
      subagents: [{ name: 'agent-a1', turn: 'UNKNOWN', active: false }],
    });
  });

  it('does not count a silent subagent whose turn ended', async () => {
    const transcript = quietSession();
    ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(400));
    expect(only(await ws.scan())).toMatchObject({ activeSubagents: 0, subagents: [{ turn: 'CLOSED', active: false }] });
  });

  it('counts a silent subagent whose turn cannot be read: unknown is not finished', async () => {
    const transcript = quietSession();
    ws.claude.subagent(transcript, 'agent-a1.jsonl', NOISE_ONLY, ago(400));
    expect(only(await ws.scan())).toMatchObject({ activeSubagents: 1, subagents: [{ turn: 'UNKNOWN', active: true }] });
  });

  it('lists the 20 newest and counts all of them', async () => {
    const transcript = quietSession();
    for (let index = 0; index < 25; index++) {
      ws.claude.subagent(transcript, path.join('workflows', 'wf_big', `agent-${String(index).padStart(2, '0')}.jsonl`), CLOSED, ago(10 + index));
    }

    const session = only(await ws.scan());

    expect(session.activeSubagents).toBe(25);
    expect(session.subagents).toHaveLength(20);
    expect(session.subagents.map((subagent) => subagent.name)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `agent-${String(index).padStart(2, '0')}`),
    );
  });

  it("does not let a subagent's finished record in the main transcript close the session's turn", async () => {
    ws.liveSession(4242, ID);
    const asSidechain = (records: readonly Record<string, unknown>[]) => records.map((record) => ({ ...record, isSidechain: true }));
    const transcript = ws.claude.transcript('p', ID, [...OPEN, ...asSidechain(CLOSED)], ago(5000));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', asSidechain(CLOSED), ago(400));

    expect(only(await ws.scan())).toMatchObject({
      turn: 'OPEN',
      working: true,
      activeSubagents: 0,
      subagents: [{ turn: 'CLOSED', active: false }],
    });
  });

  it('looks under every copy of the transcript', async () => {
    ws.liveSession(4242, ID);
    const old = ws.claude.transcript('C--old-worktree', ID, CLOSED, ago(9000));
    ws.claude.transcript('C--work-shop', ID, CLOSED, ago(5000));
    ws.claude.subagent(old, 'agent-a1.jsonl', OPEN, ago(15));
    expect(only(await ws.scan())).toMatchObject({ activeSubagents: 1, status: 'working', lastActivityMs: ago(15) });
  });
});

describe('silence', () => {
  it('is measured from the newest write of transcript, subagents and session start', async () => {
    ws.liveSession(4242, ID, { startedAt: ago(50) });
    ws.claude.transcript('p', ID, CLOSED, ago(900));
    expect(only(await ws.scan())).toMatchObject({ lastActivityMs: ago(50), silenceSeconds: 50, status: 'justFinished' });
  });

  it('reports a write time in the future and counts it as silence 0', async () => {
    ws.liveSession(4242, ID, { name: 'time traveller' });
    ws.claude.transcript('p', ID, CLOSED, NOW + 61_000);

    const result = await ws.scan();

    expect(only(result)).toMatchObject({ silenceSeconds: 0, lastActivityMs: NOW + 61_000, status: 'justFinished', working: true });
    expect(result.errors).toEqual(['The session "time traveller" was last written at a time in the future. Check this PC\'s clock.']);
  });

  it('tolerates a write time up to a minute ahead', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, NOW + 60_000);
    const result = await ws.scan();
    expect(only(result).silenceSeconds).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('never calls a session finished when the quiet time is not a usable number', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, ago(90_000));
    for (const quietSeconds of [Number.NaN, undefined, '300', -1, 29]) {
      const result = await ws.scan({ quietSeconds: quietSeconds as number });
      expect(only(result)).toMatchObject({ working: true, status: 'justFinished' });
      expect(result.errors).toEqual(["The quiet time for this check is missing or too short, so no session can count as finished."]);
    }
  });
});

describe('status', () => {
  it('is working while the turn is open, whatever else is true', async () => {
    ws.liveSession(4242, ID);
    const transcript = ws.claude.transcript('p', ID, OPEN, ago(90_000));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', OPEN, ago(5));
    expect(only(await ws.scan())).toMatchObject({ status: 'working', working: true, why: { id: 'turnOpen' }, turnReason: 'toolInFlight' });
  });

  it('is just finished until it has been quiet for the quiet time', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, CLOSED, ago(299));
    expect(only(await ws.scan())).toMatchObject({ status: 'justFinished', working: true, why: { id: 'recentWrite' }, silenceSeconds: 299 });
    ws.claude.transcript('p', ID, CLOSED, ago(300));
    expect(only(await ws.scan())).toMatchObject({ status: 'finished', working: false, why: { id: 'quiet' }, silenceSeconds: 300 });
  });

  it('is working while a scheduled wake-up is pending, and for 120 s after it is due', async () => {
    ws.liveSession(4242, ID);
    ws.claude.transcript('p', ID, closedWithWakeup(1800), ago(1000));
    expect(only(await ws.scan())).toMatchObject({ turn: 'CLOSED', status: 'working', working: true, why: { id: 'scheduledWakeup', inSeconds: 800 } });

    ws.clock.now = NOW + 919_000;
    expect(only(await ws.scan())).toMatchObject({ status: 'working', why: { id: 'scheduledWakeup', inSeconds: 0 } });
    ws.clock.now = NOW + 920_000;
    expect(only(await ws.scan())).toMatchObject({ status: 'finished', working: false, why: { id: 'quiet' } });
  });

  it('sorts by what needs attention, then by name', async () => {
    const add = (pid: number, name: string, records: unknown[] | null, secondsAgo: number): void => {
      const id = `${name}-0000-1111-2222-333333333333`;
      ws.liveSession(pid, id, { name });
      if (records !== null) ws.claude.transcript('p', id, records, ago(secondsAgo));
    };
    add(11, 'zeta-done', CLOSED, 9000);
    add(12, 'alpha-done', CLOSED, 9000);
    add(13, 'Beta-done', CLOSED, 9000);
    add(14, 'fresh', CLOSED, 10);
    add(15, 'busy', OPEN, 10);
    add(16, 'mystery', null, 0);

    const result = await ws.scan();

    expect(result.sessions.map((session) => [session.status, session.name])).toEqual([
      ['cantTell', 'mystery'],
      ['working', 'busy'],
      ['justFinished', 'fresh'],
      ['finished', 'alpha-done'],
      ['finished', 'Beta-done'],
      ['finished', 'zeta-done'],
    ]);
    expect(sessionNamed(result, 'busy').pid).toBe(15);
  });
});

describe("don't wait for this session", () => {
  it('names the session by root, PID, id, transcript size and write times', async () => {
    ws.liveSession(4242, ID);
    const transcript = ws.claude.transcript('p', ID, OPEN, ago(4000));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', CLOSED, ago(5000));
    // A write time with a fraction of a millisecond, as real file systems report it.
    fs.utimesSync(transcript, (ago(4000) + 0.7) / 1000, (ago(4000) + 0.7) / 1000);
    const size = fs.statSync(transcript).size;
    expect(only(await ws.scan()).ignoreKey).toBe(`session:0:4242:${ID}:${size}:${ago(4000)}:${ago(5000)}:0`);
  });

  it('uses zeros for what does not exist', async () => {
    ws.liveSession(4242, ID);
    expect(only(await ws.scan()).ignoreKey).toBe(`session:0:4242:${ID}:0:0:0:0`);
  });

  it('honours the ignore until the transcript grows', async () => {
    ws.liveSession(4242, ID);
    const transcript = ws.claude.transcript('p', ID, OPEN, ago(4000));
    const before = only(await ws.scan());
    expect(before).toMatchObject({ ignored: false, working: true });

    const ignores = new Set([before.ignoreKey]);
    // Ignoring does not change what the session is doing, only whether it is waited for.
    expect(only(await ws.scan({ ignores }))).toMatchObject({ ignored: true, working: true, status: 'working', ignoreKey: before.ignoreKey });

    ws.claude.append(transcript, OPEN[1], ago(10));
    const after = only(await ws.scan({ ignores }));
    expect(after.ignoreKey).not.toBe(before.ignoreKey);
    expect(after).toMatchObject({ ignored: false, working: true });
  });

  it('voids the ignore when only the write time moves, or when a subagent writes', async () => {
    ws.liveSession(4242, ID);
    const transcript = ws.claude.transcript('p', ID, OPEN, ago(4000));
    const first = only(await ws.scan()).ignoreKey;

    ws.claude.transcript('p', ID, OPEN, ago(3000));
    const second = only(await ws.scan()).ignoreKey;
    ws.claude.subagent(transcript, 'agent-a1.jsonl', OPEN, ago(20));
    const third = only(await ws.scan()).ignoreKey;

    expect(new Set([first, second, third]).size).toBe(3);
  });
});

describe('judgeSession', () => {
  const child = { pid: 77, name: 'cargo', cpuPercent: 40, ioBytesPerSecond: 0, busy: true, ignoreKey: 'proc:77:1', ignored: false };
  const finished: SessionFacts = { turn: 'CLOSED', activeSubagents: 0, wakeupInSeconds: null, busyChild: null, silenceSeconds: 301, quietSeconds: 300 };
  /** Everything that keeps a session working, all at once. */
  const everything: SessionFacts = { turn: 'UNKNOWN', activeSubagents: 2, wakeupInSeconds: 60, busyChild: child, silenceSeconds: null, quietSeconds: 300 };

  it('goes through the reasons in a fixed order', () => {
    expect(judgeSession(everything)).toEqual({ working: true, status: 'cantTell', why: { id: 'turnUnknown' } });
    expect(judgeSession({ ...everything, turn: 'OPEN' })).toEqual({ working: true, status: 'working', why: { id: 'turnOpen' } });
    expect(judgeSession({ ...everything, turn: 'CLOSED' })).toEqual({ working: true, status: 'working', why: { id: 'subagentsActive', count: 2 } });
    expect(judgeSession({ ...everything, turn: 'CLOSED', activeSubagents: 0 })).toEqual({
      working: true,
      status: 'working',
      why: { id: 'scheduledWakeup', inSeconds: 60 },
    });
    expect(judgeSession({ ...everything, turn: 'CLOSED', activeSubagents: 0, wakeupInSeconds: null })).toEqual({
      working: true,
      status: 'working',
      why: { id: 'childBusy', name: 'cargo', pid: 77 },
    });
    expect(judgeSession({ ...finished, silenceSeconds: null })).toEqual({ working: true, status: 'cantTell', why: { id: 'silenceUnknown' } });
    expect(judgeSession({ ...finished, silenceSeconds: 299.9 })).toEqual({ working: true, status: 'justFinished', why: { id: 'recentWrite' } });
    expect(judgeSession({ ...finished, silenceSeconds: 300 })).toEqual({ working: false, status: 'finished', why: { id: 'quiet' } });
    expect(judgeSession(finished)).toEqual({ working: false, status: 'finished', why: { id: 'quiet' } });
  });

  it('is finished only on real numbers', () => {
    for (const silenceSeconds of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number, '900' as unknown as number]) {
      expect(judgeSession({ ...finished, silenceSeconds }).working).toBe(true);
    }
    for (const quietSeconds of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
      expect(judgeSession({ ...finished, quietSeconds }).working).toBe(true);
    }
  });

  it('treats a turn state it does not know as unknown', () => {
    expect(judgeSession({ ...finished, turn: 'DONE' as never })).toMatchObject({ working: true, status: 'cantTell' });
    expect(judgeSession({ ...finished, turn: undefined as never })).toMatchObject({ working: true, status: 'cantTell' });
  });
});
