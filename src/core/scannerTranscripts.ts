// Finds the files a session writes: its transcript(s) under <root>/projects/*/<sessionId>.jsonl
// and the transcripts of its subagents under <transcript without .jsonl>/subagents/**.

import * as path from 'node:path';

import type { OpenRoot } from './roots';
import { listDir, type FsApi } from './scannerFs';
import { errorText, isMissing, mapLimit, notNull, type Problems } from './scannerSupport';

export interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SubagentFile extends TranscriptFile {
  /** File name without the extension. */
  name: string;
}

export const TRANSCRIPT_EXTENSION = '.jsonl';

const SEARCH_INTERVAL_MS = 60_000;
const STAT_CONCURRENCY = 16;
const FOLDER_CONCURRENCY = 4;
const SUBAGENTS_FOLDER = 'subagents';
/** A workflow's own log, not an agent's conversation. */
const WORKFLOW_JOURNAL = 'journal.jsonl';
/** Agents sit at depth 0 (subagents/) or 2 (subagents/workflows/wf_x/). */
const MAX_SUBAGENT_DEPTH = 6;
/**
 * A session id comes from a registry file and ends up in a file path. Real ones are UUIDs;
 * anything that is not a plain file name ('..\\..\\x') must never reach the file system.
 */
const PLAIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The transcript as it is right now; null = no such file (any more). Rejects on any other error. */
async function statTranscript(fs: FsApi, file: string): Promise<TranscriptFile | null> {
  try {
    const info = await fs.stat(file);
    return info.isFile ? { path: file, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** The transcript as it is right now. One that cannot be checked is reported and treated as absent. */
export async function checkTranscript(fs: FsApi, file: string, problems: Problems): Promise<TranscriptFile | null> {
  try {
    return await statTranscript(fs, file);
  } catch (error) {
    problems.add(`Couldn't check the transcript ${file}: ${errorText(error)}.`);
    return null;
  }
}

async function checkAll(fs: FsApi, files: readonly string[], problems: Problems): Promise<TranscriptFile[]> {
  const found = await mapLimit(files, STAT_CONCURRENCY, (file) => checkTranscript(fs, file, problems));
  return found.filter(notNull);
}

interface Lookup {
  paths: string[];
  searchedAtMs: number;
}

function isCurrent(lookup: Lookup, nowMs: number): boolean {
  const age = nowMs - lookup.searchedAtMs;
  return age >= 0 && age < SEARCH_INTERVAL_MS;
}

/**
 * Transcripts by session id. The same id can exist under two project folders (a session resumed
 * from another directory or worktree), so ALL matches are returned: pinning the first one found
 * can pin a stale copy that has been closed and silent for days.
 */
export class TranscriptFinder {
  private readonly lookups = new Map<string, Lookup>();
  private readonly used = new Set<string>();

  /**
   * Every existing transcript of the session. The project folders are searched again when none
   * of the known files exists any more, and once a minute otherwise (a second copy can appear).
   */
  async find(root: OpenRoot, sessionId: string, nowMs: number, problems: Problems): Promise<TranscriptFile[]> {
    if (!PLAIN_FILE_NAME.test(sessionId)) return [];
    const key = `${root.root.path}\n${sessionId}`;
    this.used.add(key);
    const known = this.lookups.get(key);
    if (known !== undefined && isCurrent(known, nowMs)) {
      const files = await checkAll(root.fs, known.paths, problems);
      if (files.length > 0) return files;
    }
    const candidates = root.projects.map((project) => path.join(root.projectsDir, project, sessionId + TRANSCRIPT_EXTENSION));
    const files = await checkAll(root.fs, candidates, problems);
    this.lookups.set(key, { paths: files.map((file) => file.path), searchedAtMs: nowMs });
    return files;
  }

  /** Ends one scan: a session that was not looked up in it has closed. */
  forgetUnused(): void {
    for (const key of this.lookups.keys()) {
      if (!this.used.has(key)) this.lookups.delete(key);
    }
    this.used.clear();
  }
}

function isAgentTranscript(fileName: string): boolean {
  return fileName.endsWith(TRANSCRIPT_EXTENSION) && fileName !== WORKFLOW_JOURNAL;
}

async function checkSubagent(fs: FsApi, dir: string, fileName: string, problems: Problems): Promise<SubagentFile | null> {
  const file = await checkTranscript(fs, path.join(dir, fileName), problems);
  return file === null ? null : { ...file, name: fileName.slice(0, -TRANSCRIPT_EXTENSION.length) };
}

async function collectSubagents(fs: FsApi, dir: string, depth: number, problems: Problems): Promise<SubagentFile[]> {
  const listing = await listDir(fs, dir);
  if (listing.state === 'missing') return [];
  if (listing.state === 'failed') {
    problems.add(`Couldn't look for subagents in ${dir}: ${listing.reason}.`);
    return [];
  }
  const fileNames = listing.entries.filter((entry) => entry.kind !== 'dir' && isAgentTranscript(entry.name)).map((entry) => entry.name);
  const folders = listing.entries.filter((entry) => entry.kind === 'dir').map((entry) => path.join(dir, entry.name));
  if (folders.length > 0 && depth >= MAX_SUBAGENT_DEPTH) {
    problems.add(`The subagent folders in ${dir} are nested too deeply to check.`);
    folders.length = 0;
  }
  const files = await mapLimit(fileNames, STAT_CONCURRENCY, (fileName) => checkSubagent(fs, dir, fileName, problems));
  const nested = await mapLimit(folders, FOLDER_CONCURRENCY, (folder) => collectSubagents(fs, folder, depth + 1, problems));
  return [...files.filter(notNull), ...nested.flat()];
}

/**
 * Every subagent transcript of a session. The search is recursive: plain subagents sit directly
 * in subagents/, but the agents of a workflow sit in subagents/workflows/wf_<id>/ - and those are
 * the ones that keep grinding for hours after the main session went quiet.
 */
export function listSubagentFiles(fs: FsApi, transcriptPath: string, problems: Problems): Promise<SubagentFile[]> {
  const home = path.join(transcriptPath.slice(0, -TRANSCRIPT_EXTENSION.length), SUBAGENTS_FOLDER);
  return collectSubagents(fs, home, 0, problems);
}
