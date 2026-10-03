// The output channel, made safe to call from anywhere. Logging happens inside error handlers and
// while the window is closing, when the channel may already be gone; a log line that cannot be
// written must never turn into a second failure.

import type * as vscode from 'vscode';

export interface Log {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Bring the channel on screen without taking the focus. */
  show(): void;
}

function attempt(write: () => void): void {
  try {
    write();
  } catch {
    // the channel is closed; there is nowhere left to say so
  }
}

export function createLog(channel: vscode.LogOutputChannel): Log {
  return {
    debug: (message) => attempt(() => channel.debug(message)),
    info: (message) => attempt(() => channel.info(message)),
    warn: (message) => attempt(() => channel.warn(message)),
    error: (message) => attempt(() => channel.error(message)),
    show: () => attempt(() => channel.show(true)),
  };
}
