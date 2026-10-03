// The backstop that does not depend on the registry: every transcript under projects/*/ is
// looked at, and whatever no live session claims is accounted for one way or the other.
//
// - While an unregistered Claude process (a stray) is running, the transcripts written since it
//   started are judged exactly like sessions: one of them may be its conversation, and we cannot
//   tell which. Such a transcript stands in for the stray only while it is still waited for: one
//   that reads as finished may just as well belong to some session that ended since, while the
//   stray's own conversation sits in a folder nobody watches. A stray none of them stands in for
//   keeps the PC on by itself until it exits or the user lets it go.
// - Any other unclaimed transcript that was written recently keeps the PC on until it has been
//   quiet for the quiet time (a session that just closed, a PID namespace we cannot see into).

import * as path from 'node:path';

import type { StrayCandidate } from './claudeProcess';
import type { OpenRoot } from './roots';
import { listDir } from './scannerFs';
import { Problems, mapLimit, notNull } from './scannerSupport';
import { TRANSCRIPT_EXTENSION, checkTranscript, type TranscriptFile } from './scannerTranscripts';
import type { ScanResult } from './types';

export interface SweptTranscript extends TranscriptFile {
  rootIndex: number;
  /** Name of the project folder it sits in. */
  project: string;
  /** File name without the extension. */
  sessionId: string;
}

const SWEEP_MAX_AGE_MS = 30_000;
const PROJECT_CONCURRENCY = 4;
const STAT_CONCURRENCY = 8;
/** A transcript may be written a moment before the start time its process reports. */
const STARTED_BEFORE_WRITE_TOLERANCE_MS = 5000;
const MAX_ADOPTED = 30;
const MAX_LISTED_UNCLAIMED = 50;
const UNCLAIMED_RECENT_SECONDS = 120;

async function sweepFile(root: OpenRoot, project: string, fileName: string, problems: Problems): Promise<SweptTranscript | null> {
  const file = await checkTranscript(root.fs, path.join(root.projectsDir, project, fileName), problems);
  if (file === null) return null;
  return { ...file, rootIndex: root.index, project, sessionId: fileName.slice(0, -TRANSCRIPT_EXTENSION.length) };
}

async function sweepProject(root: OpenRoot, project: string, problems: Problems): Promise<SweptTranscript[]> {
  const dir = path.join(root.projectsDir, project);
  const listing = await listDir(root.fs, dir);
  // The folder was removed since it was listed, or is not a folder at all.
  if (listing.state === 'missing') return [];
  if (listing.state === 'failed') {
    problems.add(`Couldn't look for transcripts in ${dir}: ${listing.reason}.`);
    return [];
  }
  const fileNames = listing.entries
    .filter((entry) => entry.kind !== 'dir' && entry.name.endsWith(TRANSCRIPT_EXTENSION))
    .map((entry) => entry.name);
  const files = await mapLimit(fileNames, STAT_CONCURRENCY, (fileName) => sweepFile(root, project, fileName, problems));
  return files.filter(notNull);
}

async function sweepRoot(root: OpenRoot, problems: Problems): Promise<SweptTranscript[]> {
  const perProject = await mapLimit(root.projects, PROJECT_CONCURRENCY, (project) => sweepProject(root, project, problems));
  return perProject.flat();
}

interface Sweep {
  takenAtMs: number;
  /** The roots it covers and whether each could be listed; another set needs another sweep. */
  rootsKey: string;
  files: SweptTranscript[];
}

/** Every top-level transcript of every root, with size and write time. Cached between scans. */
export class WideSweep {
  private last: Sweep | null = null;

  /**
   * The cached sweep while it is younger than 30 s, covers the same roots and `force` is off;
   * a fresh one otherwise. A sweep that could not see everything is reported and never cached,
   * so its problems cannot disappear from the scans that would have reused it.
   */
  async transcripts(roots: readonly OpenRoot[], force: boolean, nowMs: number, problems: Problems): Promise<SweptTranscript[]> {
    const rootsKey = roots.map((root) => `${root.root.path}|${root.status.ok}`).join('\n');
    const last = this.last;
    const age = last === null ? null : nowMs - last.takenAtMs;
    if (!force && last !== null && last.rootsKey === rootsKey && age !== null && age >= 0 && age < SWEEP_MAX_AGE_MS) {
      return last.files;
    }
    const found = new Problems();
    const files = (await Promise.all(roots.map((root) => sweepRoot(root, found)))).flat();
    problems.addAll(found);
    this.last = found.count === 0 ? { takenAtMs: nowMs, rootsKey, files } : null;
    return files;
  }
}

export interface Backstop {
  /** Unclaimed transcripts to judge as sessions, newest first. */
  adopted: SweptTranscript[];
  unclaimedRecent: ScanResult['unclaimedRecent'];
  /** Per stray that is not ignored: the paths of the adopted transcripts written since it started. */
  adoptedFor: Map<number, string[]>;
}

/**
 * The quiet time an adopted transcript is judged with. Without a stray the same file would block
 * as a recent unclaimed transcript for at least 120 s, and a stray must never make this PC wait
 * for less than it would without it.
 */
export function adoptedQuietSeconds(quietSeconds: number): number {
  return Math.max(UNCLAIMED_RECENT_SECONDS, quietSeconds);
}

function writtenSince(file: TranscriptFile, startEpochMs: number): boolean {
  return file.mtimeMs >= startEpochMs - STARTED_BEFORE_WRITE_TOLERANCE_MS;
}

function newestFirst(a: TranscriptFile, b: TranscriptFile): number {
  return b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1);
}

/**
 * Decides what happens to the transcripts no live session claims. Pure.
 *
 * `unclaimedRecent` holds every recently written one that is NOT judged as a session, with or
 * without strays: a stray must never make this PC wait for less than it would without it.
 * A stray whose start time is unknown has nothing adopted for it, and blocks by itself.
 */
export function planBackstop(
  unclaimed: readonly SweptTranscript[],
  strays: readonly StrayCandidate[] | null,
  nowMs: number,
  quietSeconds: number,
): Backstop {
  const starts = (strays ?? []).flatMap((stray) => (stray.ignored || stray.startEpochMs === null ? [] : [stray.startEpochMs]));
  const earliestStart = starts.length > 0 ? Math.min(...starts) : null;
  const adopted =
    earliestStart === null
      ? []
      : unclaimed.filter((file) => writtenSince(file, earliestStart)).sort(newestFirst).slice(0, MAX_ADOPTED);

  const recentMs = Math.max(UNCLAIMED_RECENT_SECONDS, quietSeconds) * 1000;
  const judgedAsSession = new Set(adopted.map((file) => file.path));
  const unclaimedRecent = unclaimed
    // Only a real age above the window is old; a write time in the future is recent.
    .filter((file) => !judgedAsSession.has(file.path) && !(nowMs - file.mtimeMs > recentMs))
    .sort(newestFirst)
    .slice(0, MAX_LISTED_UNCLAIMED)
    .map((file) => ({
      path: file.path,
      project: file.project,
      mtimeMs: file.mtimeMs,
      secondsAgo: Math.max(0, (nowMs - file.mtimeMs) / 1000),
    }));

  const adoptedFor = new Map<number, string[]>();
  for (const stray of strays ?? []) {
    const start = stray.startEpochMs;
    if (stray.ignored || start === null) continue;
    adoptedFor.set(stray.pid, adopted.filter((file) => writtenSince(file, start)).map((file) => file.path));
  }
  return { adopted, unclaimedRecent, adoptedFor };
}

/**
 * The strays an adopted transcript stands in for: one that is still waited for (working, just
 * finished, can't tell - and not waived by the user). `blocking` tells, per adopted path, whether
 * the session judged from it keeps the PC on; a path it does not know stands in for nothing.
 */
export function accountedStrays(backstop: Backstop, blocking: ReadonlyMap<string, boolean>): Set<number> {
  const accounted = new Set<number>();
  for (const [pid, paths] of backstop.adoptedFor) {
    if (paths.some((path) => blocking.get(path) === true)) accounted.add(pid);
  }
  return accounted;
}
