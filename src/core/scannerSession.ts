// How one session is judged once its files have been found: which subagents still count as
// working, how long it has been silent, and the single ordered rule that turns all of that into
// working / not working. Pure apart from the turn reader handed to summariseSubagents.

import type { SubagentFile, TranscriptFile } from './scannerTranscripts';
import { mapLimit } from './scannerSupport';
import type {
  ChildProcessInfo,
  Session,
  SessionStatus,
  SessionWhy,
  SubagentInfo,
  TurnInfo,
  TurnReason,
  TurnState,
} from './types';

/** A subagent that wrote within this long counts as working, whatever its turn says. */
const SUBAGENT_RECENT_SECONDS = 120;
/**
 * A subagent inside one long tool call writes nothing for a long time, so an unfinished turn
 * keeps it working for this long. The limit bounds the damage of one that was killed mid-turn.
 */
const SUBAGENT_OPEN_TURN_HORIZON_MS = 1800 * 1000;
const MAX_LISTED_SUBAGENTS = 20;
const TURN_READ_CONCURRENCY = 8;
/** Slack after a scheduled wake-up is due, for the session to actually start writing again. */
const WAKEUP_GRACE_MS = 120_000;

export function unknownTurn(reason: TurnReason, detail: string | null = null): TurnInfo {
  return { state: 'UNKNOWN', reason, detail, scheduledWakeupSeconds: null };
}

export function newestOf<T extends TranscriptFile>(files: readonly T[]): T | null {
  let newest: T | null = null;
  for (const file of files) {
    if (newest === null || file.mtimeMs > newest.mtimeMs) newest = file;
  }
  return newest;
}

/** The newest of the write times that are known; null when none is. */
export function latest(times: readonly (number | null)[]): number | null {
  let newest: number | null = null;
  for (const time of times) {
    if (time !== null && Number.isFinite(time) && (newest === null || time > newest)) newest = time;
  }
  return newest;
}

/** Only a real number above the limit is "older": an age that cannot be computed is not. */
function isOlderThan(ageMs: number, limitMs: number): boolean {
  return Number.isFinite(ageMs) && ageMs > limitMs;
}

export interface SubagentSummary {
  /** Newest first, at most 20. */
  subagents: SubagentInfo[];
  /** Counted over ALL subagents, not only the listed ones. */
  active: number;
  newestMtimeMs: number | null;
}

/**
 * A subagent counts as working when it wrote recently, or when its own turn is not finished and
 * its last write is inside the open-turn horizon. Turns are only read inside that horizon: older
 * files cannot count either way, and a workflow leaves hundreds of them behind.
 */
export async function summariseSubagents(
  files: readonly SubagentFile[],
  turnOf: (file: SubagentFile) => Promise<TurnInfo>,
  nowMs: number,
  quietSeconds: number,
): Promise<SubagentSummary> {
  const recentMs = Math.max(SUBAGENT_RECENT_SECONDS, quietSeconds) * 1000;
  const subagents = await mapLimit(files, TURN_READ_CONCURRENCY, async (file): Promise<SubagentInfo> => {
    const ageMs = nowMs - file.mtimeMs;
    const withinHorizon = !isOlderThan(ageMs, SUBAGENT_OPEN_TURN_HORIZON_MS);
    const turn: TurnState = withinHorizon ? (await turnOf(file)).state : 'UNKNOWN';
    // A turn that could not be read is not a finished one.
    const active = !isOlderThan(ageMs, recentMs) || (withinHorizon && turn !== 'CLOSED');
    return { name: file.name, path: file.path, mtimeMs: file.mtimeMs, turn, active };
  });
  subagents.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  return {
    subagents: subagents.slice(0, MAX_LISTED_SUBAGENTS),
    active: subagents.filter((subagent) => subagent.active).length,
    newestMtimeMs: subagents[0]?.mtimeMs ?? null,
  };
}

/**
 * Seconds until a session that ended its turn wakes itself up again (/loop), or null when no
 * wake-up is pending. Blocking only: it can make a CLOSED turn count as working, nothing else.
 */
export function pendingWakeupSeconds(turn: TurnInfo, transcript: TranscriptFile | null, nowMs: number): number | null {
  const delay = turn.scheduledWakeupSeconds;
  if (turn.state !== 'CLOSED' || transcript === null || typeof delay !== 'number') return null;
  const dueInMs = transcript.mtimeMs + delay * 1000 - nowMs;
  if (Number.isFinite(dueInMs) && dueInMs + WAKEUP_GRACE_MS <= 0) return null;
  return Number.isFinite(dueInMs) ? Math.max(0, Math.round(dueInMs / 1000)) : 0;
}

export interface SessionFacts {
  turn: TurnState;
  activeSubagents: number;
  /** Seconds until a scheduled wake-up; null = none pending. */
  wakeupInSeconds: number | null;
  /** A busy child process the user has not chosen to ignore; null = none. */
  busyChild: ChildProcessInfo | null;
  /** null = no write time could be read at all. */
  silenceSeconds: number | null;
  quietSeconds: number;
}

export type Judgement = Pick<Session, 'working' | 'status' | 'why'>;

function working(status: SessionStatus, why: SessionWhy): Judgement {
  return { working: true, status, why };
}

/**
 * Does this session keep the PC on? One place, one order. An unfinished turn beats silence:
 * during /compact or a rate-limit wait the transcript stands still while the session works.
 * "Finished" is the only answer that has to be earned; everything else, including not knowing,
 * counts as working.
 */
export function judgeSession(facts: SessionFacts): Judgement {
  if (facts.turn !== 'CLOSED' && facts.turn !== 'OPEN') return working('cantTell', { id: 'turnUnknown' });
  if (facts.turn === 'OPEN') return working('working', { id: 'turnOpen' });
  if (facts.activeSubagents > 0) return working('working', { id: 'subagentsActive', count: facts.activeSubagents });
  if (facts.wakeupInSeconds !== null) return working('working', { id: 'scheduledWakeup', inSeconds: facts.wakeupInSeconds });
  if (facts.busyChild !== null) {
    return working('working', { id: 'childBusy', name: facts.busyChild.name, pid: facts.busyChild.pid });
  }
  if (facts.silenceSeconds === null) return working('cantTell', { id: 'silenceUnknown' });
  const quietLongEnough = Number.isFinite(facts.silenceSeconds) && facts.silenceSeconds >= facts.quietSeconds;
  if (!quietLongEnough) return working('justFinished', { id: 'recentWrite' });
  return { working: false, status: 'finished', why: { id: 'quiet' } };
}

/**
 * Names one state of one session: the key changes as soon as the session or one of its subagents
 * writes anything, which is what makes "don't wait for this session" expire by itself.
 */
export function sessionIgnoreKey(
  rootIndex: number,
  pid: number | null,
  sessionId: string,
  transcript: TranscriptFile | null,
  newestSubagentMtimeMs: number | null,
): string {
  const size = transcript?.size ?? 0;
  const written = Math.floor(transcript?.mtimeMs ?? 0);
  return `session:${rootIndex}:${pid ?? 0}:${sessionId}:${size}:${written}:${Math.floor(newestSubagentMtimeMs ?? 0)}`;
}

/** Last segment of a working directory, whichever slash it uses; '' when there is none. */
export function folderOf(cwd: string): string {
  return cwd.split(/[\\/]+/).filter(Boolean).pop() ?? '';
}

const STATUS_ORDER: Record<SessionStatus, number> = { cantTell: 0, working: 1, justFinished: 2, finished: 3 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What needs attention first: can't tell, working, just finished, finished; then by name. */
export function compareSessions(a: Session, b: Session): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.key, b.key)
  );
}

/** Two sessions must never share a list key; a repeated one gets a counter. */
export function withUniqueKeys(sessions: readonly Session[]): Session[] {
  const used = new Map<string, number>();
  return sessions.map((session) => {
    const count = (used.get(session.key) ?? 0) + 1;
    used.set(session.key, count);
    return count === 1 ? session : { ...session, key: `${session.key}#${count}` };
  });
}
