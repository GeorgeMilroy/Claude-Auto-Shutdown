import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { readTurn } from '../../src/core/transcript';
import type { TurnInfo, TurnReason, TurnState } from '../../src/core/types';
import {
  NOISE_TYPES,
  assistant,
  byteLength,
  createFixtureDir,
  jsonl,
  noise,
  prompt,
  textBlock,
  toolResult,
  toolUse,
  wakeupCall,
  type FixtureDir,
} from './fixtures';

function turn(state: TurnState, reason: TurnReason, detail: string | null = null, wakeup: number | null = null): TurnInfo {
  return { state, reason, detail, scheduledWakeupSeconds: wakeup };
}

const CLOSED = turn('CLOSED', 'turnEnded');
const BEING_WRITTEN = turn('OPEN', 'recordBeingWritten');
const NO_RECORD = turn('UNKNOWN', 'noConversationRecord');

/** A stand-in for a FileHandle over fixed bytes, for failures a real file cannot produce on demand. */
function fakeHandle(content: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    stat: async () => ({ size: content.length, isFile: () => true }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: content.copy(buffer, offset, position, position + length),
      buffer,
    }),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function openReturns(handle: unknown): void {
  vi.spyOn(fs.promises, 'open').mockResolvedValue(handle as fs.promises.FileHandle);
}

/** Shaped like the errors Node's fs raises: "<CODE>: <text>, <syscall> '<path>'". */
function systemError(code: string, syscall: string, message: string): Error {
  return Object.assign(new Error(message), { code, syscall });
}

let fx: FixtureDir;

beforeAll(() => {
  fx = createFixtureDir();
});

afterAll(() => {
  fx.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readTurn: the last conversation record decides', () => {
  const cases: [string, unknown, TurnInfo][] = [
    ['assistant end_turn', assistant('end_turn'), CLOSED],
    ['assistant stop_sequence', assistant('stop_sequence'), CLOSED],
    ['assistant tool_use', assistant('tool_use', [toolUse('Bash', { command: 'npm test' })]), turn('OPEN', 'toolInFlight')],
    ['assistant max_tokens', assistant('max_tokens'), turn('OPEN', 'cutAtTokenLimit')],
    ['assistant without stop_reason', assistant(null), turn('OPEN', 'replyInProgress')],
    ['assistant with an unknown stop_reason', assistant('pause_turn'), turn('OPEN', 'replyInProgress', 'pause_turn')],
    ['user tool_result', toolResult('exit code 0'), turn('OPEN', 'readingToolResult')],
    ['user prompt', prompt('and now the tests'), turn('OPEN', 'thinking')],
  ];

  it.each(cases)('%s', async (_name, last, expected) => {
    const file = fx.transcript([prompt('go'), assistant('end_turn'), last]);
    expect(await readTurn(file)).toEqual(expected);
  });

  it('a prompt after a finished turn re-opens it', async () => {
    const file = fx.transcript([prompt('one'), assistant('end_turn'), prompt('two')]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'thinking'));
  });

  it('reads a transcript that is a single record', async () => {
    expect(await readTurn(fx.transcript([assistant('end_turn')]))).toEqual(CLOSED);
  });
});

describe('readTurn: subagent records inside the main transcript', () => {
  const MAIN = { mainThread: true };
  const side = { isSidechain: true };
  const twoAgents = [
    prompt('review both modules'),
    assistant('tool_use', [toolUse('Task', { description: 'review a' }), toolUse('Task', { description: 'review b' })]),
    prompt('review module a', side),
    assistant('end_turn', [textBlock('a looks fine')], side),
  ];

  it('one subagent finishing does not close the main turn', async () => {
    const file = fx.transcript(twoAgents);
    expect(await readTurn(file, MAIN)).toEqual(turn('OPEN', 'thinking'));
  });

  it('the main thread closes it', async () => {
    const file = fx.transcript([...twoAgents, toolResult('a and b reviewed'), assistant('end_turn')]);
    expect(await readTurn(file, MAIN)).toEqual(CLOSED);
  });

  it('a subagent still opens it', async () => {
    const file = fx.transcript([prompt('go'), assistant('end_turn'), assistant('tool_use', [toolUse('Bash', {})], side)]);
    expect(await readTurn(file, MAIN)).toEqual(turn('OPEN', 'toolInFlight'));
  });

  it('only a closing record of the main thread counts, whatever value marks a subagent', async () => {
    for (const isSidechain of [true, 1, 'yes']) {
      const file = fx.transcript([prompt('go'), assistant('end_turn', [textBlock('done')], { isSidechain })]);
      expect(await readTurn(file, MAIN), String(isSidechain)).toEqual(turn('OPEN', 'thinking'));
    }
    const marked = fx.transcript([prompt('go'), assistant('end_turn', [textBlock('done')], { isSidechain: false })]);
    expect(await readTurn(marked, MAIN)).toEqual(CLOSED);
  });

  it("a subagent's own transcript is all sidechain and still closes", async () => {
    const file = fx.transcript([prompt('review module a', side), assistant('end_turn', [textBlock('fine')], side)]);
    expect(await readTurn(file)).toEqual(CLOSED);
    expect(await readTurn(file, { mainThread: false })).toEqual(CLOSED);
  });

  it("looks for the main thread's wake-up past a subagent's prompt", async () => {
    const records = [
      prompt('/loop check the deploy'),
      wakeupCall({ delaySeconds: 600 }),
      toolResult('Wake-up scheduled.'),
      assistant('tool_use', [toolUse('Task', { description: 'check' })]),
      prompt('check the deploy', side),
      assistant('end_turn', [textBlock('green')], side),
      toolResult('green'),
      assistant('end_turn'),
    ];
    expect(await readTurn(fx.transcript(records), MAIN)).toEqual(turn('CLOSED', 'turnEnded', null, 600));
  });
});

describe('readTurn: noise records are skipped', () => {
  const trailingNoise = NOISE_TYPES.map(noise);

  it('keeps an open turn open however much noise follows it', async () => {
    const file = fx.transcript([prompt('go'), assistant('tool_use'), ...trailingNoise]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'toolInFlight'));
  });

  it('keeps a closed turn closed however much noise follows it', async () => {
    const file = fx.transcript([prompt('go'), assistant('end_turn'), ...trailingNoise]);
    expect(await readTurn(file)).toEqual(CLOSED);
  });

  it('takes the newest conversation record, not the newest closed one', async () => {
    const file = fx.transcript([assistant('end_turn'), noise('attachment'), toolResult(), noise('frame-link')]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'readingToolResult'));
  });

  it('skips records without a usable type', async () => {
    const file = fx.transcript([assistant('tool_use'), {}, { type: 7 }, { type: null }, { type: ['user'] }]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'toolInFlight'));
  });
});

describe('readTurn: isCompactSummary wins', () => {
  it('over the finished turn before it', async () => {
    const file = fx.transcript([
      prompt('go'),
      assistant('end_turn'),
      { type: 'system', subtype: 'compact_boundary' },
      prompt('This session is being continued from a previous conversation.', { isCompactSummary: true }),
    ]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'compacting'));
  });

  it('on a record that would otherwise close the turn', async () => {
    const file = fx.transcript([prompt('go'), assistant('end_turn', [textBlock('done')], { isCompactSummary: true })]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'compacting'));
  });

  it('on a record type that is otherwise noise', async () => {
    const file = fx.transcript([assistant('end_turn'), { type: 'summary', isCompactSummary: true }, noise('attachment')]);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'compacting'));
  });
});

describe('readTurn: files that cannot be read', () => {
  it('missing file -> UNKNOWN noTranscript', async () => {
    expect(await readTurn(path.join(fx.dir, 'never-written.jsonl'))).toEqual(turn('UNKNOWN', 'noTranscript'));
    expect(await readTurn(path.join(fx.dir, 'no-such-dir', 'x.jsonl'))).toEqual(turn('UNKNOWN', 'noTranscript'));
    expect(await readTurn('')).toEqual(turn('UNKNOWN', 'noTranscript'));
  });

  it('a directory in place of the file -> UNKNOWN cannotRead', async () => {
    const info = await readTurn(fx.dir);
    expect(info).toMatchObject({ state: 'UNKNOWN', reason: 'cannotRead', scheduledWakeupSeconds: null });
    expect(info.detail).toEqual(expect.stringMatching(/\S/));
  });

  it('a path Node rejects outright -> UNKNOWN cannotRead, not a rejection', async () => {
    const info = await readTurn(path.join(fx.dir, 'bad\0name.jsonl'));
    expect(info).toMatchObject({ state: 'UNKNOWN', reason: 'cannotRead' });
    expect(info.detail).toMatch(/null bytes/);
    expect(info.detail?.length).toBeLessThanOrEqual(120);
  });

  it('a path that is not even a string -> UNKNOWN cannotRead, not a rejection', async () => {
    for (const bad of [null, undefined, 42, {}]) {
      await expect(readTurn(bad as unknown as string)).resolves.toMatchObject({ state: 'UNKNOWN', reason: 'cannotRead' });
    }
  });

  it('permission denied -> UNKNOWN cannotRead with the OS error, without the path', async () => {
    vi.spyOn(fs.promises, 'open').mockRejectedValue(
      systemError('EACCES', 'open', "EACCES: permission denied, open 'C:\\Users\\someone\\.claude\\projects\\p\\s.jsonl'"),
    );
    expect(await readTurn('locked.jsonl')).toEqual(turn('UNKNOWN', 'cannotRead', 'EACCES: permission denied'));
  });

  it('a missing file is recognised by its error code alone', async () => {
    vi.spyOn(fs.promises, 'open').mockRejectedValue(systemError('ENOENT', 'open', "ENOENT: no such file or directory, open 'x'"));
    expect(await readTurn('x.jsonl')).toEqual(turn('UNKNOWN', 'noTranscript'));
  });

  it('an error without any text still has a detail', async () => {
    vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error(''));
    expect(await readTurn('x.jsonl')).toEqual(turn('UNKNOWN', 'cannotRead', 'unknown error'));
  });

  it('an error that is not an Error still ends as cannotRead', async () => {
    vi.spyOn(fs.promises, 'open').mockRejectedValue('the disk fell out');
    expect(await readTurn('x.jsonl')).toEqual(turn('UNKNOWN', 'cannotRead', 'the disk fell out'));
  });

  it('a failing read -> UNKNOWN cannotRead, and the handle is closed', async () => {
    const handle = fakeHandle(Buffer.from(jsonl([assistant('end_turn')])), {
      read: async () => {
        throw systemError('EIO', 'read', 'EIO: i/o error, read');
      },
    });
    openReturns(handle);
    expect(await readTurn('x.jsonl')).toEqual(turn('UNKNOWN', 'cannotRead', 'EIO: i/o error'));
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('a file that shrank after it was measured -> UNKNOWN cannotRead, never a turn', async () => {
    const handle = fakeHandle(Buffer.from(jsonl([assistant('end_turn')])), {
      read: async (buffer: Buffer) => ({ bytesRead: 0, buffer }),
    });
    openReturns(handle);
    expect(await readTurn('x.jsonl')).toEqual(turn('UNKNOWN', 'cannotRead', 'the file shrank while it was being read'));
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('something that is not a regular file -> UNKNOWN cannotRead', async () => {
    const handle = fakeHandle(Buffer.from(jsonl([assistant('end_turn')])), {
      stat: async () => ({ size: 0, isFile: () => false }),
    });
    openReturns(handle);
    expect(await readTurn('x.jsonl')).toEqual(turn('UNKNOWN', 'cannotRead', 'not a regular file'));
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('closes the handle after a successful read and survives a failing close', async () => {
    const handle = fakeHandle(Buffer.from(jsonl([prompt('go'), assistant('end_turn')])), {
      close: vi.fn(async () => {
        throw systemError('EBADF', 'close', 'EBADF: bad file descriptor, close');
      }),
    });
    openReturns(handle);
    expect(await readTurn('x.jsonl')).toEqual(CLOSED);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('closes a real file after reading it', async () => {
    const file = fx.transcript([prompt('go'), assistant('end_turn')]);
    const open = vi.spyOn(fs.promises, 'open');
    expect(await readTurn(file)).toEqual(CLOSED);
    const handle = (await open.mock.results[0]?.value) as fs.promises.FileHandle;
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('assembles the window from short reads', async () => {
    const content = Buffer.from(jsonl([prompt('go'), assistant('tool_use'), toolResult('x'.repeat(200))]));
    const handle = fakeHandle(content, {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: content.copy(buffer, offset, position, position + Math.min(length, 7)),
        buffer,
      }),
    });
    openReturns(handle);
    expect(await readTurn('x.jsonl')).toEqual(turn('OPEN', 'readingToolResult'));
  });
});

describe('readTurn: no conversation record', () => {
  it('empty file -> UNKNOWN noConversationRecord', async () => {
    expect(await readTurn(fx.write(''))).toEqual(NO_RECORD);
  });

  it('only blank lines -> UNKNOWN noConversationRecord', async () => {
    expect(await readTurn(fx.write('\n\n  \n\r\n'))).toEqual(NO_RECORD);
  });

  it('only noise -> UNKNOWN noConversationRecord', async () => {
    expect(await readTurn(fx.transcript(NOISE_TYPES.map(noise)))).toEqual(NO_RECORD);
  });

  it('a conversation record further back than the limit -> UNKNOWN noConversationRecord', async () => {
    const records = [prompt('go'), assistant('end_turn'), ...Array.from({ length: 20 }, () => noise('attachment'))];
    const file = fx.transcript(records);
    expect(fs.statSync(file).size).toBeGreaterThan(1024);
    expect(await readTurn(file, { initialBytes: 64, limitBytes: 1024 })).toEqual(NO_RECORD);
    expect(await readTurn(file)).toEqual(CLOSED);
  });
});

describe('readTurn: adaptive tail window', () => {
  const small = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? prompt(`step ${i}`) : assistant('end_turn')));

  it('grows until a record larger than the first window fits', async () => {
    const big = toolResult('x'.repeat(600));
    const file = fx.transcript([...small, big]);
    expect(byteLength(JSON.stringify(big))).toBeGreaterThan(256);
    expect(fs.statSync(file).size).toBeGreaterThan(1024);
    expect(await readTurn(file, { initialBytes: 64, limitBytes: 4096 })).toEqual(turn('OPEN', 'readingToolResult'));
  });

  it('finds a large closing record the same way', async () => {
    const file = fx.transcript([...small, prompt('write an essay'), assistant('end_turn', [textBlock('y'.repeat(600))])]);
    expect(await readTurn(file, { initialBytes: 64, limitBytes: 4096 })).toEqual(CLOSED);
  });

  it('gives up at the limit: a record that does not fit is UNKNOWN, not the record before it', async () => {
    const file = fx.transcript([...small, toolResult('x'.repeat(600))]);
    expect(await readTurn(file, { initialBytes: 64, limitBytes: 256 })).toEqual(NO_RECORD);
  });

  it('never reads past the limit, and reads each byte only once', async () => {
    const content = Buffer.from(jsonl([...small, toolResult('x'.repeat(600))]));
    const reads: { position: number; length: number }[] = [];
    openReturns(
      fakeHandle(content, {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads.push({ position, length });
          return { bytesRead: content.copy(buffer, offset, position, position + length), buffer };
        },
      }),
    );
    expect(await readTurn('x.jsonl', { initialBytes: 100, limitBytes: 300 })).toEqual(NO_RECORD);
    // The last 100 bytes, then only the 200 before them: the limit is 300, although 100 x 4 is 400.
    expect(reads).toEqual([
      { position: content.length - 100, length: 100 },
      { position: content.length - 300, length: 200 },
    ]);
  });

  it('drops the first line of a truncated window: a fragment that parses is not a record', async () => {
    const closing = JSON.stringify(assistant('end_turn'));
    // The whole last line is broken JSON; its tail on its own would read as a finished turn.
    const file = fx.write(`${jsonl([prompt('go')])}{"type":"assistant","nested":${closing}\n`);
    expect(await readTurn(file, { initialBytes: byteLength(closing) + 1 })).toEqual(BEING_WRITTEN);
  });

  it('gives the same answer for every window size', async () => {
    const records = [
      prompt('zażółć gęślą jaźń €€€ 😀😀'),
      assistant('tool_use', [toolUse('Bash', { command: 'echo €€€' })]),
      noise('attachment'),
      toolResult('wynik: €€€€€ 😀'),
      noise('frame-link'),
    ];
    const file = fx.transcript(records);
    const size = fs.statSync(file).size;
    for (let initialBytes = 1; initialBytes <= size + 2; initialBytes++) {
      expect(await readTurn(file, { initialBytes }), `initialBytes ${initialBytes}`).toEqual(
        turn('OPEN', 'readingToolResult'),
      );
    }
  });

  it('finds a finished turn at every window size, and never invents one', async () => {
    const turnRecords = [
      prompt('zażółć gęślą jaźń €€€ 😀😀'),
      assistant('tool_use', [toolUse('Bash', { command: 'echo €€€' })]),
      toolResult('wynik: €€€€€ 😀'),
      assistant('end_turn', [textBlock('gotowe €')]),
      noise('attachment'),
    ];
    const finished = fx.transcript(turnRecords);
    const reopened = fx.transcript([...turnRecords, prompt('jeszcze jedno €')]);
    const size = fs.statSync(reopened).size;
    for (let initialBytes = 1; initialBytes <= size + 2; initialBytes++) {
      expect(await readTurn(finished, { initialBytes }), `finished, initialBytes ${initialBytes}`).toEqual(CLOSED);
      expect(await readTurn(reopened, { initialBytes }), `reopened, initialBytes ${initialBytes}`).toEqual(
        turn('OPEN', 'thinking'),
      );
    }
  });

  it('falls back to the defaults for unusable options', async () => {
    const file = fx.transcript([prompt('go'), assistant('end_turn')]);
    for (const bad of [0, -1, NaN, Infinity, 0.5, '64' as unknown as number, null as unknown as number]) {
      expect(await readTurn(file, { initialBytes: bad, limitBytes: bad })).toEqual(CLOSED);
    }
  });

  it('treats a limit below the first window as no growth at all', async () => {
    const file = fx.transcript([...small, toolResult('x'.repeat(600))]);
    expect(await readTurn(file, { initialBytes: 128, limitBytes: 1 })).toEqual(NO_RECORD);
  });
});

describe('readTurn: a record that is still being written', () => {
  const finished = jsonl([prompt('go'), assistant('end_turn')]);

  it('complete JSON without a final newline -> OPEN recordBeingWritten', async () => {
    const file = fx.write(finished + JSON.stringify(prompt('next')));
    expect(await readTurn(file)).toEqual(BEING_WRITTEN);
  });

  it('a closing record without its newline is not CLOSED yet', async () => {
    const file = fx.write(jsonl([prompt('go')]) + JSON.stringify(assistant('end_turn')));
    expect(await readTurn(file)).toEqual(BEING_WRITTEN);
  });

  it('a torn last line without a newline -> OPEN recordBeingWritten', async () => {
    const file = fx.write(`${finished}{"type":"user","message":{"role":"user","content":"ne`);
    expect(await readTurn(file)).toEqual(BEING_WRITTEN);
  });

  it('a torn last line WITH a newline -> OPEN recordBeingWritten', async () => {
    const file = fx.write(`${finished}{"type":"user","message":{"role":"us\n`);
    expect(await readTurn(file)).toEqual(BEING_WRITTEN);
  });

  it('a torn last line followed by blank lines -> OPEN recordBeingWritten', async () => {
    const file = fx.write(`${finished}{"type":"assist\n\n   \n`);
    expect(await readTurn(file)).toEqual(BEING_WRITTEN);
  });

  it('trailing whitespace without a newline -> OPEN recordBeingWritten', async () => {
    expect(await readTurn(fx.write(`${finished}  `))).toEqual(BEING_WRITTEN);
  });

  it('a single unterminated byte is a record being written, not an empty file', async () => {
    expect(await readTurn(fx.write('{'))).toEqual(BEING_WRITTEN);
  });

  it('a torn line that is NOT the last one is skipped', async () => {
    const file = fx.write(`${jsonl([prompt('go')])}{"type":"assistant","mess\n${jsonl([assistant('end_turn')])}`);
    expect(await readTurn(file)).toEqual(CLOSED);
  });

  it('a torn line under trailing noise is skipped too', async () => {
    const file = fx.write(`${jsonl([assistant('tool_use')])}{"type":"user","mess\n${jsonl([noise('attachment')])}`);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'toolInFlight'));
  });

  it('an unterminated record larger than every window is still OPEN', async () => {
    const file = fx.write(finished + JSON.stringify(toolResult('x'.repeat(2000))));
    expect(await readTurn(file, { initialBytes: 64, limitBytes: 256 })).toEqual(BEING_WRITTEN);
  });
});

describe('readTurn: line endings and encoding', () => {
  it('reads CRLF line endings', async () => {
    expect(await readTurn(fx.transcript([prompt('go'), assistant('end_turn')], '\r\n'))).toEqual(CLOSED);
    expect(await readTurn(fx.transcript([prompt('go'), assistant('tool_use')], '\r\n'))).toEqual(
      turn('OPEN', 'toolInFlight'),
    );
  });

  it('reads CRLF with blank lines in between', async () => {
    const file = fx.write(`${jsonl([prompt('go')], '\r\n')}\r\n\r\n${jsonl([assistant('end_turn')], '\r\n')}\r\n`);
    expect(await readTurn(file)).toEqual(CLOSED);
  });

  it('a file ending in a bare CR is still being written', async () => {
    expect(await readTurn(fx.write(`${jsonl([prompt('go')])}${JSON.stringify(assistant('end_turn'))}\r`))).toEqual(
      BEING_WRITTEN,
    );
  });

  it('reads a file that starts with a UTF-8 byte order mark', async () => {
    const file = fx.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(jsonl([assistant('end_turn')]))]));
    expect(await readTurn(file)).toEqual(CLOSED);
  });

  it('survives bytes that are not valid UTF-8', async () => {
    const broken = Buffer.concat([
      Buffer.from('{"type":"user","message":{"content":"'),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('"}}\n'),
    ]);
    const file = fx.write(Buffer.concat([Buffer.from(jsonl([assistant('end_turn')])), broken]));
    expect(await readTurn(file)).toEqual(turn('OPEN', 'thinking'));
  });
});

describe('readTurn: JSON lines that are not records', () => {
  const notRecords = ['123', '-0.5', '[1,2,3]', '[]', 'null', 'true', '"assistant"', '{}', '[{"type":"assistant"}]'];

  it('are skipped wherever they are, and never throw', async () => {
    const lines = `${notRecords.join('\n')}\n`;
    const file = fx.write(lines + jsonl([prompt('go'), assistant('tool_use')]) + lines);
    expect(await readTurn(file)).toEqual(turn('OPEN', 'toolInFlight'));
  });

  it.each(notRecords)('a file that ends in %s is decided by the record before it', async (line) => {
    const file = fx.write(`${jsonl([prompt('go'), assistant('end_turn')])}${line}\n`);
    expect(await readTurn(file)).toEqual(CLOSED);
  });

  it('a file of nothing else -> UNKNOWN noConversationRecord', async () => {
    expect(await readTurn(fx.write(`${notRecords.join('\n')}\n`))).toEqual(NO_RECORD);
  });
});

describe('readTurn: scheduled wake-up hint', () => {
  const loopTurn = (input: unknown) => [
    prompt('/loop check the deploy'),
    wakeupCall(input),
    toolResult('Wake-up scheduled.'),
    assistant('end_turn', [textBlock('Sleeping until the next check.')]),
  ];
  const wakeupOf = async (records: readonly unknown[]) => (await readTurn(fx.transcript(records))).scheduledWakeupSeconds;

  it('reports the delay of a ScheduleWakeup call in the final turn', async () => {
    const file = fx.transcript(loopTurn({ delaySeconds: 1200, reason: 'next check', prompt: '/loop check the deploy' }));
    expect(await readTurn(file)).toEqual(turn('CLOSED', 'turnEnded', null, 1200));
  });

  it('finds a call made in the closing record itself', async () => {
    const closing = assistant('end_turn', [textBlock('See you later.'), toolUse('ScheduleWakeup', { delaySeconds: 90 })]);
    expect(await wakeupOf([prompt('go'), closing])).toBe(90);
  });

  it('looks past tool results, noise and broken lines inside the turn', async () => {
    const file = fx.write(
      jsonl([prompt('go'), wakeupCall({ delaySeconds: 600 }), toolResult('ok'), noise('attachment')]) +
        '{"type":"assistant","torn\n' +
        '[1,2,3]\n' +
        jsonl([assistant('tool_use', [toolUse('Bash', { command: 'date' })]), toolResult('Sat'), assistant('end_turn')]),
    );
    expect(await readTurn(file)).toEqual(turn('CLOSED', 'turnEnded', null, 600));
  });

  it('{stop: true} schedules nothing', async () => {
    expect(await wakeupOf(loopTurn({ stop: true }))).toBeNull();
    expect(await wakeupOf(loopTurn({ stop: true, delaySeconds: 600 }))).toBeNull();
  });

  it('only a real boolean true is a stop (anything else still blocks)', async () => {
    expect(await wakeupOf(loopTurn({ stop: 'true', delaySeconds: 600 }))).toBe(600);
    expect(await wakeupOf(loopTurn({ stop: false, delaySeconds: 600 }))).toBe(600);
  });

  it('a delay that is not a finite number gives no hint', async () => {
    for (const delaySeconds of [null, '600', true, [600], { seconds: 600 }]) {
      expect(await wakeupOf(loopTurn({ delaySeconds }))).toBeNull();
    }
    expect(await wakeupOf(loopTurn({}))).toBeNull();
    expect(await wakeupOf(loopTurn({ reason: 'no delay given' }))).toBeNull();
    for (const input of [null, 'soon', 600, [600], undefined]) {
      expect(await wakeupOf(loopTurn(input))).toBeNull();
    }
  });

  it('a delay that overflows to Infinity gives no hint', async () => {
    const call =
      '{"type":"assistant","message":{"stop_reason":"tool_use","content":' +
      '[{"type":"tool_use","name":"ScheduleWakeup","input":{"delaySeconds":1e999}}]}}\n';
    const file = fx.write(jsonl([prompt('go')]) + call + jsonl([toolResult('ok'), assistant('end_turn')]));
    expect(await readTurn(file)).toEqual(CLOSED);
  });

  it('clamps the delay to 0..86400 and keeps 0 as a real value', async () => {
    expect(await wakeupOf(loopTurn({ delaySeconds: -5 }))).toBe(0);
    expect(await wakeupOf(loopTurn({ delaySeconds: 0 }))).toBe(0);
    expect(await wakeupOf(loopTurn({ delaySeconds: 90.5 }))).toBe(90.5);
    expect(await wakeupOf(loopTurn({ delaySeconds: 86_400 }))).toBe(86_400);
    expect(await wakeupOf(loopTurn({ delaySeconds: 1e12 }))).toBe(86_400);
  });

  it("does not leak an earlier turn's wake-up into a later turn", async () => {
    const records = [...loopTurn({ delaySeconds: 600 }), prompt('stop looping, just tell me the status'), assistant('end_turn')];
    expect(await readTurn(fx.transcript(records))).toEqual(CLOSED);
  });

  it('a compact summary is a turn boundary as well', async () => {
    const records = [
      ...loopTurn({ delaySeconds: 600 }),
      prompt('Summary of the conversation so far.', { isCompactSummary: true }),
      assistant('end_turn'),
    ];
    expect(await readTurn(fx.transcript(records))).toEqual(CLOSED);
  });

  it('takes the LAST call of the turn', async () => {
    const twoRecords = [
      prompt('go'),
      wakeupCall({ delaySeconds: 60 }),
      toolResult('ok'),
      wakeupCall({ delaySeconds: 1800 }),
      toolResult('ok'),
      assistant('end_turn'),
    ];
    expect(await wakeupOf(twoRecords)).toBe(1800);
    const oneRecord = assistant('tool_use', [
      toolUse('ScheduleWakeup', { delaySeconds: 60 }),
      toolUse('ScheduleWakeup', { delaySeconds: 300 }),
    ]);
    expect(await wakeupOf([prompt('go'), oneRecord, toolResult('ok'), assistant('end_turn')])).toBe(300);
  });

  it('errs towards keeping the PC on: a later stop or unreadable call does not erase an earlier real one', async () => {
    const stopAfter = [
      prompt('go'),
      wakeupCall({ delaySeconds: 600 }),
      toolResult('ok'),
      wakeupCall({ stop: true }),
      toolResult('ok'),
      assistant('end_turn'),
    ];
    expect(await wakeupOf(stopAfter)).toBe(600);
    const unreadableAfter = [
      prompt('go'),
      wakeupCall({ delaySeconds: 600 }),
      toolResult('ok'),
      wakeupCall({ delaySeconds: 'soon' }),
      toolResult('ok'),
      assistant('end_turn'),
    ];
    expect(await wakeupOf(unreadableAfter)).toBe(600);
  });

  it('ignores other tools and other spellings of the name', async () => {
    for (const name of ['Bash', 'schedulewakeup', 'ScheduleWakeup ', 'CronCreate']) {
      const records = [
        prompt('go'),
        assistant('tool_use', [toolUse(name, { delaySeconds: 600 })]),
        toolResult('ok'),
        assistant('end_turn'),
      ];
      expect(await wakeupOf(records)).toBeNull();
    }
  });

  it('ignores a call that is not a tool_use block of an assistant record', async () => {
    const quoted = { type: 'text', name: 'ScheduleWakeup', input: { delaySeconds: 600 } };
    expect(await wakeupOf([prompt('go'), assistant(null, [quoted]), assistant('end_turn')])).toBeNull();
    const inNoise = { type: 'attachment', message: { content: [toolUse('ScheduleWakeup', { delaySeconds: 600 })] } };
    expect(await wakeupOf([prompt('go'), inNoise, assistant('end_turn')])).toBeNull();
    const malformed = assistant(null, [null, 5, 'ScheduleWakeup', [toolUse('ScheduleWakeup', { delaySeconds: 600 })]]);
    expect(await wakeupOf([prompt('go'), malformed, assistant('end_turn')])).toBeNull();
  });

  it('is never set on a turn that is not CLOSED', async () => {
    const pending = fx.transcript([prompt('go'), wakeupCall({ delaySeconds: 600 })]);
    expect(await readTurn(pending)).toEqual(turn('OPEN', 'toolInFlight'));
    const answered = fx.transcript([prompt('go'), wakeupCall({ delaySeconds: 600 }), toolResult('ok')]);
    expect(await readTurn(answered)).toEqual(turn('OPEN', 'readingToolResult'));
  });

  it('only looks inside the window that held the closing record', async () => {
    const closing = assistant('end_turn');
    const records = [prompt('go'), wakeupCall({ delaySeconds: 600 }), toolResult('x'.repeat(300)), closing];
    const file = fx.transcript(records);
    const justTheClosingRecord = byteLength(JSON.stringify(closing)) + 20;
    expect(await readTurn(file, { initialBytes: justTheClosingRecord })).toEqual(CLOSED);
    expect(await readTurn(file)).toEqual(turn('CLOSED', 'turnEnded', null, 600));
  });
});
