// In-memory stand-ins for net.Socket / net.Server, for the tests that drive time by hand: real
// pipes and fake timers do not mix.

import { EventEmitter } from 'node:events';
import type * as net from 'node:net';

export class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly written: string[] = [];

  write(data: string, callback?: () => void): boolean {
    this.written.push(data);
    callback?.();
    return true;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  /** The other end sends one message. */
  receive(message: unknown): void {
    this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  }

  /** Everything written to the other end, parsed. */
  sent(): Record<string, unknown>[] {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  sentOf(type: string): Record<string, unknown>[] {
    return this.sent().filter((message) => message.t === type);
  }

  asSocket(): net.Socket {
    return this as unknown as net.Socket;
  }
}

export class FakeServer extends EventEmitter {
  listening = true;

  close(): this {
    if (!this.listening) return this;
    this.listening = false;
    this.emit('close');
    return this;
  }

  /** A window connects. */
  connect(): FakeSocket {
    const socket = new FakeSocket();
    this.emit('connection', socket);
    return socket;
  }

  asServer(): net.Server {
    return this as unknown as net.Server;
  }
}
