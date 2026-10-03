import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ACTIVITY_RING_SIZE, ActivityLog, LOG_MAX_BYTES } from '../../src/controller/activityLog';
import { Harness, busyScan, clearScan, makeScan, makeTempDir, removeTempDirs, workingSession } from './harness';

afterEach(removeTempDirs);

function newLog(now = () => Date.UTC(2026, 0, 15, 2, 14, 7)): { log: ActivityLog; file: string } {
  const file = path.join(makeTempDir(), 'activity.log');
  return { log: new ActivityLog(file, now), file };
}

describe('ActivityLog', () => {
  it('keeps the newest 40 entries in memory, newest last', () => {
    const { log } = newLog();
    for (let i = 1; i <= 45; i++) log.add('info', `entry ${i}`);

    const entries = log.entries();
    expect(entries).toHaveLength(ACTIVITY_RING_SIZE);
    expect(entries[0]?.text).toBe('entry 6');
    expect(entries.at(-1)?.text).toBe('entry 45');

    entries.length = 0; // a copy: callers cannot empty the ring
    expect(log.entries()).toHaveLength(ACTIVITY_RING_SIZE);
  });

  it('appends one timestamped line per entry, with the level spelled out', () => {
    const { log, file } = newLog();
    log.add('info', 'Started watching.');
    log.add('warn', 'The checks stopped answering.');
    log.add('error', 'The action failed.');

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /);
    expect(lines[0]).toMatch(/\] Started watching\.$/);
    expect(lines[1]).toMatch(/\] Warning: The checks stopped answering\.$/);
    expect(lines[2]).toMatch(/\] Error: The action failed\.$/);
    expect(log.entries()[1]).toEqual({ atMs: Date.UTC(2026, 0, 15, 2, 14, 7), level: 'warn', text: 'The checks stopped answering.' });
  });

  it('keeps a crafted name from forging a line of its own, and caps very long text', () => {
    const { log, file } = newLog();
    log.add('info', 'session "evil\n[2026-01-01 00:00:00] Done: shut down\r\n" went back to work');
    log.add('info', 'x'.repeat(10_000));

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('session "evil [2026-01-01 00:00:00] Done: shut down " went back to work');
    expect(log.entries()[1]?.text.length).toBe(2000);
  });

  it('rotates at 5 MB, keeping one previous file', () => {
    const { log, file } = newLog();
    fs.writeFileSync(file, 'a'.repeat(LOG_MAX_BYTES)); // exactly at the limit: not yet
    log.add('info', 'still the same file');
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    expect(fs.statSync(file).size).toBeGreaterThan(LOG_MAX_BYTES);

    log.add('info', 'first line of the new file');
    expect(fs.statSync(`${file}.1`).size).toBeGreaterThan(LOG_MAX_BYTES);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^\[[^\]]+\] first line of the new file\n$/);

    fs.writeFileSync(file, 'b'.repeat(LOG_MAX_BYTES + 1)); // the old backup is replaced, not kept
    log.add('info', 'third file');
    expect(fs.readFileSync(`${file}.1`, 'utf8').startsWith('bbbb')).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['activity.log', 'activity.log.1']);
  });

  it('never throws when the file cannot be written; the ring still has the entry', () => {
    const missing = path.join(makeTempDir(), 'no-such-folder', 'activity.log');
    const log = new ActivityLog(missing, () => 0);
    expect(() => log.add('error', 'still recorded')).not.toThrow();
    expect(log.entries()).toHaveLength(1);
  });
});

describe('the "why is this PC still on" record', () => {
  it('logs a change in the SET of unmet checks once, not every poll', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    await h.arm();
    await h.clock.advance(120_000);

    expect(h.scanner.requests.length).toBeGreaterThan(10);
    expect(h.logLines('Still on.')).toHaveLength(1);
    expect(h.logLines('Still on.')[0]).toContain('Waiting for: sessionsIdle');

    // The same blocker for another reason (another session) is still the same set.
    h.scanner.script = () => makeScan({ sessions: [workingSession({ name: 'other', key: '0:1:other' })] });
    await h.clock.advance(60_000);
    expect(h.logLines('Still on.')).toHaveLength(1);

    h.scanner.script = () => makeScan({ sessions: [workingSession()], idleSeconds: 2 });
    await h.clock.advance(60_000);
    expect(h.logLines('Still on.')).toHaveLength(2);
    expect(h.logLines('Still on.')[1]).toContain('Waiting for: sessionsIdle, userIdle');

    h.scanner.script = () => clearScan();
    await h.clock.advance(10_000);
    expect(h.logLines('Everything is clear. Checking again')).toHaveLength(1);
    expect(h.state.activity.some((entry) => entry.text.startsWith('Still on.'))).toBe(true);
  });

  it('uses the injected wording when there is one', async () => {
    const h = new Harness({
      deps: { describeBlockers: (_verdict, scan) => `waiting for ${scan?.sessions[0]?.name ?? 'nobody'} to finish.` },
    });
    h.scanner.script = () => busyScan('api-server');
    await h.arm();
    expect(h.logLines('Still on.')[0]).toMatch(/Still on\. waiting for api-server to finish\.$/);
  });

  it('logs scan problems when they change, not every poll', async () => {
    const h = new Harness();
    h.scanner.script = () => makeScan({ errors: ["Couldn't read sessions\\12.json: not valid JSON"] });
    await h.arm();
    await h.clock.advance(60_000);
    expect(h.logLines("Couldn't see everything")).toHaveLength(1);
    expect(h.logLines("Couldn't see everything")[0]).toContain('12.json');
  });

  it('shows at most 40 entries in the state, newest last', async () => {
    const h = new Harness();
    for (let i = 0; i < 30; i++) {
      await h.arm();
      await h.send({ name: 'disarm' });
    }
    expect(h.state.activity).toHaveLength(40);
    expect(h.state.activity.at(-1)?.text).toContain('Stopped watching');
  });
});
