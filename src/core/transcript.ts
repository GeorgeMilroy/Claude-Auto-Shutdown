// Reads Claude Code transcripts (.jsonl) without loading the whole file (they reach hundreds of MB)
// and decides the TURN STATE - the single most important signal: during /compact or an API
// rate-limit wait the file is frozen for minutes while the session is very much alive.
//
// A transcript is untrusted input: every record is `unknown` until checked. One shape closes any
// turn: an assistant record with stop_reason end_turn / stop_sequence. In a session's own
// transcript, three records Claude Code writes when the main thread stops otherwise close it too:
// the Esc marker, a declined permission that ends the turn, and the output of a local command.
// Whatever else the tail holds ends as OPEN or UNKNOWN, and both keep the PC on.

import * as fs from 'node:fs';

import type { TranscriptEvent, TurnActivity, TurnInfo, TurnReading, TurnReason, TurnState } from './types';

const DEFAULT_INITIAL_BYTES = 256 * 1024;
const DEFAULT_LIMIT_BYTES = 16 * 1024 * 1024;
const WINDOW_GROWTH = 4;
const NEWLINE = 0x0a;

const WAKEUP_TOOL = 'ScheduleWakeup';
const MAX_WAKEUP_SECONDS = 86_400;

const DEFAULT_EVENT_COUNT = 40;
const MAX_PREVIEW_CHARS = 400;
const MAX_DETAIL_CHARS = 120;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record's `message` when it is an object, else an empty one (every field reads as undefined). */
function messageOf(record: JsonObject): JsonObject {
  return isObject(record.message) ? record.message : {};
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isObject(block) && block.type === 'tool_result');
}

/** At most `maxChars` of `text` on one line: every run of whitespace becomes a single space. */
function oneLine(text: string, maxChars: number): string {
  let line = '';
  // Lazy on purpose: a tool result can be megabytes and only its first words are ever shown.
  for (const match of text.matchAll(/\S+/g)) {
    line = line === '' ? match[0] : `${line} ${match[0]}`;
    if (line.length >= maxChars) break;
  }
  const cut = line.slice(0, maxChars).trimEnd();
  const last = cut.charCodeAt(cut.length - 1);
  // Never end on half of a surrogate pair (an emoji cut in two).
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A string value as a short one-line detail; anything that is not a non-blank string is null. */
function detailText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return oneLine(value, MAX_DETAIL_CHARS) || null;
}

// ---------------------------------------------------------------------------------------------
// Turn classification
// ---------------------------------------------------------------------------------------------

/** Only these record types decide turn state (an allow-list: unknown record types are noise). */
export const DECISIVE_RECORD_TYPES: ReadonlySet<string> = new Set(['assistant', 'user']);

function turnInfo(state: TurnState, reason: TurnReason, detail: string | null = null): TurnInfo {
  return { state, reason, detail, scheduledWakeupSeconds: null };
}

function classifyAssistant(stopReason: unknown): TurnInfo {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return turnInfo('CLOSED', 'turnEnded');
    case 'tool_use':
      return turnInfo('OPEN', 'toolInFlight');
    case 'max_tokens':
      return turnInfo('OPEN', 'cutAtTokenLimit');
    default:
      // A missing, null or not yet known stop_reason: the reply is still streaming, or was cut.
      return turnInfo('OPEN', 'replyInProgress', detailText(stopReason));
  }
}

/** Classify ONE parsed transcript record. Pure. Anything unrecognised is UNKNOWN. */
export function classifyRecord(record: unknown): TurnInfo {
  if (!isObject(record)) return turnInfo('UNKNOWN', 'unknownRecord');
  // Any truthy value counts: mistaking a record for a compaction can only keep the PC on.
  if (record.isCompactSummary) return turnInfo('OPEN', 'compacting');
  if (record.type === 'assistant') return classifyAssistant(messageOf(record).stop_reason);
  if (record.type === 'user') {
    // Either way the ball is with the model: it is computing, compacting or waiting on a rate limit.
    return turnInfo('OPEN', hasToolResult(messageOf(record).content) ? 'readingToolResult' : 'thinking');
  }
  return turnInfo('UNKNOWN', 'unknownRecord', detailText(record.type));
}

function isConversationRecord(record: JsonObject): boolean {
  if (record.isCompactSummary) return true;
  return typeof record.type === 'string' && DECISIVE_RECORD_TYPES.has(record.type);
}

// ---------------------------------------------------------------------------------------------
// Records Claude Code writes for the session rather than for a turn
// ---------------------------------------------------------------------------------------------

/** The text of Claude Code's Esc marker. It is always a one-block array; a typed prompt is a string. */
const INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);
const LOCAL_COMMAND_CAVEAT = '<local-command-caveat>';
/** What a local command printed: it ran without the model. */
const LOCAL_COMMAND_OUTPUT = ['<local-command-stdout>', '<local-command-stderr>'];
/** Openings of user records Claude Code also writes while the session is idle. */
const IDLE_OPENINGS = [
  LOCAL_COMMAND_CAVEAT,
  '<command-name>',
  ...LOCAL_COMMAND_OUTPUT,
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];

/** The text a user record opens with: the whole string, or its first block when that is text. */
function openingText(content: unknown): string {
  if (typeof content === 'string') return content.trimStart();
  if (!Array.isArray(content)) return '';
  const first: unknown = content[0];
  return isObject(first) && first.type === 'text' && typeof first.text === 'string' ? first.text.trimStart() : '';
}

function opensWith(record: JsonObject, openings: readonly string[]): boolean {
  if (record.type !== 'user') return false;
  const text = openingText(messageOf(record).content);
  return openings.some((opening) => text.startsWith(opening));
}

function isInterruptMarker(record: JsonObject): boolean {
  if (record.type !== 'user') return false;
  const content = messageOf(record).content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block: unknown = content[0];
  return isObject(block) && block.type === 'text' && typeof block.text === 'string' && INTERRUPT_MARKERS.has(block.text);
}

/** The answer to a declined permission when Claude Code ends the turn with it. */
function isTurnEndingDenial(record: JsonObject): boolean {
  return record.type === 'user' && record.toolDenialEndsTurn === true && hasToolResult(messageOf(record).content);
}

/** Written before a local command's own records; it says nothing at all about the turn. */
function isLocalCommandCaveat(record: JsonObject): boolean {
  return opensWith(record, [LOCAL_COMMAND_CAVEAT]);
}

/**
 * Written while the session is idle as well as during a turn, so it proves no turn: a local
 * command, a `!` shell line, the Esc marker, a declined permission. A prompt, a reply, a tool call
 * or a tool result is only ever written during a turn - and so is a meta record: every firing of a
 * /loop wake-up or a scheduled task is a meta prompt. Strict on purpose: a record wrongly taken
 * for one of these could hide a turn.
 */
function writtenWhileIdle(record: JsonObject): boolean {
  if (record.isCompactSummary) return false;
  return isInterruptMarker(record) || isTurnEndingDenial(record) || opensWith(record, IDLE_OPENINGS);
}

/**
 * How the main thread stops besides an end_turn reply. A subagent stopped this way may still be
 * resumed (parked, sent to the background), so a subagent's records never close a turn like this.
 */
function mainThreadEnding(record: JsonObject): TurnInfo | null {
  if (record.isCompactSummary) return null;
  if (isInterruptMarker(record)) return turnInfo('CLOSED', 'interrupted');
  if (isTurnEndingDenial(record)) return turnInfo('CLOSED', 'toolDeclined');
  if (opensWith(record, LOCAL_COMMAND_OUTPUT)) return turnInfo('CLOSED', 'localCommand');
  return null;
}

function timeOf(value: unknown): number | null {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A subagent's record carried inside the main transcript. Any truthy value counts: taking a
 * main-thread record for a subagent's can only keep the PC on.
 */
function isSidechain(record: JsonObject): boolean {
  return Boolean(record.isSidechain);
}

// ---------------------------------------------------------------------------------------------
// Tail reading
// ---------------------------------------------------------------------------------------------

export interface ReadTurnOptions {
  /** First tail window. Default 256 KB. */
  initialBytes?: number;
  /** The window grows x4 until a conversation record is found or this is reached. Default 16 MB. */
  limitBytes?: number;
  /**
   * The file is a session's own transcript, not a subagent's: a subagent record in it (isSidechain)
   * may open the turn but never close it, because one subagent finishing says nothing about the
   * main thread, which may still wait for others. Default false.
   */
  mainThread?: boolean;
}

interface Tail {
  /** Complete, trimmed, non-blank lines of the window, NEWEST FIRST. */
  newestFirst: string[];
  /** The file has content and its last byte is not '\n'. */
  tornEnd: boolean;
  /** The window does not reach the start of the file: older lines exist. */
  truncated: boolean;
}

interface ParsedLine {
  /** The line is complete JSON. */
  valid: boolean;
  /** The parsed value when it is a JSON object (every real record is), else null. */
  record: JsonObject | null;
}

const utf8 = new TextDecoder('utf-8');

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function parseLine(line: string): ParsedLine {
  try {
    const value: unknown = JSON.parse(line);
    return { valid: true, record: isObject(value) ? value : null };
  } catch {
    return { valid: false, record: null };
  }
}

function completeLines(bytes: Buffer, truncated: boolean): string[] {
  const lines = utf8.decode(bytes).split('\n');
  // A window that does not start at byte 0 starts mid-record: its first line is a fragment, and a
  // fragment that happens to parse must never be mistaken for a record.
  if (truncated) lines.shift();
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reverse();
}

/** Bytes `from`..`to` of an open file. Rejects when the file ends before `to`. */
export async function readRange(handle: fs.promises.FileHandle, from: number, to: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(to - from);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled);
    // Transcripts only ever grow. One that ends before the size it had a moment ago was truncated
    // or replaced under us, and nothing read from it can be trusted.
    if (bytesRead === 0) throw new Error('the file shrank while it was being read');
    filled += bytesRead;
  }
  return buffer;
}

/**
 * Shows `inspect` the tail of the file in growing windows until it returns something, the window
 * covers the whole file, or the limit is reached. A single record can be larger than the first
 * window (tool results of several MB exist), and such a record is exactly the one that says "the
 * model just got a result and is working on it". Rejects on any fs error.
 *
 * `size` is the file size the search worked on: bytes appended after the handle was opened are
 * not looked at. `complete`: the whole file was looked at.
 */
async function searchTail<T>(
  path: string,
  options: ReadTurnOptions | undefined,
  inspect: (tail: Tail) => T | null,
): Promise<{ found: T | null; size: number; complete: boolean }> {
  const initialBytes = positiveInt(options?.initialBytes, DEFAULT_INITIAL_BYTES);
  const limitBytes = Math.max(initialBytes, positiveInt(options?.limitBytes, DEFAULT_LIMIT_BYTES));
  const handle = await fs.promises.open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    const size = stat.size;
    let bytes: Buffer = Buffer.alloc(0);
    let start = size;
    for (let windowBytes = initialBytes; ; windowBytes = Math.min(windowBytes * WINDOW_GROWTH, limitBytes)) {
      const from = Math.max(0, size - windowBytes);
      bytes = Buffer.concat([await readRange(handle, from, start), bytes]);
      start = from;
      const found = inspect({
        newestFirst: completeLines(bytes, start > 0),
        tornEnd: bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE,
        truncated: start > 0,
      });
      if (found !== null || start === 0 || windowBytes >= limitBytes) return { found, size, complete: start === 0 };
    }
  } finally {
    // What was read stays valid even if the close fails.
    await handle.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------------------------

/** Delay of one ScheduleWakeup call that really schedules something, else null. */
function wakeupDelay(block: unknown): number | null {
  if (!isObject(block) || block.type !== 'tool_use' || block.name !== WAKEUP_TOOL) return null;
  const input = isObject(block.input) ? block.input : {};
  if (input.stop === true) return null;
  const delay = input.delaySeconds;
  if (typeof delay !== 'number' || !Number.isFinite(delay)) return null;
  return Math.min(Math.max(delay, 0), MAX_WAKEUP_SECONDS);
}

function lastWakeupDelay(content: unknown): number | null {
  if (!Array.isArray(content)) return null;
  for (const block of [...content].reverse()) {
    const delay = wakeupDelay(block);
    if (delay !== null) return delay;
  }
  return null;
}

/**
 * A session that ended its turn but scheduled its own wake-up (/loop) is not finished. Looks
 * through the final turn - from its deciding record back to the prompt that started it - for the
 * last ScheduleWakeup call. Blocking-only: it can make a CLOSED turn count as working, never the
 * other way round.
 */
function wakeupInFinalTurn(newestFirst: readonly string[], mainThread: boolean): number | null {
  let inTurn = false;
  for (const line of newestFirst) {
    const { record } = parseLine(line);
    // A subagent's prompt is not the prompt that started the main thread's turn.
    if (record === null || (mainThread && isSidechain(record))) continue;
    // A local command, a `!` line or an Esc after the final turn's last reply started no new
    // turn: the wake-up that turn scheduled still stands. Inside the turn they are not looked past.
    if (!inTurn && writtenWhileIdle(record)) continue;
    const content = messageOf(record).content;
    // A prompt (a user record that is not a tool result: typed, a command, or the meta prompt of
    // a wake-up firing) started this turn; anything older belongs to an earlier turn, whose
    // wake-up has fired or been replaced since.
    if (record.type === 'user' && !hasToolResult(content)) return null;
    if (record.type !== 'assistant') continue;
    inTurn = true;
    const delay = lastWakeupDelay(content);
    if (delay !== null) return delay;
  }
  return null;
}

/** The newest record only a turn writes, as far as the window reaches. */
function activityInTail(tail: Tail): TurnActivity {
  for (const line of tail.newestFirst) {
    const { record } = parseLine(line);
    if (record === null || !isConversationRecord(record) || writtenWhileIdle(record)) continue;
    const ms = timeOf(record.timestamp);
    return ms === null ? { kind: 'untimed' } : { kind: 'at', ms };
  }
  // The lines before the window may hold one.
  return tail.truncated ? { kind: 'untimed' } : { kind: 'none' };
}

/** A write in progress: what it will say, and when, is not known yet. */
const BEING_WRITTEN: TurnReading = {
  turn: turnInfo('OPEN', 'recordBeingWritten'),
  activity: { kind: 'untimed' },
  wakeupSeconds: null,
};

function turnInTail(tail: Tail, mainThread: boolean): TurnReading | null {
  // A record is appended as one line ending in '\n'. No final newline = the write is in progress.
  if (tail.tornEnd) return copyReading(BEING_WRITTEN);
  for (const [index, line] of tail.newestFirst.entries()) {
    const { valid, record } = parseLine(line);
    // Only the newest line can be a record caught mid-write. Skipping it would let the record
    // before it decide - possibly a CLOSED one, while a new turn is already being written.
    if (!valid && index === 0) return copyReading(BEING_WRITTEN);
    if (record === null || !isConversationRecord(record) || isLocalCommandCaveat(record)) continue;
    const ending = mainThread && !isSidechain(record) ? mainThreadEnding(record) : null;
    const turn = ending ?? classifyRecord(record);
    if (turn.state === 'CLOSED' && mainThread && isSidechain(record)) continue;
    const wakeupSeconds = wakeupInFinalTurn(tail.newestFirst.slice(index), mainThread);
    return {
      turn: turn.state === 'CLOSED' ? { ...turn, scheduledWakeupSeconds: wakeupSeconds } : turn,
      activity: activityInTail(tail),
      wakeupSeconds,
    };
  }
  return null;
}

/**
 * Short error text for the UI. A system error loses the ", open 'C:\...'" that Node appends: the
 * path is long and the caller already has it.
 */
function readErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const isSystemError = isObject(error) && typeof error.syscall === 'string';
  const suffix = message.indexOf(', ');
  return oneLine(isSystemError && suffix > 0 ? message.slice(0, suffix) : message, MAX_DETAIL_CHARS) || 'unknown error';
}

function turnForReadError(error: unknown): TurnInfo {
  if (isObject(error) && error.code === 'ENOENT') return turnInfo('UNKNOWN', 'noTranscript');
  return turnInfo('UNKNOWN', 'cannotRead', readErrorText(error));
}

interface TurnSnapshot {
  reading: TurnReading;
  /** Size of the file the turn was read from; null when it could not be read. */
  size: number | null;
}

/** Every caller gets its own object: nothing done to it can change a cached answer. */
function copyReading(reading: TurnReading): TurnReading {
  return { turn: { ...reading.turn }, activity: { ...reading.activity }, wakeupSeconds: reading.wakeupSeconds };
}

async function readTurnSnapshot(path: string, options: ReadTurnOptions | undefined): Promise<TurnSnapshot> {
  try {
    const mainThread = options?.mainThread === true;
    const { found, size, complete } = await searchTail(path, options, (tail) => turnInTail(tail, mainThread));
    if (found !== null) return { reading: found, size };
    const activity: TurnActivity = complete ? { kind: 'none' } : { kind: 'untimed' };
    return { reading: { turn: turnInfo('UNKNOWN', 'noConversationRecord'), activity, wakeupSeconds: null }, size };
  } catch (error) {
    const turn = turnForReadError(error);
    const activity: TurnActivity = turn.reason === 'noTranscript' ? { kind: 'none' } : { kind: 'untimed' };
    return { reading: { turn, activity, wakeupSeconds: null }, size: null };
  }
}

/**
 * Turn state of a transcript from its tail. Never rejects: unreadable = UNKNOWN 'cannotRead',
 * missing = UNKNOWN 'noTranscript', no assistant/user record within the limit = UNKNOWN
 * 'noConversationRecord'. A file that does not end in '\n', or whose last non-empty line does not
 * parse, is OPEN 'recordBeingWritten'.
 */
export async function readTurn(path: string, options?: ReadTurnOptions): Promise<TurnInfo> {
  return (await readTurnSnapshot(path, options)).reading.turn;
}

/** readTurn, plus when the session last worked and the wake-up of its final turn. Never rejects. */
export async function readTurnReading(path: string, options?: ReadTurnOptions): Promise<TurnReading> {
  return (await readTurnSnapshot(path, options)).reading;
}

// ---------------------------------------------------------------------------------------------
// Turn cache
// ---------------------------------------------------------------------------------------------

interface CachedTurn {
  size: number;
  mtimeMs: number;
  reading: Promise<TurnReading>;
}

/**
 * Caches readTurnReading() by (path, size, mtimeMs) so an unchanged transcript is not re-read
 * every poll. `prune` drops entries for paths that are no longer of interest. `options` only
 * matter when the file is actually read.
 */
export class TurnCache {
  private readonly entries = new Map<string, CachedTurn>();

  get(path: string, size: number, mtimeMs: number, options?: ReadTurnOptions): Promise<TurnInfo> {
    return this.getReading(path, size, mtimeMs, options).then((reading) => reading.turn);
  }

  getReading(path: string, size: number, mtimeMs: number, options?: ReadTurnOptions): Promise<TurnReading> {
    const cached = this.entries.get(path);
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) return cached.reading.then(copyReading);

    const entry: CachedTurn = {
      size,
      mtimeMs,
      reading: readTurnSnapshot(path, options).then((snapshot) => {
        // Keep an answer only when it describes the file exactly as the caller saw it. A failed
        // read may succeed next poll (a sharing violation, a network path), and a file that has
        // changed size since the caller's stat is not the file this key stands for.
        if (snapshot.size !== size && this.entries.get(path) === entry) this.entries.delete(path);
        return snapshot.reading;
      }),
    };
    this.entries.set(path, entry);
    return entry.reading.then(copyReading);
  }

  prune(keep: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) {
      if (!keep.has(path)) this.entries.delete(path);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Transcript preview
// ---------------------------------------------------------------------------------------------

type PartKind = Exclude<TranscriptEvent['kind'], 'other'>;

interface Part {
  kind: PartKind;
  text: string;
}

/** Keyed by the raw record type, which may be anything at all. */
const WHO: ReadonlyMap<unknown, TranscriptEvent['who']> = new Map<unknown, TranscriptEvent['who']>([
  ['assistant', 'claude'],
  ['user', 'you'],
  ['system', 'system'],
]);

/** The kind that names a record mixing several block kinds: the first one present, in this order. */
const KIND_PRIORITY: readonly PartKind[] = ['text', 'tool', 'result', 'thinking'];

/** The tool input that says most about a call, in order of preference. */
const TOOL_ARGUMENT_KEYS = ['command', 'file_path', 'pattern', 'prompt', 'description'] as const;

const THINKING_TEXT = '(thinking)';
const EMPTY_RESULT_TEXT = '(no text output)';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function textPart(text: unknown): Part[] {
  return isNonBlankString(text) ? [{ kind: 'text', text }] : [];
}

function toolCallText(block: JsonObject): string {
  const name = isNonBlankString(block.name) ? block.name : 'tool';
  const input = isObject(block.input) ? block.input : {};
  for (const key of TOOL_ARGUMENT_KEYS) {
    const value = input[key];
    if (isNonBlankString(value)) return `${name}: ${value}`;
  }
  return name;
}

function toolResultText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (!Array.isArray(body)) return '';
  return body.map((item) => (isObject(item) && typeof item.text === 'string' ? item.text : '')).join(' ');
}

function blockPart(block: unknown): Part[] {
  if (!isObject(block)) return [];
  switch (block.type) {
    case 'text':
      return textPart(block.text);
    case 'thinking':
    case 'redacted_thinking':
      return [{ kind: 'thinking', text: THINKING_TEXT }];
    case 'tool_use':
      return [{ kind: 'tool', text: toolCallText(block) }];
    case 'tool_result':
      return [{ kind: 'result', text: oneLine(toolResultText(block.content), MAX_PREVIEW_CHARS) }];
    default:
      return [];
  }
}

function previewParts(record: JsonObject): Part[] {
  const content = messageOf(record).content;
  if (typeof content === 'string') return textPart(content);
  if (Array.isArray(content)) return content.flatMap((block) => blockPart(block));
  return textPart(record.summary);
}

/** 'HH:MM:SS' out of an ISO timestamp ('2026-01-31T12:34:56.789Z'), '' for anything else. */
function clockTime(timestamp: unknown): string {
  const time = typeof timestamp === 'string' ? timestamp.slice(11, 19) : '';
  return /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '';
}

/** One preview line for one parsed record. Pure. */
export function describeRecord(record: unknown): TranscriptEvent {
  const fields = isObject(record) ? record : {};
  const parts = previewParts(fields);
  const kind = KIND_PRIORITY.find((candidate) => parts.some((part) => part.kind === candidate)) ?? 'other';
  const text = oneLine(parts.map((part) => part.text).join(' '), MAX_PREVIEW_CHARS);
  const placeholder = kind === 'result' ? EMPTY_RESULT_TEXT : `(${detailText(fields.type) ?? 'unknown'})`;
  return {
    time: clockTime(fields.timestamp),
    who: WHO.get(fields.type) ?? 'other',
    sidechain: fields.isSidechain === true,
    text: text || placeholder,
    kind,
  };
}

function newestConversationRecords(newestFirst: readonly string[], count: number): JsonObject[] {
  const records: JsonObject[] = [];
  for (const line of newestFirst) {
    if (records.length >= count) break;
    const { record } = parseLine(line);
    if (record !== null && isConversationRecord(record)) records.push(record);
  }
  return records;
}

/**
 * The last `count` conversation records, oldest first, for the transcript preview. Never rejects:
 * a transcript that cannot be read gives an empty list. Uses the same adaptive tail as readTurn
 * (the window grows only while it holds no conversation record at all).
 */
export async function tailEvents(
  path: string,
  count: number = DEFAULT_EVENT_COUNT,
  options?: ReadTurnOptions,
): Promise<TranscriptEvent[]> {
  const wanted = Number.isFinite(count) ? Math.floor(count) : DEFAULT_EVENT_COUNT;
  if (wanted < 1) return [];
  try {
    const { found } = await searchTail(path, options, (tail) => {
      const records = newestConversationRecords(tail.newestFirst, wanted);
      return records.length > 0 ? records : null;
    });
    return (found ?? []).reverse().map((record) => describeRecord(record));
  } catch {
    return [];
  }
}
