// Which running processes are Claude Code sessions, and which of them the registry knows nothing
// about ("strays"). A session that never wrote its registry entry - another version, a failed
// write, a config folder nobody told us about - would be invisible to everything that reads files.

import type { ProcDetail, ProcRow } from '../platform/types';
import { processIgnoreKey } from './processTree';

const CLAUDE = 'claude';

/**
 * The desktop app is called claude too, and runs a dozen helper processes under that name.
 * These folders hold it (Windows Store and installer builds, macOS bundle, Linux package, the
 * browser bridge). None of them is a session.
 */
const DESKTOP_APP_MARKERS = [
  '/windowsapps/claude_',
  '/anthropicclaude/',
  'claude.app/contents/',
  '/claude-desktop/',
  '/chromenativehost/',
];

/** The native installer's binaries are named after their version: ~/.local/share/claude/versions/2.1.283 */
const VERSIONS_MARKER = '/claude/versions/';

function withoutExe(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -'.exe'.length) : lower;
}

/**
 * Is this a Claude Code SESSION process (as opposed to the desktop app's Electron shell and its
 * helpers)? `name` is lower-case without '.exe'; `path` may be null (unreadable).
 * Returns 'yes', 'no', or 'unknown' (named like Claude but the path could not be read).
 *
 * The rule looks at the FILE NAME, not at "claude" anywhere in the path: the binary the VS Code
 * extension runs lives in ...\anthropic.claude-code-<version>\resources\native-binary\claude.exe,
 * which no folder marker would catch, while a folder marker alone would catch the desktop app.
 */
export function isClaudeCodeProcess(name: string, path: string | null): 'yes' | 'no' | 'unknown' {
  if (typeof path !== 'string' || path === '') {
    return typeof name === 'string' && withoutExe(name) === CLAUDE ? 'unknown' : 'no';
  }
  const normalised = path.replace(/\\/g, '/').toLowerCase();
  if (DESKTOP_APP_MARKERS.some((marker) => normalised.includes(marker))) return 'no';
  const fileName = withoutExe(normalised.slice(normalised.lastIndexOf('/') + 1));
  return fileName === CLAUDE || normalised.includes(VERSIONS_MARKER) ? 'yes' : 'no';
}

/** A running Claude Code process that is neither a registered session nor started by one. */
export interface StrayCandidate {
  pid: number;
  name: string;
  path: string | null;
  /** Epoch ms; null = unreadable. */
  startEpochMs: number | null;
  ignoreKey: string;
  ignored: boolean;
}

/**
 * `sessionFamily` = the PIDs of live registered sessions and of everything below them.
 * A process whose path cannot be read but which is named claude counts: it may be a session
 * started from an elevated terminal.
 */
export function findStrays(
  processes: readonly ProcRow[],
  details: ReadonlyMap<number, ProcDetail>,
  sessionFamily: ReadonlySet<number>,
  ignores: ReadonlySet<string>,
): StrayCandidate[] {
  const strays: StrayCandidate[] = [];
  for (const row of processes) {
    if (sessionFamily.has(row.pid)) continue;
    const detail = details.get(row.pid) ?? null;
    if (detail !== null && (detail.state === 'gone' || detail.state === 'exited')) continue;
    if (isClaudeCodeProcess(row.name, detail?.path ?? null) === 'no') continue;
    const ignoreKey = processIgnoreKey(row.pid, detail);
    strays.push({
      pid: row.pid,
      name: row.name,
      path: detail?.path ?? null,
      startEpochMs: detail?.startEpochMs ?? null,
      ignoreKey,
      ignored: ignores.has(ignoreKey),
    });
  }
  return strays.sort((a, b) => a.pid - b.pid);
}
