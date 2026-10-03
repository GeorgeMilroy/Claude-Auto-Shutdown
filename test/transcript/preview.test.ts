import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { describeRecord, tailEvents } from '../../src/core/transcript';
import type { TranscriptEvent } from '../../src/core/types';
import {
  NOISE_TYPES,
  assistant,
  createFixtureDir,
  jsonl,
  noise,
  prompt,
  textBlock,
  thinkingBlock,
  toolResult,
  toolResultBlock,
  toolUse,
  type FixtureDir,
} from './fixtures';

const toolCall = (name: unknown, input: unknown) => assistant('tool_use', [{ type: 'tool_use', id: 'toolu_01', name, input }]);

describe('describeRecord: text', () => {
  it('describes a prompt with plain string content', () => {
    expect(describeRecord(prompt('please fix the build'))).toEqual<TranscriptEvent>({
      time: '12:34:00',
      who: 'you',
      sidechain: false,
      text: 'please fix the build',
      kind: 'text',
    });
  });

  it('joins the text blocks of an assistant record', () => {
    expect(describeRecord(assistant('end_turn', [textBlock('First part.'), textBlock('Second part.')]))).toEqual<TranscriptEvent>({
      time: '12:34:56',
      who: 'claude',
      sidechain: false,
      text: 'First part. Second part.',
      kind: 'text',
    });
  });

  it('collapses every run of whitespace into one space', () => {
    const event = describeRecord(prompt('  line one\r\n\r\n\tline   two\u00a0\u2028line three \n'));
    expect(event.text).toBe('line one line two line three');
  });

  it('caps the text at 400 characters', () => {
    expect(describeRecord(prompt('x'.repeat(5000))).text).toBe('x'.repeat(400));
    const words = describeRecord(prompt('word '.repeat(500))).text;
    expect(words.length).toBeLessThanOrEqual(400);
    expect(words).toMatch(/^(word )+word$/);
  });

  it('never ends on half of an emoji', () => {
    const text = describeRecord(prompt(`${'a'.repeat(399)}😀 tail`)).text;
    expect(text).toBe('a'.repeat(399));
    const whole = describeRecord(prompt(`${'a'.repeat(398)}😀 tail`)).text;
    expect(whole).toBe(`${'a'.repeat(398)}😀`);
  });

  it('skips blank text blocks and blocks that are not objects', () => {
    const record = assistant('end_turn', [textBlock('   '), null, 'loose string', 7, [textBlock('nested')], textBlock('real')]);
    expect(describeRecord(record)).toMatchObject({ text: 'real', kind: 'text' });
  });

  it('skips text that is not a string', () => {
    const record = assistant('end_turn', [{ type: 'text', text: { deep: 'object' } }, { type: 'text' }]);
    expect(describeRecord(record)).toMatchObject({ text: '(assistant)', kind: 'other' });
  });

  it('shows a summary record by its summary', () => {
    expect(describeRecord({ type: 'summary', summary: 'Fixed the  flaky\ntest' })).toEqual<TranscriptEvent>({
      time: '',
      who: 'other',
      sidechain: false,
      text: 'Fixed the flaky test',
      kind: 'text',
    });
  });
});

describe('describeRecord: thinking', () => {
  it('shows a thinking block as "(thinking)", never its content', () => {
    expect(describeRecord(assistant(null, [thinkingBlock()]))).toMatchObject({
      who: 'claude',
      text: '(thinking)',
      kind: 'thinking',
    });
    expect(describeRecord(assistant(null, [{ type: 'redacted_thinking', data: 'opaque' }]))).toMatchObject({
      text: '(thinking)',
      kind: 'thinking',
    });
  });

  it('is kind text as soon as real text accompanies the thinking', () => {
    expect(describeRecord(assistant('end_turn', [thinkingBlock(), textBlock('The answer is 4.')]))).toMatchObject({
      text: '(thinking) The answer is 4.',
      kind: 'text',
    });
  });
});

describe('describeRecord: tool_use', () => {
  it.each([
    ['command', toolCall('Bash', { command: 'npm test' }), 'Bash: npm test'],
    ['file_path', toolCall('Read', { file_path: 'C:\\src\\app.ts' }), 'Read: C:\\src\\app.ts'],
    ['pattern', toolCall('Grep', { pattern: 'shutdown|restart', path: 'src' }), 'Grep: shutdown|restart'],
    ['prompt', toolCall('Agent', { prompt: 'Find the flaky test' }), 'Agent: Find the flaky test'],
    ['description', toolCall('Task', { description: 'Run the linter' }), 'Task: Run the linter'],
  ])('shows the %s of a call', (_key, record, text) => {
    expect(describeRecord(record)).toMatchObject({ who: 'claude', text, kind: 'tool' });
  });

  it('prefers command, then file_path, pattern, prompt, description', () => {
    const all = { description: 'd', prompt: 'p', pattern: 'pt', file_path: 'f', command: 'c' };
    expect(describeRecord(toolCall('X', all)).text).toBe('X: c');
    expect(describeRecord(toolCall('X', { ...all, command: undefined })).text).toBe('X: f');
    expect(describeRecord(toolCall('X', { description: 'd', prompt: 'p', pattern: 'pt' })).text).toBe('X: pt');
    expect(describeRecord(toolCall('X', { description: 'd', prompt: 'p' })).text).toBe('X: p');
  });

  it('skips an argument that is blank or not a string', () => {
    expect(describeRecord(toolCall('Bash', { command: '   ', description: 'List files' })).text).toBe('Bash: List files');
    expect(describeRecord(toolCall('Edit', { command: 42, file_path: 'a.ts' })).text).toBe('Edit: a.ts');
    expect(describeRecord(toolCall('Edit', { command: { run: 'x' }, file_path: ['a.ts'] })).text).toBe('Edit');
  });

  it('shows just the name when no known argument is present', () => {
    expect(describeRecord(toolCall('TodoWrite', { todos: [] }))).toMatchObject({ text: 'TodoWrite', kind: 'tool' });
    expect(describeRecord(toolCall('TodoWrite', undefined)).text).toBe('TodoWrite');
    expect(describeRecord(toolCall('TodoWrite', 'not an object')).text).toBe('TodoWrite');
  });

  it('calls a tool without a usable name "tool"', () => {
    expect(describeRecord(toolCall(undefined, { command: 'ls' })).text).toBe('tool: ls');
    expect(describeRecord(toolCall(17, { command: 'ls' })).text).toBe('tool: ls');
    expect(describeRecord(toolCall('', {})).text).toBe('tool');
  });

  it('puts a multi-line command on one line', () => {
    expect(describeRecord(toolCall('Bash', { command: 'cd repo &&\n  npm ci &&\n  npm test' })).text).toBe(
      'Bash: cd repo && npm ci && npm test',
    );
  });

  it('is kind text when the call comes with text, kind tool when it only comes with thinking', () => {
    const withText = assistant('tool_use', [textBlock('Running the tests.'), toolUse('Bash', { command: 'npm test' })]);
    expect(describeRecord(withText)).toMatchObject({ text: 'Running the tests. Bash: npm test', kind: 'text' });
    const withThinking = assistant('tool_use', [thinkingBlock(), toolUse('Bash', { command: 'npm test' })]);
    expect(describeRecord(withThinking)).toMatchObject({ text: '(thinking) Bash: npm test', kind: 'tool' });
  });
});

describe('describeRecord: tool_result', () => {
  it('shows a string body', () => {
    expect(describeRecord(toolResult('Tests:  12 passed\n\nTime: 3 s'))).toEqual<TranscriptEvent>({
      time: '12:34:30',
      who: 'you',
      sidechain: false,
      text: 'Tests: 12 passed Time: 3 s',
      kind: 'result',
    });
  });

  it('joins the text items of an array body and ignores everything else in it', () => {
    const body = [
      { type: 'text', text: 'first line' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      'loose',
      null,
      { type: 'text', text: 42 },
      { type: 'text', text: 'second line' },
    ];
    expect(describeRecord(toolResult(body))).toMatchObject({ who: 'you', text: 'first line second line', kind: 'result' });
  });

  it('shows only the first 400 characters of a long result', () => {
    const event = describeRecord(toolResult(`${'y'.repeat(1000)} end`));
    expect(event).toMatchObject({ text: 'y'.repeat(400), kind: 'result' });
  });

  it('handles a multi-megabyte result', () => {
    const event = describeRecord(toolResult(`start ${'line of output\n'.repeat(200_000)}`));
    expect(event.kind).toBe('result');
    expect(event.text.startsWith('start line of output line of output')).toBe(true);
    expect(event.text.length).toBeLessThanOrEqual(400);
  });

  it('says so when a result has no text at all', () => {
    for (const body of ['', '  \n', [], [{ type: 'image' }], null, undefined, 42, { text: 'not a list' }]) {
      const record = { type: 'user', message: { content: [toolResultBlock(body)] } };
      expect(describeRecord(record)).toMatchObject({ who: 'you', text: '(no text output)', kind: 'result' });
    }
  });

  it('is kind text when the user wrote something next to the result', () => {
    const record = { type: 'user', message: { content: [toolResultBlock('exit 0'), textBlock('now deploy it')] } };
    expect(describeRecord(record)).toMatchObject({ who: 'you', text: 'exit 0 now deploy it', kind: 'text' });
  });
});

describe('describeRecord: who, sidechain and time', () => {
  it('names the speaker by record type', () => {
    expect(describeRecord(assistant('end_turn')).who).toBe('claude');
    expect(describeRecord(prompt('hi')).who).toBe('you');
    expect(describeRecord({ type: 'system', subtype: 'compact_boundary' })).toMatchObject({
      who: 'system',
      text: '(system)',
      kind: 'other',
    });
    expect(describeRecord(noise('attachment'))).toMatchObject({ who: 'other', text: '(attachment)', kind: 'other' });
  });

  it('is not fooled by record types that are property names of every object', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(describeRecord({ type })).toMatchObject({ who: 'other', text: `(${type})`, kind: 'other' });
    }
  });

  it('flags a sidechain record only on a real boolean true', () => {
    expect(describeRecord(assistant('end_turn', [textBlock('sub')], { isSidechain: true })).sidechain).toBe(true);
    expect(describeRecord(toolResult('out', { isSidechain: true }))).toMatchObject({ who: 'you', sidechain: true, kind: 'result' });
    for (const value of [false, 'true', 1, null, undefined, {}]) {
      expect(describeRecord(assistant('end_turn', [textBlock('main')], { isSidechain: value })).sidechain).toBe(false);
    }
  });

  it('takes HH:MM:SS from an ISO timestamp', () => {
    expect(describeRecord({ type: 'user', timestamp: '2026-10-03T07:08:09.123Z' }).time).toBe('07:08:09');
    expect(describeRecord({ type: 'user', timestamp: '2026-10-03T23:59:59+02:00' }).time).toBe('23:59:59');
  });

  it('has an empty time for a missing or malformed timestamp', () => {
    for (const timestamp of [undefined, null, '', 1_700_000_000_000, '2026-10-03', 'yesterday at noon!!', '2026-10-03T7:08:09Z', {}]) {
      expect(describeRecord({ type: 'user', timestamp }).time).toBe('');
    }
  });
});

describe('describeRecord: garbage input', () => {
  const blank: TranscriptEvent = { time: '', who: 'other', sidechain: false, text: '(unknown)', kind: 'other' };

  it('never throws on values that are not records', () => {
    for (const garbage of [null, undefined, 0, 42, NaN, true, 'assistant', [], [prompt('hi')], {}, () => 1]) {
      expect(describeRecord(garbage)).toEqual(blank);
    }
  });

  it('copes with a record whose fields have the wrong types', () => {
    const record = { type: ['user'], timestamp: 12, isSidechain: 'yes', message: 'hello', summary: { text: 'x' } };
    expect(describeRecord(record)).toEqual(blank);
    expect(describeRecord({ type: 'assistant', message: { content: 42 } })).toMatchObject({
      who: 'claude',
      text: '(assistant)',
      kind: 'other',
    });
    expect(describeRecord({ type: 'user', message: { content: [] } })).toMatchObject({ who: 'you', text: '(user)', kind: 'other' });
  });

  it('keeps an absurd record type short', () => {
    const event = describeRecord({ type: `weird\n${'z'.repeat(1000)}` });
    expect(event.who).toBe('other');
    expect(event.text.length).toBeLessThanOrEqual(122);
    expect(event.text.startsWith('(weird zzz')).toBe(true);
  });
});

describe('tailEvents', () => {
  let fx: FixtureDir;
  const texts = (events: TranscriptEvent[]) => events.map((event) => event.text);
  const numbered = (count: number) =>
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? prompt(`message ${i + 1}`) : assistant('end_turn', [textBlock(`message ${i + 1}`)])));

  beforeAll(() => {
    fx = createFixtureDir();
  });

  afterAll(() => {
    fx.remove();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the last `count` conversation records, oldest first', async () => {
    const file = fx.transcript(numbered(10));
    expect(texts(await tailEvents(file, 3))).toEqual(['message 8', 'message 9', 'message 10']);
    expect((await tailEvents(file, 3)).map((event) => event.who)).toEqual(['claude', 'you', 'claude']);
  });

  it('returns 40 records by default', async () => {
    const events = await tailEvents(fx.transcript(numbered(50)));
    expect(events).toHaveLength(40);
    expect(events[0]?.text).toBe('message 11');
    expect(events[39]?.text).toBe('message 50');
  });

  it('returns everything when the transcript is shorter than `count`', async () => {
    expect(texts(await tailEvents(fx.transcript(numbered(4)), 100))).toEqual(['message 1', 'message 2', 'message 3', 'message 4']);
  });

  it('describes each record like describeRecord', async () => {
    const records = [
      prompt('run the tests'),
      assistant('tool_use', [toolUse('Bash', { command: 'npm test' })]),
      toolResult('12 passed', { isSidechain: true }),
    ];
    expect(await tailEvents(fx.transcript(records))).toEqual(records.map((record) => describeRecord(record)));
  });

  it('leaves out noise, lines that are not records and torn lines; they do not count either', async () => {
    const file = fx.write(
      jsonl([prompt('message 1'), ...NOISE_TYPES.map(noise), assistant('end_turn', [textBlock('message 2')])]) +
        '123\n[1,2]\nnull\n"user"\n{"type":"assistant","torn\n\n' +
        jsonl([prompt('message 3'), noise('attachment')]),
    );
    expect(texts(await tailEvents(file, 3))).toEqual(['message 1', 'message 2', 'message 3']);
    expect(texts(await tailEvents(file, 2))).toEqual(['message 2', 'message 3']);
  });

  it('includes a compact summary whatever its record type', async () => {
    const file = fx.transcript([
      prompt('message 1'),
      { type: 'summary', isCompactSummary: true, summary: 'the story so far' },
      prompt('continued', { isCompactSummary: true }),
    ]);
    expect(texts(await tailEvents(file))).toEqual(['message 1', 'the story so far', 'continued']);
  });

  it('skips a last line that is still being written, and shows one that is merely unterminated', async () => {
    const torn = fx.write(`${jsonl(numbered(2))}{"type":"user","message":{"content":"mess`);
    expect(texts(await tailEvents(torn))).toEqual(['message 1', 'message 2']);
    const unterminated = fx.write(jsonl(numbered(2)) + JSON.stringify(prompt('message 3')));
    expect(texts(await tailEvents(unterminated))).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('reads CRLF line endings', async () => {
    expect(texts(await tailEvents(fx.transcript(numbered(3), '\r\n')))).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('grows the window until it holds a conversation record', async () => {
    const file = fx.transcript([...numbered(12), toolResult(`big ${'x'.repeat(600)}`), noise('attachment')]);
    const events = await tailEvents(file, 5, { initialBytes: 64, limitBytes: 4096 });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)).toMatchObject({ who: 'you', kind: 'result' });
    expect(events.at(-1)?.text.startsWith('big xxx')).toBe(true);
  });

  it('returns nothing when no conversation record fits within the limit', async () => {
    const file = fx.transcript([...numbered(12), toolResult('x'.repeat(600))]);
    expect(await tailEvents(file, 5, { initialBytes: 64, limitBytes: 256 })).toEqual([]);
  });

  it('returns nothing for a transcript without conversation records', async () => {
    expect(await tailEvents(fx.write(''))).toEqual([]);
    expect(await tailEvents(fx.transcript(NOISE_TYPES.map(noise)))).toEqual([]);
  });

  it('never rejects: a missing or unreadable transcript is an empty preview', async () => {
    expect(await tailEvents(path.join(fx.dir, 'never-written.jsonl'))).toEqual([]);
    expect(await tailEvents(fx.dir)).toEqual([]);
    expect(await tailEvents(path.join(fx.dir, 'bad\0name.jsonl'))).toEqual([]);
    vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('EACCES: permission denied'));
    expect(await tailEvents(fx.transcript(numbered(2)))).toEqual([]);
  });

  it('closes the file it read', async () => {
    const file = fx.transcript(numbered(2));
    const open = vi.spyOn(fs.promises, 'open');
    await tailEvents(file);
    const handle = (await open.mock.results[0]?.value) as fs.promises.FileHandle;
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('treats an unusable count safely', async () => {
    const file = fx.transcript(numbered(50));
    expect(await tailEvents(file, 0)).toEqual([]);
    expect(await tailEvents(file, -3)).toEqual([]);
    expect(await tailEvents(file, 0.9)).toEqual([]);
    expect(await tailEvents(file, 2.9)).toHaveLength(2);
    expect(await tailEvents(file, NaN)).toHaveLength(40);
    expect(await tailEvents(file, Infinity)).toHaveLength(40);
  });
});
