import { EventEmitter } from 'node:events';
import type * as net from 'node:net';

import { describe, expect, it } from 'vitest';

import { encodeLine, LineDecoder, MAX_LINE_BYTES, readObjects } from '../../src/coordination/framing';
import { makeState } from './harness';

describe('LineDecoder', () => {
  it('returns each complete line and keeps the unfinished rest', () => {
    const decoder = new LineDecoder();

    expect(decoder.feed(Buffer.from('{"a":1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(decoder.feed(Buffer.from(':3}'))).toEqual([]);
    expect(decoder.feed(Buffer.from('\n'))).toEqual(['{"c":3}']);
  });

  it('puts a multi-byte character back together when it straddles two chunks', () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.from('{"name":"zażółć 🚀"}\n', 'utf8');
    const lines: string[] = [];

    for (const byte of bytes) lines.push(...(decoder.feed(Buffer.from([byte])) ?? ['overflow']));

    expect(lines).toEqual(['{"name":"zażółć 🚀"}']);
  });

  it('accepts a line of exactly the maximum size', () => {
    const decoder = new LineDecoder();
    const line = 'x'.repeat(MAX_LINE_BYTES);

    expect(decoder.feed(Buffer.from(`${line}\n`))).toEqual([line]);
  });

  it('gives up on a line that is one byte too long, whether or not its end has arrived', () => {
    const tooLong = Buffer.alloc(MAX_LINE_BYTES + 1, 0x78);

    expect(new LineDecoder().feed(tooLong)).toBeNull();
    expect(new LineDecoder().feed(Buffer.concat([tooLong, Buffer.from('\n')]))).toBeNull();
  });

  it('gives up when small chunks add up to more than the maximum', () => {
    const decoder = new LineDecoder();
    const chunk = Buffer.alloc(64 * 1024, 0x78);

    expect([1, 2, 3, 4].map(() => decoder.feed(chunk))).toEqual([[], [], [], []]);
    expect(decoder.feed(Buffer.from('x'))).toBeNull();
  });

  it('counts each line on its own', () => {
    const decoder = new LineDecoder();
    const line = 'x'.repeat(MAX_LINE_BYTES - 10);

    expect(decoder.feed(Buffer.from(`${line}\n${line}\n`))).toEqual([line, line]);
  });
});

describe('encodeLine', () => {
  it('writes one line of JSON, with line breaks inside strings escaped', () => {
    const line = encodeLine({ t: 'ack', id: 'a\nb', ok: false, error: 'first\nsecond' });

    expect(line).toBe('{"t":"ack","id":"a\\nb","ok":false,"error":"first\\nsecond"}\n');
  });

  it('refuses a message that would not fit in one line', () => {
    expect(encodeLine({ t: 'state', state: makeState({ logFile: 'x'.repeat(MAX_LINE_BYTES) }) })).toBeNull();
    expect(encodeLine({ t: 'state', state: makeState() })).not.toBeNull();
  });

  it('measures the limit in bytes, not characters', () => {
    const halfInCharacters = 'ż'.repeat(MAX_LINE_BYTES / 2);

    expect(encodeLine({ t: 'state', state: makeState({ logFile: halfInCharacters }) })).toBeNull();
  });

  it('refuses a message that cannot be serialised', () => {
    const circular = makeState();
    (circular as unknown as { self: unknown }).self = circular;

    expect(encodeLine({ t: 'state', state: circular })).toBeNull();
  });
});

describe('readObjects', () => {
  function reading() {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const objects: unknown[] = [];
    const violations: string[] = [];
    readObjects(
      socket as unknown as net.Socket,
      (value) => objects.push(value),
      (reason) => violations.push(reason),
    );
    const feed = (text: string): boolean => socket.emit('data', Buffer.from(text));
    return { socket, objects, violations, feed };
  }

  it('hands over every JSON object', () => {
    const { objects, violations, feed } = reading();

    feed('{"t":"a"}\n{"t":"b","n":[1,2]}\n');

    expect(objects).toEqual([{ t: 'a' }, { t: 'b', n: [1, 2] }]);
    expect(violations).toEqual([]);
  });

  it.each([
    ['text that is not JSON', 'hello\n'],
    ['an empty line', '\n'],
    ['a JSON array', '[1]\n'],
    ['a JSON string', '"hello"\n'],
    ['JSON null', 'null\n'],
    ['a JSON number', '42\n'],
  ])('reports %s as a violation, once, and reads nothing after it', (_name, bad) => {
    const { objects, violations, feed } = reading();

    feed(`{"t":"before"}\n${bad}{"t":"after"}\n`);
    feed('{"t":"later"}\n');

    expect(objects).toEqual([{ t: 'before' }]);
    expect(violations).toHaveLength(1);
  });

  it('reports a line that is too long', () => {
    const { violations, feed } = reading();

    feed('x'.repeat(MAX_LINE_BYTES + 1));

    expect(violations).toEqual(['a line longer than 256 KB']);
  });

  it('stops in the middle of a chunk when the handler destroyed the socket', () => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const objects: unknown[] = [];
    readObjects(
      socket as unknown as net.Socket,
      (value) => {
        objects.push(value);
        socket.destroyed = true;
      },
      () => undefined,
    );

    socket.emit('data', Buffer.from('{"n":1}\n{"n":2}\n'));

    expect(objects).toEqual([{ n: 1 }]);
  });
});
