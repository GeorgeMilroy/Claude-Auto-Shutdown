// Scheduled tasks a session set up with the CronCreate tool and has not cancelled: the
// fixed-interval form of /loop ("/loop 10m check the deploy") and "remind me at 3pm". The call is
// made once. The turns the task starts later do not repeat it, so it can lie hundreds of megabytes
// back in the transcript, far beyond the tail the turn state is read from. Each transcript is
// therefore read once from its start - in slices spread over several polls - and from then on
// only what was appended to it.
//
// A task lives in the memory of the Claude process that made it and is gone when that process
// ends, so only a session whose process is alive is asked about. A conversation that is resumed
// gets its tasks back (Claude Code makes them again from the transcript), so a task made by an
// earlier process still counts. Blocking-only: a pending task can make a session count as
// working, never the other way round.

import * as fs from 'node:fs';

import { nextCronFire } from './cronExpression';
import { readRange } from './transcript';

const CREATE_TOOL = 'CronCreate';
const DELETE_TOOL = 'CronDelete';
/** What a line that holds such a call contains (the tool name as a JSON string). */
const CREATE_MARK = Buffer.from(`"${CREATE_TOOL}"`);
const DELETE_MARK = Buffer.from(`"${DELETE_TOOL}"`);
const NEWLINE = 0x0a;

const DEFAULT_SLICE_BYTES = 8 * 1024 * 1024;
/** One record is never this large; a line that is gets dropped instead of being kept in memory. */
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const SEAM_BYTES = 64;
/** Recurring tasks expire after 7 days, firing a last time up to 15 minutes late (jitter). */
const TASK_LIFETIME_MS = 7 * 86_400_000 + 15 * 60_000;
/** A one-shot may fire this late (jitter) before it is gone for good. */
const ONE_SHOT_GRACE_MS = 15 * 60_000;
/** Claude Code accepts a one-shot whose cron matches within the next year, and never ages it out. */
const ONE_SHOT_HORIZON_MS = 366 * 86_400_000;
const MAX_ANSWER_CHARS = 2000;
const MAX_ID_CHARS = 128;
/** Calls whose answer never came: kept to match a late answer, but not without end. */
const MAX_WAITING = 64;
const UNUSED_FOR_MS = 3600_000;

/** The answer of CronCreate names the new task: "Scheduled recurring job 1a2b3c4d (...)". */
const ID_AFTER_WORD = /\b(?:job|task)(?:\s+id)?\s*[:=#]?\s*[`'"]?([A-Za-z0-9][A-Za-z0-9_-]{3,63})/gi;
const ID_FIELD = /"(?:id|jobId|job_id|taskId|task_id)"\s*:\s*"[^"]+"/;

type JsonObject = Record<string, unknown>;

interface TaskCreated {
  kind: 'create';
  /** When the call was made: the record's timestamp, else the file's write time when it was read. */
  atMs: number;
  cron: string | null;
  /**
   * false only for a task made with recurring: false (a one-shot reminder): it fires once, at its
   * first match after it was made, and then deletes itself. Claude Code's default is true.
   */
  recurring: boolean;
  /** The tool's answer; null until it has been read. */
  answer: string | null;
  /** The answer names an id: then only a CronDelete naming that id ends the task. */
  idKnown: boolean;
  /** The tool answered with an error: no task was made. */
  failed: boolean;
}

interface TaskDeleted {
  kind: 'delete';
  /** The id the call names; null when it cannot be read. */
  id: string | null;
  /** Its answer came back without an error. Only then is the task gone. */
  done: boolean;
}

type TaskEvent = TaskCreated | TaskDeleted;

interface FileScan {
  /** Size and write time of the file when it was last read. */
  size: number;
  mtimeMs: number;
  /** Bytes read so far. */
  offset: number;
  /** The bytes just before `offset`: a file replaced by another one no longer has them there. */
  seam: Buffer;
  /** Start of a line whose end has not been read yet. */
  partial: Buffer;
  /** Inside a line too long to keep: its bytes are dropped up to the next newline. */
  overlong: boolean;
  /** The last bytes dropped, so that a name split between two slices is still seen. */
  droppedTail: Buffer;
  droppedCreate: boolean;
  /** The file has been read to its end once. Until then nothing is claimed. */
  complete: boolean;
  /** Calls in the order they were made. */
  events: TaskEvent[];
  /** Calls whose answer has not been read yet, by tool_use id. */
  waiting: Map<string, TaskEvent>;
  /** tool_use ids of every call read, so that a record written twice counts once. */
  seen: Set<string>;
  usedAtMs: number;
}

export interface CronJobsOptions {
  /** Test seam: bytes read per file and poll while catching up. Default 8 MB. */
  sliceBytes?: number;
  /** Test seam: longest line that is kept. Default 16 MB. */
  maxLineBytes?: number;
}

const utf8 = new TextDecoder('utf-8');

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freshScan(): FileScan {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    seam: Buffer.alloc(0),
    partial: Buffer.alloc(0),
    overlong: false,
    droppedTail: Buffer.alloc(0),
    droppedCreate: false,
    complete: false,
    events: [],
    waiting: new Map(),
    seen: new Set(),
    usedAtMs: 0,
  };
}

function lastBytes(before: Buffer, added: Buffer, count: number): Buffer {
  const joined = added.length >= count ? added : Buffer.concat([before, added]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - count)));
}

function timeOf(value: unknown): number | null {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function taskIdOf(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id !== '' && id.length <= MAX_ID_CHARS ? id : null;
}

function answerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => (isObject(item) && typeof item.text === 'string' ? item.text : '')).join(' ');
}

function namesAnId(answer: string): boolean {
  for (const match of answer.matchAll(ID_AFTER_WORD)) {
    // Generated ids carry digits; a word after "job" ("job every 10 minutes") is not one.
    if (/\d/.test(match[1] ?? '')) return true;
  }
  return ID_FIELD.test(answer);
}

function isIdChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

/** `id` stands on its own somewhere in `text`, not as part of a longer word. */
function hasToken(text: string, id: string): boolean {
  for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
    if (!isIdChar(text[at - 1]) && !isIdChar(text[at + id.length])) return true;
  }
  return false;
}

function wait(scan: FileScan, toolUseId: string, event: TaskEvent): void {
  scan.waiting.set(toolUseId, event);
  if (scan.waiting.size > MAX_WAITING) scan.waiting.delete(scan.waiting.keys().next().value as string);
}

function noteCall(scan: FileScan, block: unknown, atMs: number): void {
  if (!isObject(block) || block.type !== 'tool_use') return;
  const toolUseId = typeof block.id === 'string' && block.id !== '' ? block.id : null;
  if (toolUseId !== null && scan.seen.has(toolUseId)) return;
  const input = isObject(block.input) ? block.input : {};
  let event: TaskEvent;
  if (block.name === CREATE_TOOL) {
    event = {
      kind: 'create',
      atMs,
      cron: typeof input.cron === 'string' ? input.cron : null,
      recurring: input.recurring !== false,
      answer: null,
      idKnown: false,
      failed: false,
    };
  } else if (block.name === DELETE_TOOL) {
    event = { kind: 'delete', id: taskIdOf(input.id), done: false };
  } else {
    return;
  }
  scan.events.push(event);
  if (toolUseId === null) return;
  scan.seen.add(toolUseId);
  wait(scan, toolUseId, event);
}

function noteAnswer(scan: FileScan, block: unknown): void {
  if (!isObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return;
  const event = scan.waiting.get(block.tool_use_id);
  if (event === undefined) return;
  scan.waiting.delete(block.tool_use_id);
  const failed = block.is_error === true;
  if (event.kind === 'delete') {
    event.done = !failed;
    return;
  }
  event.failed = failed;
  event.answer = answerText(block.content).slice(0, MAX_ANSWER_CHARS);
  event.idKnown = namesAnId(event.answer);
}

function answersWaiting(scan: FileScan, line: Buffer): boolean {
  for (const toolUseId of scan.waiting.keys()) {
    if (line.includes(toolUseId)) return true;
  }
  return false;
}

function readLine(scan: FileScan, line: Buffer, fallbackMs: number): void {
  if (!line.includes(CREATE_MARK) && !line.includes(DELETE_MARK) && !answersWaiting(scan, line)) return;
  let record: unknown;
  try {
    record = JSON.parse(utf8.decode(line));
  } catch {
    return;
  }
  if (!isObject(record) || !isObject(record.message) || !Array.isArray(record.message.content)) return;
  const content: unknown[] = record.message.content;
  if (record.type === 'assistant') {
    const atMs = timeOf(record.timestamp) ?? fallbackMs;
    for (const block of content) noteCall(scan, block, atMs);
  } else if (record.type === 'user') {
    for (const block of content) noteAnswer(scan, block);
  }
}

/**
 * Bytes of a line too long to read. A task made in it cannot be read either, so one is assumed:
 * it keeps the session working for the lifetime of a task, which is the safe side.
 */
function drop(scan: FileScan, piece: Buffer, fallbackMs: number): void {
  const seen = Buffer.concat([scan.droppedTail, piece]);
  if (!scan.droppedCreate && seen.includes(CREATE_MARK)) {
    scan.droppedCreate = true;
    scan.events.push({ kind: 'create', atMs: fallbackMs, cron: null, recurring: true, answer: null, idKnown: false, failed: false });
  }
  scan.droppedTail = lastBytes(Buffer.alloc(0), seen, CREATE_MARK.length - 1);
}

function endDrop(scan: FileScan): void {
  scan.overlong = false;
  scan.droppedTail = Buffer.alloc(0);
  scan.droppedCreate = false;
}

/** Reads the calls out of the next bytes of the file. */
function consume(scan: FileScan, bytes: Buffer, fallbackMs: number, maxLineBytes: number): void {
  let fresh = bytes;
  if (scan.overlong) {
    const newline = bytes.indexOf(NEWLINE);
    drop(scan, newline < 0 ? bytes : bytes.subarray(0, newline), fallbackMs);
    if (newline < 0) return;
    endDrop(scan);
    fresh = bytes.subarray(newline + 1);
  }
  const data = scan.partial.length > 0 ? Buffer.concat([scan.partial, fresh]) : fresh;
  const end = data.lastIndexOf(NEWLINE);
  // Most slices hold no such call at all; their lines need not be looked at one by one.
  const worthReading = data.includes(CREATE_MARK) || data.includes(DELETE_MARK) || scan.waiting.size > 0;
  for (let start = 0; worthReading && start <= end; ) {
    const newline = data.indexOf(NEWLINE, start);
    readLine(scan, data.subarray(start, newline), fallbackMs);
    start = newline + 1;
  }
  const rest = data.subarray(end + 1);
  if (rest.length <= maxLineBytes) {
    scan.partial = Buffer.from(rest);
    return;
  }
  scan.partial = Buffer.alloc(0);
  scan.overlong = true;
  drop(scan, rest, fallbackMs);
}

/** The tasks made and not ended, oldest first. */
function pendingTasks(events: readonly TaskEvent[]): TaskCreated[] {
  const pending: TaskCreated[] = [];
  for (const event of events) {
    if (event.kind === 'create') {
      if (!event.failed) pending.push(event);
      continue;
    }
    if (!event.done) continue;
    const id = event.id;
    let index = id === null ? -1 : pending.findIndex((task) => task.answer !== null && hasToken(task.answer, id));
    // A cancel that names no task we know of is counted instead: it ends the oldest task whose
    // id could not be read. A task whose id is known ends only by a cancel that names it.
    if (index < 0) index = pending.findIndex((task) => !task.idKnown);
    if (index >= 0) pending.splice(index, 1);
  }
  return pending;
}

/** Seconds until the soonest firing (0 when it cannot be worked out); null = nothing pending. */
function soonestFiring(tasks: readonly TaskCreated[], nowMs: number): number | null {
  let soonest: number | null = null;
  const note = (seconds: number): void => {
    soonest = soonest === null ? seconds : Math.min(soonest, seconds);
  };
  for (const task of tasks) {
    if (!task.recurring && task.cron !== null) {
      // A one-shot fires at its first match, however far ahead, and then deletes itself: it has
      // no lifetime. Once that match is past (plus its jitter) it is gone.
      const firstMs = nextCronFire(task.cron, task.atMs, task.atMs + ONE_SHOT_HORIZON_MS);
      if (firstMs !== null) {
        if (firstMs + ONE_SHOT_GRACE_MS > nowMs) note(Math.max(0, Math.ceil((firstMs - nowMs) / 1000)));
        continue;
      }
      // A first match that cannot be worked out: judged like any task below.
    }
    const endsAtMs = task.atMs + TASK_LIFETIME_MS;
    // Only a real end in the past ends a task; an end that cannot be computed does not.
    if (Number.isFinite(endsAtMs) && endsAtMs <= nowMs) continue;
    const firesAtMs = task.cron === null ? null : nextCronFire(task.cron, nowMs, endsAtMs);
    note(firesAtMs === null ? 0 : Math.max(0, Math.ceil((firesAtMs - nowMs) / 1000)));
  }
  return soonest;
}

async function continuesFrom(handle: fs.promises.FileHandle, scan: FileScan, size: number): Promise<boolean> {
  if (size < scan.offset) return false;
  if (scan.seam.length === 0) return true;
  const seam = await readRange(handle, scan.offset - scan.seam.length, scan.offset);
  return seam.equals(scan.seam);
}

/** Pending CronCreate tasks per transcript, read incrementally across scans. */
export class CronJobs {
  private readonly files = new Map<string, FileScan>();
  private readonly reads = new Map<string, Promise<FileScan>>();
  private readonly sliceBytes: number;
  private readonly maxLineBytes: number;

  constructor(options: CronJobsOptions = {}) {
    this.sliceBytes = options.sliceBytes ?? DEFAULT_SLICE_BYTES;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /**
   * Seconds until the next firing of the soonest task made in this transcript and not cancelled
   * (0 when that cannot be worked out), or null when there is none - and also while the file has
   * not been read to its end once yet. `size` and `mtimeMs` are the file as the caller saw it.
   * Rejects on a file system error.
   */
  async pendingSeconds(path: string, size: number, mtimeMs: number, nowMs: number): Promise<number | null> {
    const scan = await this.current(path, size, mtimeMs);
    scan.usedAtMs = nowMs;
    return scan.complete ? soonestFiring(pendingTasks(scan.events), nowMs) : null;
  }

  /** Ends one scan: a transcript nobody asked about for an hour is forgotten. */
  forgetUnused(nowMs: number): void {
    for (const [path, scan] of this.files) {
      if (nowMs - scan.usedAtMs > UNUSED_FOR_MS) this.files.delete(path);
    }
  }

  private current(path: string, size: number, mtimeMs: number): Promise<FileScan> {
    const known = this.files.get(path);
    if (known !== undefined && known.offset === size && known.size === size && known.mtimeMs === mtimeMs) {
      return Promise.resolve(known);
    }
    // Two sessions can share a transcript: their reads must not interleave.
    const before = this.reads.get(path);
    const read = (before === undefined ? Promise.resolve() : before.then(() => undefined, () => undefined)).then(() =>
      this.readSlice(path, mtimeMs),
    );
    this.reads.set(path, read);
    const settle = (): void => {
      if (this.reads.get(path) === read) this.reads.delete(path);
    };
    read.then(settle, settle);
    return read;
  }

  private async readSlice(path: string, mtimeMs: number): Promise<FileScan> {
    const handle = await fs.promises.open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      const known = this.files.get(path);
      // A file that shrank or changed under what was read is another file: it is read anew.
      const scan = known !== undefined && (await continuesFrom(handle, known, stat.size)) ? known : freshScan();
      const end = Math.min(stat.size, scan.offset + this.sliceBytes);
      const bytes = await readRange(handle, scan.offset, end);
      // Everything above may fail; nothing below does, so a failed read changes nothing.
      consume(scan, bytes, mtimeMs, this.maxLineBytes);
      scan.seam = lastBytes(scan.seam, bytes, SEAM_BYTES);
      scan.offset = end;
      scan.size = stat.size;
      scan.mtimeMs = mtimeMs;
      if (end >= stat.size) scan.complete = true;
      this.files.set(path, scan);
      return scan;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
