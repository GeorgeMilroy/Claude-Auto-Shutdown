// Mirrors the leader's activity entries into this window's output channel. Every state carries
// the newest entries again, so the mirror remembers what it already wrote and passes on only
// what is new. Pure; the caller writes the lines to the channel.

import type { ActivityEntry } from '../shared/protocol';
import { fmtTime } from '../shared/text';
import { isRecord } from './snapshot';

/** Several times the size of the leader's ring: enough to tell old from new across a leader change. */
const REMEMBERED_ENTRIES = 400;
/** An entry older than this is backlog: its own time is printed, because the channel stamps "now". */
const FRESH_MS = 5000;
const LEVELS: readonly ActivityEntry['level'][] = ['info', 'warn', 'error'];

function readEntry(raw: unknown): ActivityEntry | null {
  if (!isRecord(raw) || typeof raw.text !== 'string' || raw.text === '') return null;
  if (typeof raw.atMs !== 'number' || !Number.isFinite(raw.atMs)) return null;
  const level = LEVELS.find((known) => known === raw.level) ?? 'info';
  return { atMs: raw.atMs, level, text: raw.text };
}

export class ActivityMirror {
  private readonly written = new Set<string>();

  /** The entries of `activity` (a state's list, oldest first) that have not been returned before. */
  take(activity: unknown): ActivityEntry[] {
    const entries: unknown[] = Array.isArray(activity) ? activity : [];
    const fresh: ActivityEntry[] = [];
    for (const raw of entries) {
      const entry = readEntry(raw);
      if (entry === null) continue;
      const key = `${entry.atMs}|${entry.level}|${entry.text}`;
      if (this.written.has(key)) continue;
      this.remember(key);
      fresh.push(entry);
    }
    return fresh;
  }

  private remember(key: string): void {
    this.written.add(key);
    if (this.written.size <= REMEMBERED_ENTRIES) return;
    // A Set keeps insertion order, so its first key is the oldest.
    for (const oldest of this.written) {
      this.written.delete(oldest);
      break;
    }
  }
}

/** The entry as one channel line. `nowMs` is the wall clock the channel will stamp the line with. */
export function activityLine(entry: ActivityEntry, nowMs: number): string {
  const backlog = Math.abs(nowMs - entry.atMs) > FRESH_MS;
  return backlog ? `(${fmtTime(entry.atMs, true)}) ${entry.text}` : entry.text;
}
