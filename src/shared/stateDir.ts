// The one per-user folder shared by every window of every editor: the Emergency stop file, the
// activity log, the last-run records and (on Linux / macOS) the leader socket.
//
// It is deliberately NOT derived from the extension's globalStorage: VS Code, Insiders and Cursor
// must agree on one brake and one leader. The override is honoured only outside production, so two
// windows started from different shells can never end up with two state dirs (= two leaders and a
// STOP file the armed one never looks at).

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const STATE_DIR_NAME = '.claude-auto-shutdown';
const STOP_NAMES = new Set(['stop', 'stop.txt']);
/** Marker written into a STOP file this extension created by itself (see createAutoStop). */
const AUTO_STOP_PREFIX = 'auto:';

export interface StateDirOptions {
  /** ExtensionMode.Production? Overrides via environment are ignored when true. */
  production: boolean;
  env?: NodeJS.ProcessEnv;
}

export function resolveStateDir(options: StateDirOptions): string {
  const env = options.env ?? process.env;
  const override = options.production ? undefined : env.CLAUDE_AUTOSHUTDOWN_HOME;
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), STATE_DIR_NAME);
}

/**
 * Name of the leadership endpoint. Derived from the OS user, never from the state dir or the
 * extension version, so every window on the machine contends for the same one.
 */
export function resolveEndpoint(options: StateDirOptions & { stateDir: string }): string {
  const env = options.env ?? process.env;
  const override = options.production ? undefined : env.CLAUDE_AUTOSHUTDOWN_ENDPOINT;
  if (override && override.trim()) return override;
  if (process.platform === 'win32') {
    const user = (os.userInfo().username || 'user').toLowerCase();
    const hash = createHash('sha256').update(user).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\claude-auto-shutdown-${hash}`;
  }
  return path.join(options.stateDir, 'leader.sock');
}

export interface StopStatus {
  /** Emergency stop is set. An unreadable folder counts as set. */
  present: boolean;
  /** The file was created by this extension because a Cancel could not be delivered. */
  auto: boolean;
  /** Full path of the file that was found, else null. */
  file: string | null;
}

export class StateDir {
  readonly dir: string;
  readonly logFile: string;
  readonly lastRunFile: string;
  readonly watchRecordFile: string;

  constructor(dir: string) {
    this.dir = dir;
    this.logFile = path.join(dir, 'activity.log');
    this.lastRunFile = path.join(dir, 'last-run.json');
    this.watchRecordFile = path.join(dir, 'watching.json');
  }

  /** Creates the folder (0700). Returns false when it cannot be created or written to. */
  ensure(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const marker = path.join(this.dir, `.write-test-${process.pid}`);
      fs.writeFileSync(marker, 'ok');
      fs.unlinkSync(marker);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Emergency stop: a file named STOP, STOP.txt or stop.txt (Explorer appends the extension
   * silently). Synchronous on purpose - it is read in the final gate right before a power action.
   * "I can't check the brake" is treated as "the brake is on".
   */
  stopStatus(): StopStatus {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return { present: true, auto: false, file: null };
    }
    const hit = names.find((name) => STOP_NAMES.has(name.toLowerCase()));
    if (!hit) return { present: false, auto: false, file: null };
    const file = path.join(this.dir, hit);
    let auto = false;
    try {
      auto = fs.readFileSync(file, 'utf8').startsWith(AUTO_STOP_PREFIX);
    } catch {
      // unreadable STOP file is still a STOP file
    }
    return { present: true, auto, file };
  }

  /**
   * Set Emergency stop on the user's behalf (a Cancel / Stop could not reach the controlling
   * window). Never overwrites a STOP file somebody else created. Returns true when a stop is in
   * place afterwards.
   */
  createAutoStop(windowId: string): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.dir, 'STOP'), `${AUTO_STOP_PREFIX}${windowId}\n`, { flag: 'wx' });
      return true;
    } catch {
      return this.stopStatus().present;
    }
  }

  /** Remove a STOP file, but only one that createAutoStop(windowId) wrote. */
  clearAutoStop(windowId: string): void {
    const file = path.join(this.dir, 'STOP');
    try {
      if (fs.readFileSync(file, 'utf8').trim() === `${AUTO_STOP_PREFIX}${windowId}`) fs.unlinkSync(file);
    } catch {
      // not ours, or already gone
    }
  }

  /**
   * The per-user secret every window proves it knows before the leader endpoint is trusted in
   * either direction. The endpoint name is public (derived from the user name), so on a machine
   * with several accounts another account could otherwise listen on it first, or connect to it,
   * and arm watching with rules this user never saw. The file lives in the user's own folder
   * (0600 inside 0700). Returns null when it cannot be read or created - then no window can be
   * trusted, which ends in "watching is off in this window", never in trusting a stranger.
   */
  secret(): string | null {
    const file = path.join(this.dir, 'secret');
    const read = (): string | null => {
      try {
        const value = fs.readFileSync(file, 'utf8').trim();
        return /^[0-9a-f]{64}$/.test(value) ? value : null;
      } catch {
        return null;
      }
    };
    const existing = read();
    if (existing !== null) return existing;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch {
      // EEXIST: another window created it a moment ago - read theirs below.
    }
    return read();
  }

  /** Small JSON records (last-run.json, watching.json). Best effort; never throws. */
  writeJson(file: string, value: unknown): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
    } catch {
      // a record that cannot be written must not stop the controller
    }
  }

  readJson(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  remove(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
}
