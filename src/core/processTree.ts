// What a session started: its descendant processes, and whether they are doing work.
//
// A build, a test suite or a download that a session left running in the background outlives the
// turn that started it - the transcript says "turn ended" while the work goes on. CPU and I/O are
// used here only to BLOCK, and only for children: an idle and a busy claude process look alike,
// an idle and a busy compiler do not.

import type { ProcDetail, ProcRow } from '../platform/types';
import type { ChildProcessInfo } from './types';

/** Windows gives every console program one of these; it idles for as long as the session lives. */
const CONSOLE_HOSTS: ReadonlySet<string> = new Set(['conhost', 'openconsole']);
/** A child cannot start before its parent; start times are only this precise. */
const STALE_PARENT_TOLERANCE_MS = 1000;

/** 2 % of one core, as CPU seconds per second. */
const BUSY_CPU_SHARE = 0.02;
const BUSY_IO_BYTES_PER_SECOND = 32 * 1024;
/** Below this the rate is noise: a few ms of start-up divided by 20 ms reads as tens of percent. */
const MIN_SAMPLE_SECONDS = 1;

export interface ProcessIndex {
  childrenOf: ReadonlyMap<number, readonly ProcRow[]>;
}

export function indexProcesses(rows: readonly ProcRow[]): ProcessIndex {
  const childrenOf = new Map<number, ProcRow[]>();
  for (const row of rows) {
    if (row.ppid === null || row.ppid === row.pid) continue;
    const siblings = childrenOf.get(row.ppid);
    if (siblings === undefined) childrenOf.set(row.ppid, [row]);
    else siblings.push(row);
  }
  return { childrenOf };
}

/** Start time (epoch ms) of a PID; null = unknown. */
export type StartLookup = (pid: number) => number | null;

function startedBefore(child: number | null, parent: number | null): boolean {
  return child !== null && parent !== null && child < parent - STALE_PARENT_TOLERANCE_MS;
}

/**
 * Every process below `sessionPid`, nearest first. Another session's process and everything below
 * it belong to that session, so the walk stops there.
 *
 * A parent PID outlives the parent: once it exits, its number can be handed to a new process, and
 * old "children" of the dead one then seem to hang under the new one. A process that started
 * before its parent is such a leftover and is left out, together with what hangs under it. With
 * an unknown start time the process is kept.
 */
export function descendantsOf(
  index: ProcessIndex,
  sessionPid: number,
  sessionPids: ReadonlySet<number>,
  startOf: StartLookup,
): ProcRow[] {
  const found: ProcRow[] = [];
  const seen = new Set<number>([sessionPid]);
  const queue = [sessionPid];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of index.childrenOf.get(parent) ?? []) {
      if (seen.has(child.pid) || sessionPids.has(child.pid)) continue;
      seen.add(child.pid);
      if (CONSOLE_HOSTS.has(child.name) || startedBefore(startOf(child.pid), startOf(parent))) continue;
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function hasExited(detail: ProcDetail): boolean {
  return detail.state === 'gone' || detail.state === 'exited';
}

/** `proc:<pid>:<start>`: one run of one process. A reused PID gets a new key, which voids an ignore. */
export function processIgnoreKey(pid: number, detail: ProcDetail | null): string {
  return `proc:${pid}:${detail?.startRaw ?? detail?.startEpochMs ?? 0}`;
}

export interface Reading {
  /** Percent of one core since the previous sample; null = no baseline or unreadable. */
  cpuPercent: number | null;
  /** Bytes per second since the previous sample; null = no baseline or unavailable. */
  ioBytesPerSecond: number | null;
  busy: boolean;
}

interface Sample {
  atMs: number;
  cpuSeconds: number | null;
  ioBytes: number | null;
  reading: Reading;
}

/** No baseline means no rate, and not knowing whether a process works counts as working. */
const NO_BASELINE: Reading = { cpuPercent: null, ioBytesPerSecond: null, busy: true };

function rate(before: number | null, after: number | null, seconds: number): number | null {
  return before === null || after === null || after < before ? null : (after - before) / seconds;
}

function readingBetween(previous: Sample, cpuSeconds: number | null, ioBytes: number | null, seconds: number): Reading {
  const cpu = rate(previous.cpuSeconds, cpuSeconds, seconds);
  const io = rate(previous.ioBytes, ioBytes, seconds);
  return {
    cpuPercent: cpu === null ? null : Math.round(cpu * 1000) / 10,
    ioBytesPerSecond: io === null ? null : Math.round(io),
    // CPU time that cannot be read is "can't tell". I/O counters do not exist on every OS, so a
    // missing one says nothing either way.
    busy: cpu === null || cpu >= BUSY_CPU_SHARE || (io !== null && io >= BUSY_IO_BYTES_PER_SECOND),
  };
}

/** CPU and I/O of child processes between scans. Keeps one sample per process run. */
export class ChildActivity {
  private readonly samples = new Map<string, Sample>();
  private readonly measured = new Set<string>();

  /** `key` names one run of one process (see processIgnoreKey); `detail` null = nothing known. */
  measure(key: string, detail: ProcDetail | null, atMs: number): Reading {
    this.measured.add(key);
    const cpuSeconds = detail?.cpuSeconds ?? null;
    const ioBytes = detail?.ioBytes ?? null;
    const previous = this.samples.get(key);
    const seconds = previous === undefined ? null : (atMs - previous.atMs) / 1000;
    // Also when the clock went backwards: the old sample is then no baseline for anything.
    if (previous === undefined || seconds === null || !(seconds >= 0)) {
      this.samples.set(key, { atMs, cpuSeconds, ioBytes, reading: NO_BASELINE });
      return NO_BASELINE;
    }
    // Too soon after the last sample (the final check runs right behind a regular one): the last
    // reading stands and the baseline stays, so the next sample spans a usable interval.
    if (seconds < MIN_SAMPLE_SECONDS) return previous.reading;
    const reading = readingBetween(previous, cpuSeconds, ioBytes, seconds);
    this.samples.set(key, { atMs, cpuSeconds, ioBytes, reading });
    return reading;
  }

  /** Ends one scan: a process that was not measured in it is gone, and so is its sample. */
  forgetUnmeasured(): void {
    for (const key of this.samples.keys()) {
      if (!this.measured.has(key)) this.samples.delete(key);
    }
    this.measured.clear();
  }
}

/**
 * The busy ones among a session's descendants, the ones that block first: the list is cut for
 * display, and a child that blocks must never be cut in favour of one the user chose to ignore.
 */
export function busyChildren(
  rows: readonly ProcRow[],
  details: ReadonlyMap<number, ProcDetail>,
  activity: ChildActivity,
  atMs: number,
  ignores: ReadonlySet<string>,
): ChildProcessInfo[] {
  const busy: ChildProcessInfo[] = [];
  for (const row of rows) {
    const detail = details.get(row.pid) ?? null;
    if (detail !== null && hasExited(detail)) continue;
    const ignoreKey = processIgnoreKey(row.pid, detail);
    const reading = activity.measure(ignoreKey, detail, atMs);
    if (reading.busy) busy.push({ pid: row.pid, name: row.name, ...reading, ignoreKey, ignored: ignores.has(ignoreKey) });
  }
  return busy.sort((a, b) => Number(a.ignored) - Number(b.ignored) || a.pid - b.pid);
}
