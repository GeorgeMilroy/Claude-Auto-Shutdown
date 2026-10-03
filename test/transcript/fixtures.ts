// Synthetic transcript records and files for the transcript tests. Nothing here touches a real
// ~/.claude: every file lives in a fresh temp directory that the test removes again.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Json = Record<string, unknown>;

export const textBlock = (text: string): Json => ({ type: 'text', text });
export const thinkingBlock = (): Json => ({ type: 'thinking', thinking: 'private reasoning', signature: 'sig' });
export const toolUse = (name: string, input: unknown): Json => ({ type: 'tool_use', id: 'toolu_01', name, input });
export const toolResultBlock = (content: unknown): Json => ({ type: 'tool_result', tool_use_id: 'toolu_01', content });

/** An assistant record. `stopReason` is written as given (null and undefined included). */
export function assistant(stopReason: unknown, content: unknown = [textBlock('ok')], extra: Json = {}): Json {
  return {
    type: 'assistant',
    timestamp: '2026-01-31T12:34:56.789Z',
    message: { role: 'assistant', stop_reason: stopReason, content },
    ...extra,
  };
}

/** A human prompt: a user record with plain text. */
export function prompt(text: string, extra: Json = {}): Json {
  return { type: 'user', timestamp: '2026-01-31T12:34:00.000Z', message: { role: 'user', content: text }, ...extra };
}

/** A user record carrying the result of a tool call. */
export function toolResult(body: unknown = 'done', extra: Json = {}): Json {
  return {
    type: 'user',
    timestamp: '2026-01-31T12:34:30.000Z',
    message: { role: 'user', content: [toolResultBlock(body)] },
    ...extra,
  };
}

export const wakeupCall = (input: unknown): Json => assistant('tool_use', [toolUse('ScheduleWakeup', input)]);

/** A technical record that says nothing about the turn. */
export const noise = (type: string): Json => ({ type, uuid: `noise-${type}`, timestamp: '2026-01-31T12:35:00.000Z' });

export const NOISE_TYPES = [
  'frame-link',
  'pr-link',
  'permission-mode',
  'attachment',
  'system',
  'summary',
  'file-history-snapshot',
  'queue-operation',
  'artifact-comment-monitor',
  'a-type-invented-next-year',
] as const;

export function jsonl(records: readonly unknown[], eol = '\n'): string {
  return records.map((record) => JSON.stringify(record) + eol).join('');
}

export interface FixtureDir {
  readonly dir: string;
  /** Writes a new file with exactly this content and returns its path. */
  write(content: string | Uint8Array): string;
  /** Writes the records as JSONL (every line terminated) and returns the path. */
  transcript(records: readonly unknown[], eol?: string): string;
  remove(): void;
}

export function createFixtureDir(): FixtureDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-transcript-'));
  let files = 0;
  const write = (content: string | Uint8Array): string => {
    const file = path.join(dir, `session-${++files}.jsonl`);
    fs.writeFileSync(file, content);
    return file;
  };
  return {
    dir,
    write,
    transcript: (records, eol) => write(jsonl(records, eol)),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');
