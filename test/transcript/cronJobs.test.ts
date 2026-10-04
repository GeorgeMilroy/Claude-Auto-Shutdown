// Tasks a session made with CronCreate and has not cancelled, read incrementally from its transcript.

import * as fs from 'node:fs';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CronJobs, type CronJobsOptions } from '../../src/core/cronJobs';
import { assistant, createFixtureDir, jsonl, prompt, textBlock, type FixtureDir, type Json } from './fixtures';

/** A whole minute, so "every minute" fires in exactly 60 s. */
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY_MS = 86_400_000;
const LIFETIME_MS = 7 * DAY_MS + 15 * 60_000;

function call(id: string, name: string, input: Json, atMs: number | null = NOW - 3600_000): Json {
  const record = assistant('tool_use', [{ type: 'tool_use', id, name, input }]);
  return atMs === null ? { ...record, timestamp: undefined } : { ...record, timestamp: new Date(atMs).toISOString() };
}

const create = (id: string, cron = '* * * * *', atMs?: number | null): Json => call(id, 'CronCreate', { cron, prompt: 'check', recurring: true }, atMs);
const cancel = (id: string, jobId: unknown): Json => call(id, 'CronDelete', { id: jobId });

function answer(toolUseId: string, content: unknown, isError = false): Json {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } };
}

const made = (toolUseId: string, jobId: string): Json => answer(toolUseId, `Scheduled recurring job ${jobId} (every minute).`);
const madeWithoutId = (toolUseId: string): Json => answer(toolUseId, 'Scheduled.');
const done = (toolUseId: string): Json => answer(toolUseId, [{ type: 'text', text: 'Cancelled.' }]);

let fx: FixtureDir;
beforeAll(() => {
  fx = createFixtureDir();
});
afterAll(() => fx.remove());
afterEach(() => vi.restoreAllMocks());

/** From now on, the file position of every read through fs.promises. */
function recordReadPositions(): number[] {
  const positions: number[] = [];
  const open = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle) as (...readArgs: unknown[]) => unknown;
    Object.assign(handle, {
      read: (...readArgs: unknown[]) => {
        positions.push(readArgs[3] as number);
        return read(...readArgs);
      },
    });
    return handle;
  });
  return positions;
}

/** Asks about the file as it is now. */
function ask(jobs: CronJobs, file: string, nowMs = NOW): Promise<number | null> {
  const stat = fs.statSync(file);
  return jobs.pendingSeconds(file, stat.size, stat.mtimeMs, nowMs);
}

async function pendingIn(records: readonly unknown[], options: CronJobsOptions = {}, nowMs = NOW): Promise<number | null> {
  return ask(new CronJobs(options), fx.transcript(records), nowMs);
}

describe('CronJobs: which tasks are pending', () => {
  it('none without a CronCreate call', async () => {
    expect(await pendingIn([prompt('go'), assistant('end_turn')])).toBeNull();
    expect(await pendingIn([])).toBeNull();
  });

  it('a task that was made, with the seconds until it fires', async () => {
    expect(await pendingIn([prompt('/loop 1m check'), create('c1'), made('c1', 'a1b2c3d4'), assistant('end_turn')])).toBe(60);
  });

  it('the soonest of several', async () => {
    const records = [create('c1', '0 9 * * 1'), made('c1', 'job1111'), create('c2', '* * * * *'), made('c2', 'job2222')];
    expect(await pendingIn(records)).toBe(60);
  });

  it('a task whose answer never came, or whose schedule cannot be read (0 s)', async () => {
    expect(await pendingIn([create('c1')])).toBe(60);
    expect(await pendingIn([create('c1', 'whenever'), made('c1', 'a1b2c3d4')])).toBe(0);
    expect(await pendingIn([call('c1', 'CronCreate', { prompt: 'check' }), made('c1', 'a1b2c3d4')])).toBe(0);
  });

  it('not a task the tool refused', async () => {
    expect(await pendingIn([create('c1'), answer('c1', 'Denied by the user', true)])).toBeNull();
  });

  it('not a call that is not a CronCreate tool_use of an assistant record', async () => {
    const quoted = assistant('end_turn', [textBlock('I could use "CronCreate" for this.')]);
    const asText = assistant('end_turn', [{ type: 'text', name: 'CronCreate', input: { cron: '* * * * *' } }]);
    const fromUser = { type: 'user', message: { content: [{ type: 'tool_use', id: 'c9', name: 'CronCreate', input: {} }] } };
    const otherTool = call('c1', 'CronList', {});
    expect(await pendingIn([quoted, asText, fromUser, otherTool, '{"type":"assistant","CronCreate"'])).toBeNull();
  });

  it('ends when a CronDelete naming its id succeeded', async () => {
    expect(await pendingIn([create('c1'), made('c1', 'a1b2c3d4'), cancel('d1', 'a1b2c3d4'), done('d1')])).toBeNull();
  });

  it('pairs by the id the answer names, also in a JSON answer', async () => {
    const records = [create('c1', '0 9 * * 1'), answer('c1', '{"id":"abcdefgh"}'), create('c2'), made('c2', 'zz99zz99')];
    expect(await pendingIn([...records, cancel('d1', 'abcdefgh'), done('d1')])).toBe(60);
    expect(await pendingIn([...records, cancel('d1', 'zz99zz99'), done('d1')])).not.toBe(60);
  });

  it('does not end a task whose id is known by a cancel naming another one', async () => {
    expect(await pendingIn([create('c1'), made('c1', 'a1b2c3d4'), cancel('d1', 'ffff0000'), done('d1')])).toBe(60);
    expect(await pendingIn([create('c1'), made('c1', 'a1b2c3d4'), cancel('d1', 'a1b2c3d'), done('d1')])).toBe(60);
    expect(await pendingIn([create('c1'), made('c1', 'a1b2c3d4'), cancel('d1', 42), done('d1')])).toBe(60);
  });

  it('counts makes against cancels when the ids cannot be paired', async () => {
    const two = [create('c1'), madeWithoutId('c1'), create('c2'), madeWithoutId('c2')];
    expect(await pendingIn([...two, cancel('d1', 'x'), done('d1')])).toBe(60);
    expect(await pendingIn([...two, cancel('d1', 'x'), done('d1'), cancel('d2', null), done('d2')])).toBeNull();
  });

  it('counts a call written twice once', async () => {
    expect(await pendingIn([create('c1'), create('c1'), madeWithoutId('c1'), cancel('d1', 'x'), done('d1')])).toBeNull();
  });

  it('does not count a cancel that failed, never got its answer, or came before the task', async () => {
    const task = [create('c1'), madeWithoutId('c1')];
    expect(await pendingIn([...task, cancel('d1', 'x'), answer('d1', 'No such job', true)])).toBe(60);
    expect(await pendingIn([...task, cancel('d1', 'x')])).toBe(60);
    expect(await pendingIn([cancel('d1', 'x'), done('d1'), ...task])).toBe(60);
  });

  it('ends 7 days and 15 minutes after the task was made', async () => {
    const madeAt = NOW - 7 * DAY_MS;
    const records = [create('c1', '* * * * *', madeAt), made('c1', 'a1b2c3d4')];
    expect(await pendingIn(records, {}, madeAt + LIFETIME_MS - 1000)).toBe(1);
    expect(await pendingIn(records, {}, madeAt + LIFETIME_MS)).toBeNull();
  });

  it("dates a call without a timestamp by the file's write time, which is never earlier", async () => {
    const file = fx.transcript([create('c1', '* * * * *', null), made('c1', 'a1b2c3d4')]);
    const writtenAt = NOW - 2 * DAY_MS;
    fs.utimesSync(file, new Date(writtenAt), new Date(writtenAt));
    expect(await ask(new CronJobs(), file, writtenAt + LIFETIME_MS - 1000)).toBe(1);
    expect(await ask(new CronJobs(), file, writtenAt + LIFETIME_MS)).toBeNull();
  });
});

describe('CronJobs: reading', () => {
  const loop = [prompt('/loop 1m check'), create('c1'), made('c1', 'a1b2c3d4'), assistant('end_turn')];

  it('reads a file in slices and claims nothing until it has read all of it', async () => {
    const file = fx.transcript(loop);
    const size = fs.statSync(file).size;
    const jobs = new CronJobs({ sliceBytes: 100 });
    const answers: (number | null)[] = [];
    for (let read = 0; read < Math.ceil(size / 100); read++) answers.push(await ask(jobs, file));
    expect(answers.slice(0, -1).every((answer) => answer === null)).toBe(true);
    expect(answers.at(-1)).toBe(60);
  });

  it('runs two reads of one file one after the other', async () => {
    const file = fx.transcript(loop);
    const jobs = new CronJobs({ sliceBytes: Math.ceil(fs.statSync(file).size / 2) });
    expect(await Promise.all([ask(jobs, file), ask(jobs, file)])).toEqual([null, 60]);
  });

  it('does not open an unchanged file again', async () => {
    const file = fx.transcript(loop);
    const jobs = new CronJobs();
    expect(await ask(jobs, file)).toBe(60);
    const open = vi.spyOn(fs.promises, 'open');
    expect(await ask(jobs, file)).toBe(60);
    expect(open).not.toHaveBeenCalled();
  });

  it('reads only what was appended', async () => {
    const file = fx.transcript(loop);
    const jobs = new CronJobs();
    expect(await ask(jobs, file)).toBe(60);
    const before = fs.statSync(file).size;
    fs.appendFileSync(file, jsonl([cancel('d1', 'a1b2c3d4'), done('d1')]));
    const positions = recordReadPositions();
    expect(await ask(jobs, file)).toBeNull();
    // The last few bytes before the new ones are read again, to see that it is still the same file.
    expect(positions.length).toBeGreaterThan(0);
    expect(Math.min(...positions)).toBe(before - 64);
  });

  it('reads a record split over several slices and a record still being written', async () => {
    const file = fx.write(jsonl(loop.slice(0, 2)) + JSON.stringify(made('c1', 'a1b2c3d4')));
    const jobs = new CronJobs({ sliceBytes: 16 });
    let answer: number | null = null;
    for (let read = 0; read < 100; read++) answer = await ask(jobs, file);
    // The answer has no newline yet: its id is unknown so far, but the task counts already.
    expect(answer).toBe(60);
    fs.appendFileSync(file, `\n${jsonl([cancel('d1', 'ffff0000'), done('d1')])}`);
    for (let read = 0; read < 100; read++) answer = await ask(jobs, file);
    expect(answer).toBe(60);
  });

  it('reads a file that shrank, or was replaced by another one, anew', async () => {
    const jobs = new CronJobs();
    const shrinking = fx.transcript(loop);
    expect(await ask(jobs, shrinking)).toBe(60);
    fs.writeFileSync(shrinking, jsonl([prompt('new')]));
    expect(await ask(jobs, shrinking)).toBeNull();

    const replaced = fx.transcript(loop);
    expect(await ask(jobs, replaced)).toBe(60);
    fs.writeFileSync(replaced, jsonl([prompt('another conversation '.repeat(100))]));
    expect(await ask(jobs, replaced)).toBeNull();
  });

  it('counts a line too long to keep as a task when it names CronCreate', async () => {
    const huge = create('c1');
    (huge.message as Json).content = [{ type: 'text', text: 'x'.repeat(500) }, ...((huge.message as Json).content as unknown[])];
    const options = { maxLineBytes: 200, sliceBytes: 64 };
    const file = fx.transcript([prompt('go'), huge, assistant('end_turn')]);
    // Such a task is dated by the write time of the file.
    fs.utimesSync(file, new Date(NOW - 60_000), new Date(NOW - 60_000));
    const jobs = new CronJobs(options);
    let answer: number | null = null;
    for (let read = 0; read < 50; read++) answer = await ask(jobs, file);
    expect(answer).toBe(0);

    const plain = fx.transcript([prompt('x'.repeat(500)), create('c1'), made('c1', 'a1b2c3d4'), cancel('d1', 'a1b2c3d4'), done('d1')]);
    const other = new CronJobs(options);
    for (let read = 0; read < 50; read++) answer = await ask(other, plain);
    expect(answer).toBeNull();
  });

  it('forgets a file nobody asked about for an hour', async () => {
    const file = fx.transcript(loop);
    const jobs = new CronJobs({ sliceBytes: 100 });
    for (let read = 0; read < 10; read++) await ask(jobs, file);
    expect(await ask(jobs, file)).toBe(60);

    jobs.forgetUnused(NOW + 3600_000);
    expect(await ask(jobs, file, NOW + 3600_000)).toBe(60);
    jobs.forgetUnused(NOW + 2 * 3600_000 + 1);
    expect(await ask(jobs, file, NOW + 2 * 3600_000 + 1)).toBeNull();
  });

  it('rejects when the file cannot be read', async () => {
    await expect(new CronJobs().pendingSeconds(fx.dir, 0, 0, NOW)).rejects.toThrow();
    await expect(new CronJobs().pendingSeconds(`${fx.dir}/missing.jsonl`, 0, 0, NOW)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('CronJobs: one-shot reminders (recurring: false)', () => {
  const oneShot = (id: string, cron: string, atMs: number, recurring: { recurring?: unknown } = { recurring: false }): Json =>
    call(id, 'CronCreate', { cron, prompt: 'remind me', ...recurring }, atMs);
  /** A cron that matches once a day, `minutesFromNow` after NOW, in this machine's local time. */
  const dailyAt = (minutesFromNow: number): string => {
    const date = new Date(NOW + minutesFromNow * 60_000);
    return `${date.getMinutes()} ${date.getHours()} * * *`;
  };

  it('is pending until its first match', async () => {
    expect(await pendingIn([oneShot('c1', dailyAt(10), NOW - 60_000), made('c1', 'once1111')])).toBe(600);
  });

  it('is gone once its first match is more than 15 minutes past', async () => {
    expect(await pendingIn([oneShot('c1', '* * * * *', NOW - 3600_000), made('c1', 'once1111')])).toBeNull();
    expect(await pendingIn([oneShot('c1', dailyAt(-16), NOW - 20 * 60_000), made('c1', 'once1111')])).toBeNull();
  });

  it('is still due within those 15 minutes: it may fire late', async () => {
    expect(await pendingIn([oneShot('c1', '* * * * *', NOW - 5 * 60_000), made('c1', 'once1111')])).toBe(0);
    expect(await pendingIn([oneShot('c1', dailyAt(-14), NOW - 20 * 60_000), made('c1', 'once1111')])).toBe(0);
  });

  it('does not hide a recurring task next to it', async () => {
    const records = [oneShot('c1', '* * * * *', NOW - 3600_000), made('c1', 'once1111'), create('c2'), made('c2', 'loop2222')];
    expect(await pendingIn(records)).toBe(60);
  });

  it('only a real false makes a one-shot (Claude Code defaults to recurring)', async () => {
    for (const recurring of [{}, { recurring: true }, { recurring: 'false' }, { recurring: 0 }, { recurring: null }]) {
      const records = [oneShot('c1', '* * * * *', NOW - 3600_000, recurring), made('c1', 'loop1111')];
      expect(await pendingIn(records), JSON.stringify(recurring)).toBe(60);
    }
  });

  it('has no 7-day lifetime: Claude Code keeps a one-shot until it fires, however far ahead', async () => {
    // Made 8 days ago for a match 10 days after that: still 2 days to go.
    const madeAt = NOW - 8 * DAY_MS;
    const match = new Date(madeAt + 10 * DAY_MS);
    const cron = `${match.getMinutes()} ${match.getHours()} ${match.getDate()} ${match.getMonth() + 1} *`;
    expect(await pendingIn([oneShot('c1', cron, madeAt), made('c1', 'once1111')])).toBe(2 * 86_400);
  });

  it('stays pending when its first match cannot be worked out', async () => {
    expect(await pendingIn([oneShot('c1', 'not a cron', NOW - 3600_000), made('c1', 'once1111')])).toBe(0);
  });
});
