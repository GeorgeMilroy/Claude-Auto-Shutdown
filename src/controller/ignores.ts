// "Don't wait for this": the sessions, processes and remote windows the user told the controller
// to stop waiting for.
//
// An ignore only ever makes this PC do MORE (it waives a blocker), so the list is kept honest:
// - a session key embeds the transcript's size and write time, so it stops matching the moment the
//   session writes again - and is then dropped;
// - a process key embeds pid + start time, so it can never match another process;
// - a remote-window key is only a name, so it is dropped as soon as that window disconnects - a
//   later window with the same name must block again.

import type { ScanResult } from '../core/types';

const IGNORE_PREFIXES = ['session:', 'proc:', 'remote:'] as const;
export const MAX_IGNORES = 200;
const MAX_IGNORE_KEY_CHARS = 1024;
/** A background process is only listed while it is busy; its ignore survives pauses this long. */
export const PROC_IGNORE_GRACE_MS = 30 * 60_000;
/** After a takeover the other windows need a moment to reconnect; their ignores wait for them. */
export const REMOTE_RECONNECT_GRACE_MS = 15_000;

const REMOTE_PREFIX = 'remote:';

export function isIgnoreKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_IGNORE_KEY_CHARS &&
    IGNORE_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length)
  );
}

export function remoteIgnoreKey(windowName: string): string {
  return `${REMOTE_PREFIX}${windowName}`;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** For the activity log: what an ignore key stands for, as far as the latest scan can tell. */
export function describeIgnoreKey(key: string, scan: ScanResult | null): string {
  if (key.startsWith(REMOTE_PREFIX)) return `the remote window "${clip(key.slice(REMOTE_PREFIX.length))}"`;
  for (const session of scan?.sessions ?? []) {
    if (session.ignoreKey === key) return `session "${clip(session.name)}" (until it writes again)`;
    const child = session.children.find((candidate) => candidate.ignoreKey === key);
    if (child !== undefined) return `process ${clip(child.name)} (PID ${child.pid})`;
  }
  for (const stray of scan?.strays ?? []) {
    if (stray.ignoreKey === key) return `process ${clip(stray.name)} (PID ${stray.pid})`;
    const child = (stray.children ?? []).find((candidate) => candidate.ignoreKey === key);
    if (child !== undefined) return `process ${clip(child.name)} (PID ${child.pid})`;
  }
  return key.startsWith('session:') ? 'a session' : 'a process';
}

function keysListedBy(scan: ScanResult): Set<string> {
  const listed = new Set<string>();
  for (const session of scan.sessions) {
    listed.add(session.ignoreKey);
    for (const child of session.children) listed.add(child.ignoreKey);
  }
  for (const stray of scan.strays ?? []) {
    listed.add(stray.ignoreKey);
    // Read defensively: a scan from before strays carried their children has none.
    for (const child of stray.children ?? []) listed.add(child.ignoreKey);
  }
  return listed;
}

export class IgnoreList {
  /** Ignore key -> monotonic time it was set or last listed by a scan. */
  private readonly lastSeen = new Map<string, number>();
  private remoteGraceEndMono: number | null = null;

  get size(): number {
    return this.lastSeen.size;
  }

  has(key: string): boolean {
    return this.lastSeen.has(key);
  }

  keys(): string[] {
    return [...this.lastSeen.keys()];
  }

  add(key: string, mono: number): void {
    this.lastSeen.set(key, mono);
  }

  remove(key: string): void {
    this.lastSeen.delete(key);
  }

  /** Ignores handed over by the previous leader. Its remote windows are still reconnecting. */
  adopt(keys: readonly string[], mono: number): void {
    for (const key of keys) this.lastSeen.set(key, mono);
    this.remoteGraceEndMono = mono + REMOTE_RECONNECT_GRACE_MS;
  }

  /** Drops remote-window ignores whose window is no longer connected. */
  pruneRemote(connected: ReadonlySet<string>, mono: number): void {
    if (this.remoteGraceEndMono !== null && mono < this.remoteGraceEndMono) return;
    for (const key of this.lastSeen.keys()) {
      if (key.startsWith(REMOTE_PREFIX) && !connected.has(key)) this.lastSeen.delete(key);
    }
  }

  /**
   * Drops session / process ignores that the scan no longer lists. An incomplete scan (errors,
   * no process list) drops nothing: "I could not see it" is not "it is gone".
   * Returns how many session ignores were voided.
   */
  pruneAgainst(scan: ScanResult, mono: number): number {
    const listed = keysListedBy(scan);
    const complete = scan.errors.length === 0 && scan.strays !== null;
    let voidedSessions = 0;
    for (const [key, lastSeenMono] of this.lastSeen) {
      if (key.startsWith(REMOTE_PREFIX)) continue;
      if (listed.has(key)) {
        this.lastSeen.set(key, mono);
        continue;
      }
      if (!complete) continue;
      if (key.startsWith('proc:') && mono - lastSeenMono < PROC_IGNORE_GRACE_MS) continue;
      this.lastSeen.delete(key);
      if (key.startsWith('session:')) voidedSessions++;
    }
    return voidedSessions;
  }
}
