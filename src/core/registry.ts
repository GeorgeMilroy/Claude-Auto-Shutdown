// The session registry (<root>/sessions/<pid>.json) and the question it cannot answer by itself:
// is the process that wrote an entry still the process with that PID?
//
// A registry file stays behind when its process dies, so every entry is checked against the
// running processes. The rule: an entry is thrown away only with PROOF that its process is gone.
// "Could not check" keeps the entry, and the session is then judged by its transcript like any other.

import * as path from 'node:path';

import type { PlatformId, ProcDetail } from '../platform/types';
import type { OpenRoot } from './roots';
import type { SmallFile } from './scannerFs';
import { errorText, isMissing, isRecord, mapLimit, notNull, type Problems } from './scannerSupport';

/** The fields of a registry file the scanner uses. Anything of the wrong type is '' / null. */
export interface RegistryFields {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  entrypoint: string;
  /** Epoch ms; null when absent or not a finite number (never NaN). */
  startedAtMs: number | null;
  /** Process start in the OS's own unit (Windows FILETIME, Linux clock ticks); null = not given. */
  procStart: bigint | null;
  /** 'interactive', 'bg', 'daemon', 'daemon-worker'; '' when absent. */
  kind: string;
  /**
   * What Claude Code says the session is doing: 'busy', 'idle', 'waiting' or 'shell' today. Kept
   * raw, so a value a newer Claude Code adds can be shown; null when absent.
   */
  claudeStatus: string | null;
  /** With 'waiting': what for ('permission prompt', 'input needed', ...); null when absent. */
  waitingFor: string | null;
  /** Epoch ms of the last change of claudeStatus; null when absent or not a finite number. */
  statusUpdatedAtMs: number | null;
}

export interface RegistryEntry extends RegistryFields {
  /** e.g. '1234.json' */
  fileName: string;
  /** Last write of the registry file. */
  mtimeMs: number;
}

export type ParsedRegistry = { ok: true; fields: RegistryFields } | { ok: false; problem: string };

const MAX_REGISTRY_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 16;
const MAX_PID = 0xffff_ffff;
/** Some Windows editors put one in front of a file; JSON.parse does not accept it. */
const BYTE_ORDER_MARK = 0xfeff;
/** These strings travel to every window with each state update: garbage must not make it huge. */
const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 120;
const MAX_PATH_CHARS = 1024;
/** Claude Code's status words are short; anything longer is garbage, cut so it stays small. */
const MAX_STATUS_CHARS = 32;

function text(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

/** One line of text, or null when there is none. */
function lineOrNull(value: unknown, maxChars: number): string | null {
  return text(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, maxChars) || null;
}

function readPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PID ? value : null;
}

function readStartedAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** A number or a string of digits; a FILETIME exceeds 2^53, hence BigInt. */
function readProcStart(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/** Content of one registry file. `problem` completes the sentence "The session file X ...". */
export function parseRegistryEntry(content: string): ParsedRegistry {
  let value: unknown;
  try {
    value = JSON.parse(content.charCodeAt(0) === BYTE_ORDER_MARK ? content.slice(1) : content);
  } catch {
    return { ok: false, problem: "isn't valid JSON" };
  }
  if (!isRecord(value)) return { ok: false, problem: "isn't a JSON object" };
  const pid = readPid(value.pid);
  // Without a process id the entry can be neither checked nor matched to a process. Skipping it
  // silently would hide a session, so it is reported instead.
  if (pid === null) return { ok: false, problem: 'has no usable process id (pid)' };
  return {
    ok: true,
    fields: {
      pid,
      sessionId: text(value.sessionId, MAX_ID_CHARS),
      name: text(value.name, MAX_NAME_CHARS),
      cwd: text(value.cwd, MAX_PATH_CHARS),
      entrypoint: text(value.entrypoint, MAX_ID_CHARS),
      startedAtMs: readStartedAt(value.startedAt),
      procStart: readProcStart(value.procStart),
      kind: text(value.kind, MAX_ID_CHARS),
      claudeStatus: lineOrNull(value.status, MAX_STATUS_CHARS),
      waitingFor: lineOrNull(value.waitingFor, MAX_NAME_CHARS),
      // Same rule as startedAt: a finite, positive epoch-ms number, else unknown.
      statusUpdatedAtMs: readStartedAt(value.statusUpdatedAt),
    },
  };
}

async function readEntry(root: OpenRoot, fileName: string, problems: Problems): Promise<RegistryEntry | null> {
  const subject = `The session file ${fileName} in ${root.root.label}`;
  let file: SmallFile;
  try {
    file = await root.fs.readSmallFile(path.join(root.sessionsDir, fileName), MAX_REGISTRY_BYTES);
  } catch (error) {
    // Listed a moment ago and gone now: the session just closed. That is not a failure to see.
    if (!isMissing(error)) problems.add(`${subject} couldn't be read: ${errorText(error)}.`);
    return null;
  }
  const parsed = parseRegistryEntry(file.text);
  if (!parsed.ok) {
    problems.add(`${subject} ${parsed.problem}.`);
    return null;
  }
  return { ...parsed.fields, fileName, mtimeMs: file.mtimeMs };
}

/** Every readable entry of a root, in file-name order. Unreadable ones are reported and left out. */
export async function readRegistry(root: OpenRoot, problems: Problems): Promise<RegistryEntry[]> {
  const entries = await mapLimit(root.sessionFiles, READ_CONCURRENCY, (fileName) => readEntry(root, fileName, problems));
  return entries.filter(notNull);
}

// ---------------------------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------------------------

/**
 * - verified: the process with this PID started when the entry says its process started
 * - unverified: something has this PID and nothing proves it is a different process
 * - dead: proof that the entry's process is gone
 */
export type LivenessVerdict = 'verified' | 'unverified' | 'dead';

/** FILETIME of 2000-01-01: no Windows process running today started before it. */
const FILETIME_2000 = 125_911_584_000_000_000n;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/**
 * An entry that cannot describe a process of this OS: Claude Code in WSL, a container or a VM
 * wrote it into a folder shared with this system (a symlinked ~/.claude, a bind mount). Its PID
 * belongs to that other system, so no process here proves anything about it - least of all that
 * it is gone.
 */
export function writtenByAnotherSystem(entry: Pick<RegistryEntry, 'cwd' | 'procStart'>, platform: PlatformId): boolean {
  if (platform === 'windows') {
    const start = entry.procStart;
    // Linux clock ticks since boot are far smaller than any FILETIME of a living process.
    return entry.cwd.startsWith('/') || (start !== null && start > 0n && start < FILETIME_2000);
  }
  if (platform === 'linux' || platform === 'macos') return WINDOWS_PATH.test(entry.cwd);
  return false;
}

/** File times are coarse (2 s on FAT), and a process writes its entry a moment after it starts. */
const STARTED_AFTER_ENTRY_MS = 2000;
/** Image names an older, script-based Claude Code install runs under. */
const SCRIPT_RUNTIMES: ReadonlySet<string> = new Set(['node', 'bun', 'deno']);

/** true / false = the start times were compared; null = they cannot be compared. */
function startMatches(startRaw: string | null, procStart: bigint | null, unitsPerSecond: number | null): boolean | null {
  if (startRaw === null || procStart === null || unitsPerSecond === null) return null;
  if (!/^\d+$/.test(startRaw) || !Number.isFinite(unitsPerSecond) || unitsPerSecond <= 0) return null;
  const difference = BigInt(startRaw) - procStart;
  return (difference < 0n ? -difference : difference) <= BigInt(Math.ceil(unitsPerSecond));
}

/** The process started after the entry was last written: the PID was reused by something else. */
function startedAfterEntry(detail: ProcDetail, entryMtimeMs: number): boolean {
  const start = detail.startEpochMs;
  return start !== null && Number.isFinite(start) && Number.isFinite(entryMtimeMs) && start > entryMtimeMs + STARTED_AFTER_ENTRY_MS;
}

function couldRunClaude(name: string, exePath: string | null): boolean {
  return name.includes('claude') || SCRIPT_RUNTIMES.has(name) || (exePath !== null && exePath.toLowerCase().includes('claude'));
}

/**
 * Is the entry's process still running?
 * `detail` is what the platform said about the PID (null = nothing), `name` the image name of the
 * process with that PID in the process list (null = not readable).
 */
export function judgeLiveness(
  entry: Pick<RegistryEntry, 'mtimeMs' | 'procStart'>,
  detail: ProcDetail | null,
  name: string | null,
  procStartUnitsPerSecond: number | null,
): LivenessVerdict {
  if (detail === null) return 'unverified';
  if (detail.state === 'gone' || detail.state === 'exited') return 'dead';

  const match = startMatches(detail.startRaw, entry.procStart, procStartUnitsPerSecond);
  if (match === true) return 'verified';
  if (startedAfterEntry(detail, entry.mtimeMs)) return 'dead';
  // A start time that differs without that proof may be a changed unit or format in a newer
  // Claude Code - which would otherwise make every live session look dead at once.
  if (match === false) return 'unverified';
  // Nothing to compare. The name comes from the process list without opening the process, so a
  // PID that now belongs to some system service is still provably not this session.
  if (name !== null && !couldRunClaude(name, detail.path)) return 'dead';
  return 'unverified';
}
