// Both forms of /loop keep their session working between firings: the self-paced one schedules a
// wake-up (ScheduleWakeup) in every turn, the fixed-interval one makes a task (CronCreate) once.

import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_EXE,
  CLOSED,
  NOW,
  closedWithWakeup,
  createWorkspace,
  cronCreate,
  cronDelete,
  intervalLoop,
  only,
  toolAnswer,
  type Workspace,
} from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const ago = (seconds: number): number => NOW - seconds * 1000;
const DAY_MS = 86_400_000;
/** Long enough ago for the last turn to be quiet: only a pending task can keep the session working. */
const LAST_WRITE = ago(400);

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
  ws.liveSession(4242, ID);
});
afterEach(() => {
  vi.restoreAllMocks();
  ws.cleanup();
});

function loopTranscript(records: unknown[]): string {
  return ws.claude.transcript('p', ID, records, LAST_WRITE);
}

describe('self-paced /loop (ScheduleWakeup)', () => {
  it('keeps the session working until the wake-up is due', async () => {
    loopTranscript(closedWithWakeup(1200));
    expect(only(await ws.scan())).toMatchObject({ turn: 'CLOSED', working: true, why: { id: 'scheduledWakeup', inSeconds: 800 } });
  });
});

describe('fixed-interval /loop (CronCreate)', () => {
  it('keeps the session working between firings, long after the turn that made the task', async () => {
    loopTranscript(intervalLoop(ago(3600), '* * * * *'));
    expect(only(await ws.scan())).toMatchObject({
      turn: 'CLOSED',
      status: 'working',
      working: true,
      why: { id: 'scheduledWakeup', inSeconds: 60 },
    });
  });

  it('counts a task made in the final turn as well', async () => {
    loopTranscript(intervalLoop(ago(500)).slice(0, 4));
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });
  });

  it('says 0 s when the next firing cannot be worked out', async () => {
    loopTranscript(intervalLoop(ago(3600), 'every ten minutes'));
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup', inSeconds: 0 } });
  });

  it('lets the session finish once the task is cancelled', async () => {
    loopTranscript([...intervalLoop(ago(3600)), cronDelete('toolu_del1', '1a2b3c4d', ago(450)), toolAnswer('toolu_del1', 'Cancelled job 1a2b3c4d.'), ...CLOSED]);
    expect(only(await ws.scan())).toMatchObject({ status: 'finished', working: false });
  });

  it('does not let a cancel of another task end this one', async () => {
    loopTranscript([...intervalLoop(ago(3600)), cronDelete('toolu_del1', '9f9f9f9f', ago(450)), toolAnswer('toolu_del1', 'Cancelled job 9f9f9f9f.'), ...CLOSED]);
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });
  });

  it('does not count a cancel that failed or never got its answer', async () => {
    const failed = [cronDelete('toolu_del1', '1a2b3c4d', ago(460)), toolAnswer('toolu_del1', 'No such job', true)];
    const unanswered = [cronDelete('toolu_del2', '1a2b3c4d', ago(450))];
    loopTranscript([...intervalLoop(ago(3600)), ...failed, ...unanswered, ...CLOSED]);
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });
  });

  it('does not count a task the tool refused to make', async () => {
    const refused = intervalLoop(ago(3600));
    refused[2] = toolAnswer('toolu_cron1', "The user doesn't want to proceed with this tool use.", true);
    loopTranscript(refused);
    expect(only(await ws.scan())).toMatchObject({ status: 'finished', working: false });
  });

  it('keeps counting until 7 days after the task was made, when recurring tasks expire', async () => {
    loopTranscript(intervalLoop(ago(7 * 86_400 - 60)));
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });

    // The last firing may come up to 15 minutes late.
    ws.clock.now = NOW + 15 * 60_000;
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });
    ws.clock.now = NOW + 16 * 60_000 + 1000;
    expect(only(await ws.scan())).toMatchObject({ status: 'finished', working: false });
  });

  it('claims nothing for a transcript no registered process holds', async () => {
    ws.cleanup();
    ws = createWorkspace();
    ws.platform.run(7000, 'claude', 1, { path: CLAUDE_EXE, startRaw: '777', startEpochMs: ago(2 * DAY_MS / 1000) });
    ws.claude.transcript('p', 'orphan', intervalLoop(ago(3600)), LAST_WRITE);
    expect(only(await ws.scan())).toMatchObject({ origin: 'transcript', status: 'finished' });
  });

  it('reads a long transcript in slices and claims nothing until it has read all of it', async () => {
    const path = loopTranscript(intervalLoop(ago(3600)).slice(0, 3));
    const padding = `${JSON.stringify({ type: 'attachment', text: 'x'.repeat(1000) })}\n`.repeat(9000);
    fs.appendFileSync(path, padding + `${JSON.stringify(CLOSED[1])}\n`);
    fs.utimesSync(path, new Date(LAST_WRITE), new Date(LAST_WRITE));
    expect(fs.statSync(path).size).toBeGreaterThan(8 * 1024 * 1024);

    const first = await ws.scan();
    expect(only(first)).toMatchObject({ status: 'finished' });
    expect(first.errors).toEqual([]);

    ws.clock.now = NOW + 10_000;
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });
  });

  it('reads only what was appended, and notices a cancel there', async () => {
    const path = loopTranscript(intervalLoop(ago(3600)));
    expect(only(await ws.scan())).toMatchObject({ working: true });

    ws.claude.append(path, cronDelete('toolu_del1', '1a2b3c4d', ago(30)), ago(30));
    ws.claude.append(path, toolAnswer('toolu_del1', 'Cancelled.'), ago(30));
    ws.claude.append(path, CLOSED[1], ago(29));
    ws.clock.now = NOW + 400_000;
    expect(only(await ws.scan())).toMatchObject({ status: 'finished', working: false });
  });

  it('reports a transcript it could not check, which keeps the PC on', async () => {
    const path = loopTranscript(intervalLoop(ago(3600)));
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation((file, ...rest) =>
      file === path ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : open(file, ...rest),
    );
    const result = await ws.scan();
    expect(result.errors).toContain(`Couldn't check the transcript ${path} for scheduled tasks: EACCES: permission denied.`);
  });

  it('counts a task as long as the session is listed, also when its process cannot be checked', async () => {
    ws.cleanup();
    ws = createWorkspace();
    ws.claude.session({ pid: 4343, sessionId: ID, cwd: '/home/me/proj', procStart: '123456' });
    ws.claude.transcript('p', ID, intervalLoop(ago(3600)), LAST_WRITE);
    expect(only(await ws.scan())).toMatchObject({ liveness: 'foreign', working: true, why: { id: 'scheduledWakeup' } });
  });

  it('counts a task whose answer never came', async () => {
    loopTranscript([...intervalLoop(ago(3600)).slice(0, 1), cronCreate('toolu_c2', { cron: '0 9 * * 1' }, ago(3500)), ...CLOSED]);
    expect(only(await ws.scan())).toMatchObject({ working: true, why: { id: 'scheduledWakeup' } });
  });
});
