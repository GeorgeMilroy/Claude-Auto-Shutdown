// Wire framing: UTF-8 JSON, one object per line, at most 256 KB per line.
//
// A peer that sends something that is not a JSON object, or a line that never ends, is not
// speaking this protocol at all: the reader reports a violation and the owner destroys that one
// socket. What the object MEANS is checked separately (wire.ts); an object this version does not
// understand is ignored, never fatal.

import type * as net from 'node:net';

import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { ProvenHello, ProvenWelcome } from './auth';

export const MAX_LINE_BYTES = 256 * 1024;

export type OutgoingMessage = ClientMessage | ServerMessage | ProvenHello | ProvenWelcome;

const NEWLINE = 0x0a;

/** Splits a byte stream into lines. Works on bytes so a multi-byte character can straddle chunks. */
export class LineDecoder {
  private partial: Buffer[] = [];
  private partialBytes = 0;

  /** Complete lines found so far, or null once a line exceeds MAX_LINE_BYTES. */
  feed(chunk: Buffer): string[] | null {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) break;
      if (this.partialBytes + (end - start) > MAX_LINE_BYTES) return null;
      lines.push(this.completeLine(chunk.subarray(start, end)));
      start = end + 1;
    }
    const rest = chunk.subarray(start);
    if (this.partialBytes + rest.length > MAX_LINE_BYTES) return null;
    if (rest.length > 0) {
      this.partial.push(rest);
      this.partialBytes += rest.length;
    }
    return lines;
  }

  private completeLine(tail: Buffer): string {
    const line = this.partial.length === 0 ? tail : Buffer.concat([...this.partial, tail]);
    this.partial = [];
    this.partialBytes = 0;
    return line.toString('utf8');
  }
}

/** One line for the wire, or null when the message cannot be sent (too large, not serialisable). */
export function encodeLine(message: OutgoingMessage): string | null {
  let text: string;
  try {
    text = JSON.stringify(message);
  } catch {
    return null;
  }
  return Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES ? null : `${text}\n`;
}

export type WireObject = Record<string, unknown>;

export function isWireObject(value: unknown): value is WireObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Feeds every JSON object arriving on `socket` to `onObject`. Calls `onViolation` once and stops
 * reading when the peer breaks the framing; the owner is expected to destroy the socket.
 */
export function readObjects(
  socket: net.Socket,
  onObject: (value: WireObject) => void,
  onViolation: (reason: string) => void,
): void {
  const decoder = new LineDecoder();
  let stopped = false;
  const stop = (reason: string): void => {
    stopped = true;
    onViolation(reason);
  };

  socket.on('data', (chunk: Buffer) => {
    if (stopped) return;
    const lines = decoder.feed(chunk);
    if (lines === null) {
      stop(`a line longer than ${MAX_LINE_BYTES / 1024} KB`);
      return;
    }
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        stop('a line that is not JSON');
        return;
      }
      if (!isWireObject(value)) {
        stop('a line that is not a JSON object');
        return;
      }
      onObject(value);
      // The handler may have destroyed the socket: the rest of this chunk is void then.
      if (stopped || socket.destroyed) return;
    }
  });
}
