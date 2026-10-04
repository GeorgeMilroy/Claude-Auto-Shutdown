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
  TurnReading,
  TurnReason,
  TurnSource,
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
/**
 * A status time and the times of the transcripts come from the same clock, and the records
 * Claude Code writes while a turn is being stopped are flushed within moments of the status.
 */
const STATUS_ACTIVITY_SLACK_MS = 2000;

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
 *
 * `idleSinceMs`: Claude Code reported the session idle at that time, which it does only once no
 * subagent of it runs. An unfinished turn then counts only in a file written more than 2 s after
 * it; a file that ends unfinished before then belongs to a subagent stopped with its session's
 * turn (whose last records are flushed a moment after the status).
 */
export async function summariseSubagents(
  files: readonly SubagentFile[],
  turnOf: (file: SubagentFile) => Promise<TurnInfo>,
  nowMs: number,
  quietSeconds: number,
  idleSinceMs: number | null = null,
): Promise<SubagentSummary> {
  const recentMs = Math.max(SUBAGENT_RECENT_SECONDS, quietSeconds) * 1000;
  const subagents = await mapLimit(files, TURN_READ_CONCURRENCY, async (file): Promise<SubagentInfo> => {
    const ageMs = nowMs - file.mtimeMs;
    const withinHorizon = !isOlderThan(ageMs, SUBAGENT_OPEN_TURN_HORIZON_MS);
    const turn: TurnState = withinHorizon ? (await turnOf(file)).state : 'UNKNOWN';
    // Only a real write time before a real idle time lets an unfinished turn go.
    const stoppedBeforeIdle =
      idleSinceMs !== null && Number.isFinite(idleSinceMs) && file.mtimeMs <= idleSinceMs + STATUS_ACTIVITY_SLACK_MS;
    // A turn that could not be read is not a finished one.
    const active = !isOlderThan(ageMs, recentMs) || (withinHorizon && turn !== 'CLOSED' && !stoppedBeforeIdle);
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

// ---------------------------------------------------------------------------------------------
// Claude Code's own status
// ---------------------------------------------------------------------------------------------

/** What the session's registry entry says about it. */
export interface StatusFacts {
  kind: string;
  claudeStatus: string | null;
  waitingFor: string | null;
  statusUpdatedAtMs: number | null;
  startedAtMs: number | null;
}

export interface StatusRules {
  nowMs: number;
  /** Keep a session that waits for the user's answer working. Only an explicit false lets it go. */
  waitForAnswers: boolean;
}

export interface EffectiveTurn {
  turn: TurnInfo;
  source: TurnSource;
}

/** Beyond this a status time is not the time of a change of this session's status. */
const STATUS_TIME_TOLERANCE_MS = 60_000;
/** Transcript states that leave nothing to check a status against: there is no conversation yet. */
const NOTHING_TO_CHECK: ReadonlySet<TurnReason> = new Set<TurnReason>(['noTranscript', 'noConversationRecord']);

function statusTurn(state: TurnState, reason: TurnReason, detail: string | null = null): TurnInfo {
  return { state, reason, detail, scheduledWakeupSeconds: null };
}

/**
 * When Claude Code's status last changed, or null when that time is not a plausible one: absent,
 * in the future, or from before the session's process started.
 */
export function plausibleStatusTime(status: Pick<StatusFacts, 'statusUpdatedAtMs' | 'startedAtMs'>, nowMs: number): number | null {
  const at = status.statusUpdatedAtMs;
  if (at === null || !Number.isFinite(at)) return null;
  if (!Number.isFinite(nowMs) || at > nowMs + STATUS_TIME_TOLERANCE_MS) return null;
  const started = status.startedAtMs;
  if (started !== null && Number.isFinite(started) && at < started - STATUS_TIME_TOLERANCE_MS) return null;
  return at;
}

/**
 * May a status that says "not working" close the turn? Only when everything that could contradict
 * it was looked at and does not: the session is an interactive one, the time of the status is
 * plausible, the transcript could be read, and it holds no record that only a turn writes from
 * after the status. A missed status write is only logged by Claude Code, so a turn record from
 * after "idle" proves the status is stale.
 */
function statusMayClose(status: StatusFacts, reading: TurnReading, nowMs: number): boolean {
  // Background agents and daemons have other lifecycles; their status is not checked here.
  if (status.kind !== '' && status.kind !== 'interactive') return false;
  const since = plausibleStatusTime(status, nowMs);
  if (since === null) return false;
  const { turn, activity } = reading;
  if (turn.state === 'UNKNOWN' && !NOTHING_TO_CHECK.has(turn.reason)) return false;
  if (turn.reason === 'recordBeingWritten') return false;
  if (activity.kind === 'none') return true;
  return activity.kind === 'at' && activity.ms <= since + STATUS_ACTIVITY_SLACK_MS;
}

/**
 * The turn as Claude Code's own status tells it, falling back to the transcript's reading.
 * Fail-closed like everything else: "busy" and "waiting" keep the turn open whatever the
 * transcript says; "idle" closes it only when nothing contradicts it; a status word this version
 * does not know is "can't tell"; no status at all leaves the transcript to decide.
 */
export function turnFromStatus(status: StatusFacts, reading: TurnReading, rules: StatusRules): EffectiveTurn {
  const fromTranscript: EffectiveTurn = { turn: reading.turn, source: 'transcript' };
  const closeAs = (reason: TurnReason, detail: string | null = null): EffectiveTurn => {
    if (!statusMayClose(status, reading, rules.nowMs)) return fromTranscript;
    // The wake-up of the final turn, whatever the transcript made of the turn itself.
    return { turn: { state: 'CLOSED', reason, detail, scheduledWakeupSeconds: reading.wakeupSeconds }, source: 'claude' };
  };
  switch (status.claudeStatus) {
    case null:
      return fromTranscript;
    case 'busy':
      return { turn: statusTurn('OPEN', 'claudeBusy'), source: 'claude' };
    case 'waiting':
      if (rules.waitForAnswers !== false) return { turn: statusTurn('OPEN', 'claudeWaiting', status.waitingFor), source: 'claude' };
      return closeAs('claudeWaiting', status.waitingFor);
    case 'idle':
      return closeAs('claudeIdle');
    case 'shell':
      return closeAs('claudeShell');
    default:
      return { turn: statusTurn('UNKNOWN', 'claudeStatusUnknown', status.claudeStatus), source: 'claude' };
  }
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
 * writes anything, or Claude Code's status of it changes, which is what makes "don't wait for
 * this session" expire by itself.
 */
export function sessionIgnoreKey(
  rootIndex: number,
  pid: number | null,
  sessionId: string,
  transcript: TranscriptFile | null,
  newestSubagentMtimeMs: number | null,
  statusUpdatedAtMs: number | null,
): string {
  const size = transcript?.size ?? 0;
  const written = Math.floor(transcript?.mtimeMs ?? 0);
  const subagents = Math.floor(newestSubagentMtimeMs ?? 0);
  return `session:${rootIndex}:${pid ?? 0}:${sessionId}:${size}:${written}:${subagents}:${Math.floor(statusUpdatedAtMs ?? 0)}`;
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
