// The activity log: the last 40 entries in memory (shown in every window) and an append-only
// file that answers "why is this PC still on this morning".
//
// Everything here is best effort and synchronous: a log that cannot be written must never stop
// the controller, and the line announcing a power action has to be on disk before the action runs.

import * as fs from 'node:fs';

import type { ActivityEntry } from '../shared/protocol';

export const ACTIVITY_RING_SIZE = 40;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 2000;

const LEVEL_PREFIX: Record<ActivityEntry['level'], string> = {
  info: '',
  warn: 'Warning: ',
  error: 'Error: ',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local time, `YYYY-MM-DD HH:MM:SS`. */
function stamp(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * One entry = one line. Session names and OS error texts end up in here, and both can contain
 * line breaks: collapsing them keeps a crafted name from forging a log line of its own.
 */
function oneLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS - 1)}…` : flat;
}

export class ActivityLog {
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly ring: ActivityEntry[] = [];

  constructor(file: string, now: () => number, maxBytes: number = LOG_MAX_BYTES) {
    this.file = file;
    this.now = now;
    this.maxBytes = maxBytes;
  }

  add(level: ActivityEntry['level'], text: string): ActivityEntry {
    const entry: ActivityEntry = { atMs: this.now(), level, text: oneLine(text) };
    this.ring.push(entry);
    if (this.ring.length > ACTIVITY_RING_SIZE) this.ring.shift();
    this.append(`[${stamp(entry.atMs)}] ${LEVEL_PREFIX[level]}${entry.text}\n`);
    return entry;
  }

  /** Newest last. */
  entries(): ActivityEntry[] {
    return this.ring.slice();
  }

  private append(line: string): void {
    this.rotateIfNeeded();
    try {
      fs.appendFileSync(this.file, line, 'utf8');
    } catch {
      // the ring still has the entry; the file is retried with the next line
    }
  }

  /** Keeps one previous file. A rotation that fails (file held open by a viewer) is retried later. */
  private rotateIfNeeded(): void {
    try {
      if (fs.statSync(this.file).size <= this.maxBytes) return;
      const backup = `${this.file}.1`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(this.file, backup);
    } catch {
      // no file yet, or it cannot be moved right now
    }
  }
}
