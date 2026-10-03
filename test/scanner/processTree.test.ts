import { describe, expect, it } from 'vitest';

import { ChildActivity, busyChildren, descendantsOf, indexProcesses, processIgnoreKey } from '../../src/core/processTree';
import type { ProcDetail, ProcRow } from '../../src/platform/types';
import { detail } from './support';

const row = (pid: number, ppid: number | null, name = 'cmd'): ProcRow => ({ pid, ppid, name });
const noStarts = (): null => null;

function pidsBelow(rows: ProcRow[], sessionPid: number, sessionPids: number[] = [sessionPid], starts: Record<number, number> = {}): number[] {
  return descendantsOf(indexProcesses(rows), sessionPid, new Set(sessionPids), (pid) => starts[pid] ?? null).map((found) => found.pid);
}

describe('descendantsOf', () => {
  it('walks the whole tree below the session, nearest first', () => {
    const rows = [row(100, 1, 'claude'), row(200, 100), row(300, 200, 'node'), row(400, 300, 'esbuild'), row(210, 100, 'git'), row(900, 1)];
    expect(pidsBelow(rows, 100)).toEqual([200, 210, 300, 400]);
  });

  it('finds nothing for a session without children or one that is not listed', () => {
    expect(pidsBelow([row(100, 1, 'claude'), row(900, 1)], 100)).toEqual([]);
    expect(pidsBelow([row(900, 1)], 100)).toEqual([]);
  });

  it('stops at another session: its processes belong to that session', () => {
    const rows = [row(100, 1, 'claude'), row(200, 100), row(500, 200, 'claude'), row(600, 500, 'npm')];
    expect(pidsBelow(rows, 100, [100, 500])).toEqual([200]);
    expect(pidsBelow(rows, 500, [100, 500])).toEqual([600]);
  });

  it('skips console hosts', () => {
    const rows = [row(100, 1, 'claude'), row(201, 100, 'conhost'), row(202, 100, 'openconsole'), row(203, 100, 'pwsh')];
    expect(pidsBelow(rows, 100)).toEqual([203]);
  });

  it('skips a process that started before its parent, and everything under it', () => {
    const rows = [row(100, 1, 'claude'), row(200, 100), row(300, 200), row(210, 100)];
    const starts = { 100: 50_000, 200: 48_999, 300: 60_000, 210: 49_000 };
    expect(pidsBelow(rows, 100, [100], starts)).toEqual([210]);
  });

  it('keeps a process when its own start time or that of its parent is unknown', () => {
    const rows = [row(100, 1, 'claude'), row(200, 100), row(300, 200)];
    expect(pidsBelow(rows, 100, [100], { 100: 50_000 })).toEqual([200, 300]);
    expect(pidsBelow(rows, 100, [100], { 200: 1 })).toEqual([200, 300]);
  });

  it('ends on a parent loop and ignores a process that is its own parent', () => {
    const rows = [row(100, 300, 'claude'), row(200, 100), row(300, 200), row(0, 0, 'idle')];
    expect(pidsBelow(rows, 100)).toEqual([200, 300]);
    expect(descendantsOf(indexProcesses(rows), 0, new Set([0]), noStarts)).toEqual([]);
  });
});

describe('processIgnoreKey', () => {
  it('prefers the raw start time, then the epoch one, then 0', () => {
    expect(processIgnoreKey(7, detail({ startRaw: '134355037717240959', startEpochMs: 5 }))).toBe('proc:7:134355037717240959');
    expect(processIgnoreKey(7, detail({ startRaw: null, startEpochMs: 5 }))).toBe('proc:7:5');
    expect(processIgnoreKey(7, detail({ startRaw: null, startEpochMs: null }))).toBe('proc:7:0');
    expect(processIgnoreKey(7, null)).toBe('proc:7:0');
  });
});

describe('ChildActivity', () => {
  const KEY = 'proc:7:1';
  const at = (cpuSeconds: number | null, ioBytes: number | null): ProcDetail => detail({ cpuSeconds, ioBytes });

  it('counts the first sample as busy: no baseline, no way to tell', () => {
    expect(new ChildActivity().measure(KEY, at(10, 5000), 0)).toEqual({ cpuPercent: null, ioBytesPerSecond: null, busy: true });
  });

  it('is idle just below both thresholds', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    // Over 50 s: 0.95 CPU seconds = 1.9 %, 1,638,350 bytes = 32,767 B/s.
    expect(activity.measure(KEY, at(10.95, 1_638_350), 50_000)).toEqual({ cpuPercent: 1.9, ioBytesPerSecond: 32_767, busy: false });
  });

  it('is busy at exactly 2 % of one core', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    expect(activity.measure(KEY, at(11, 0), 50_000)).toEqual({ cpuPercent: 2, ioBytesPerSecond: 0, busy: true });
  });

  it('is busy at exactly 32 KB/s of I/O with an idle CPU', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    expect(activity.measure(KEY, at(10, 1_638_400), 50_000)).toEqual({ cpuPercent: 0, ioBytesPerSecond: 32_768, busy: true });
  });

  it('measures each interval against the previous sample, not the first', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    expect(activity.measure(KEY, at(15, 0), 10_000).busy).toBe(true);
    expect(activity.measure(KEY, at(15, 0), 20_000)).toEqual({ cpuPercent: 0, ioBytesPerSecond: 0, busy: false });
  });

  it('is busy when CPU time cannot be read', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    expect(activity.measure(KEY, at(null, 0), 10_000)).toEqual({ cpuPercent: null, ioBytesPerSecond: 0, busy: true });
    expect(activity.measure(KEY, null, 20_000).busy).toBe(true);
  });

  it('judges by CPU alone where I/O counters do not exist', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, null), 0);
    expect(activity.measure(KEY, at(10.05, null), 10_000)).toEqual({ cpuPercent: 0.5, ioBytesPerSecond: null, busy: false });
  });

  it('is busy when a counter went backwards', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    expect(activity.measure(KEY, at(9, 0), 10_000)).toMatchObject({ cpuPercent: null, busy: true });
  });

  it('keeps the last reading and the baseline when sampled again within a second', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    expect(activity.measure(KEY, at(10.5, 0), 500).busy).toBe(true);
    // 0.1 CPU seconds over the 10 s since the FIRST sample: 1 %.
    expect(activity.measure(KEY, at(10.1, 0), 10_000)).toMatchObject({ cpuPercent: 1, busy: false });
    expect(activity.measure(KEY, at(99, 0), 10_400)).toMatchObject({ cpuPercent: 1, busy: false });
  });

  it('starts over when the clock went backwards', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 50_000);
    expect(activity.measure(KEY, at(10, 0), 20_000)).toEqual({ cpuPercent: null, ioBytesPerSecond: null, busy: true });
    expect(activity.measure(KEY, at(10, 0), 30_000).busy).toBe(false);
  });

  it('forgets a process that was not measured in a scan', () => {
    const activity = new ChildActivity();
    activity.measure(KEY, at(10, 0), 0);
    activity.forgetUnmeasured();
    activity.forgetUnmeasured();
    expect(activity.measure(KEY, at(10, 0), 10_000).busy).toBe(true);
  });

  it('keeps separate samples per process run', () => {
    const activity = new ChildActivity();
    activity.measure('proc:7:1', at(10, 0), 0);
    expect(activity.measure('proc:7:2', at(10, 0), 10_000).busy).toBe(true);
    expect(activity.measure('proc:7:1', at(10, 0), 10_000).busy).toBe(false);
  });
});

describe('busyChildren', () => {
  const rows = [row(300, 100, 'node'), row(200, 100, 'cargo'), row(400, 100, 'git')];
  const details = new Map<number, ProcDetail>([
    [200, detail({ startRaw: '20' })],
    [300, detail({ startRaw: '30' })],
    [400, detail({ startRaw: '40', state: 'exited' })],
  ]);

  it('lists busy children with their ignore keys and leaves out exited ones', () => {
    const busy = busyChildren(rows, details, new ChildActivity(), 0, new Set());
    expect(busy).toEqual([
      { pid: 200, name: 'cargo', cpuPercent: null, ioBytesPerSecond: null, busy: true, ignoreKey: 'proc:200:20', ignored: false },
      { pid: 300, name: 'node', cpuPercent: null, ioBytesPerSecond: null, busy: true, ignoreKey: 'proc:300:30', ignored: false },
    ]);
  });

  it('puts the ignored ones last, so cutting the list never hides one that blocks', () => {
    const busy = busyChildren(rows, details, new ChildActivity(), 0, new Set(['proc:200:20']));
    expect(busy.map((child) => [child.pid, child.ignored])).toEqual([
      [300, false],
      [200, true],
    ]);
  });

  it('counts a child nothing is known about as busy, every time', () => {
    const activity = new ChildActivity();
    const unknown = [row(500, 100, 'mystery')];
    expect(busyChildren(unknown, new Map(), activity, 0, new Set())).toHaveLength(1);
    expect(busyChildren(unknown, new Map(), activity, 10_000, new Set())).toMatchObject([{ pid: 500, cpuPercent: null, busy: true }]);
  });

  it('drops children that went idle', () => {
    const activity = new ChildActivity();
    busyChildren(rows, details, activity, 0, new Set());
    expect(busyChildren(rows, details, activity, 10_000, new Set())).toEqual([]);
  });
});
