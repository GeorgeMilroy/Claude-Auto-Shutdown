// Engine data model. Everything here is plain JSON-serialisable data: it travels from the leader
// window to every other window and into the webview unchanged.
//
// Rule underneath everything: not knowing is never permission to shut down. Unknown values are
// `null`, never 0 / '' / false, and every gate passes only on `Number.isFinite(x) && x >= limit`.

// ---------------------------------------------------------------------------------------------
// Transcript turn state
// ---------------------------------------------------------------------------------------------

export type TurnState = 'CLOSED' | 'OPEN' | 'UNKNOWN';

export type TurnReason =
  // CLOSED
  | 'turnEnded' // assistant + stop_reason end_turn / stop_sequence: model answered, waits for a human
  | 'interrupted' // main thread: Claude Code's "[Request interrupted by user]" marker (Esc)
  | 'toolDeclined' // main thread: a declined permission, whose answer ends the turn
  | 'localCommand' // main thread: the output of a local command (/model, /cost, ...)
  | 'claudeIdle' // Claude Code's own status: idle
  | 'claudeShell' // Claude Code's own status: idle, with a background shell still running
  // OPEN, or CLOSED when the user lets such sessions go (waitForAnswers off)
  | 'claudeWaiting' // Claude Code's own status: waiting for the user's answer (detail: what for)
  // OPEN
  | 'claudeBusy' // Claude Code's own status: busy
  | 'toolInFlight' // assistant + stop_reason tool_use
  | 'cutAtTokenLimit' // assistant + stop_reason max_tokens
  | 'replyInProgress' // assistant with any other / missing stop_reason
  | 'readingToolResult' // user record carrying a tool_result
  | 'thinking' // user prompt: model is thinking / compacting / waiting on a rate limit
  | 'compacting' // isCompactSummary
  | 'recordBeingWritten' // file does not end in a newline, or its last line does not parse yet
  // UNKNOWN
  | 'claudeStatusUnknown' // Claude Code's status is a word this version does not know (detail: it)
  | 'unknownRecord'
  | 'noTranscript'
  | 'cannotRead'
  | 'noConversationRecord'
  | 'ambiguousTranscripts'; // several transcripts for one session id were written recently

export interface TurnInfo {
  state: TurnState;
  reason: TurnReason;
  /** Raw extra for the reason (stop_reason value, record type, OS error text). */
  detail: string | null;
  /**
   * Blocking-only hint. Set when the turn is CLOSED but the final turn contains a ScheduleWakeup
   * tool call that was not a stop: the session will wake itself up again (e.g. /loop).
   */
  scheduledWakeupSeconds: number | null;
}

/**
 * When the session last did something only a turn does: the creation time of the newest
 * conversation record that Claude Code does not also write while the session is idle (local
 * commands, `!` shell lines, interrupt markers and declined tools are written idle).
 * - none: there is no such record
 * - at: its `timestamp`
 * - untimed: its time can't be read, or the part of the file that was read can't tell
 */
export type TurnActivity = { kind: 'none' } | { kind: 'at'; ms: number } | { kind: 'untimed' };

/** Everything one read of a transcript tail says. */
export interface TurnReading {
  turn: TurnInfo;
  activity: TurnActivity;
  /**
   * What a ScheduleWakeup call in the final turn asked for, whatever the turn state
   * (`turn.scheduledWakeupSeconds` is set for a CLOSED turn only). Blocking-only.
   */
  wakeupSeconds: number | null;
}

/** What decided a session's turn: Claude Code's own status, or its transcript. */
export type TurnSource = 'claude' | 'transcript';

/** One line of the transcript preview. */
export interface TranscriptEvent {
  /** 'HH:MM:SS' taken from the record's timestamp, '' if absent. */
  time: string;
  who: 'claude' | 'you' | 'system' | 'other';
  /** Record came from a sidechain (subagent). */
  sidechain: boolean;
  /** One line, whitespace collapsed, max 400 chars. Tool calls look like `Bash: npm test`. */
  text: string;
  kind: 'text' | 'tool' | 'result' | 'thinking' | 'other';
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * Where a session came from.
 * - registry: an entry in <root>/sessions/<pid>.json
 * - transcript: a transcript nobody claims, written since an unregistered Claude process started.
 *   We can't tell which process owns it, so it is judged like a session (with a quiet time of at
 *   least 120 s).
 */
export type SessionOrigin = 'registry' | 'transcript';

/**
 * How sure we are that the registry entry's process is the session's process.
 * - verified: PID alive and its start time matches procStart
 * - unverified: PID alive but the start time could not be compared (treated as alive)
 * - foreign: the entry lives in another PID namespace (WSL, container): judged by its status and transcript only (no process check)
 * - none: no process is associated (origin 'transcript')
 */
export type Liveness = 'verified' | 'unverified' | 'foreign' | 'none';

/** The four words the UI uses for a session. */
export type SessionStatus = 'working' | 'justFinished' | 'finished' | 'cantTell';

/** Why a session is in its status. Rendered by shared/text.ts; never parse the text. */
export type SessionWhy =
  | { id: 'turnOpen' } // see turnReason
  | { id: 'turnUnknown' } // see turnReason
  | { id: 'silenceUnknown' } // no write time could be read at all
  | { id: 'subagentsActive'; count: number }
  | { id: 'childBusy'; name: string; pid: number }
  // A ScheduleWakeup call (self-paced /loop) or a CronCreate task that was not cancelled
  // (/loop with an interval, reminders). inSeconds 0 = due now, or the time cannot be worked out.
  | { id: 'scheduledWakeup'; inSeconds: number }
  | { id: 'recentWrite' } // turn ended, but quiet for less than the target
  | { id: 'quiet' }; // finished

export interface SubagentInfo {
  /** File name without extension. */
  name: string;
  path: string;
  mtimeMs: number;
  turn: TurnState;
  /** Counts as still working (recent write, or OPEN turn within the open-turn horizon). */
  active: boolean;
}

export interface ChildProcessInfo {
  pid: number;
  name: string;
  /** Percent of one core since the previous scan; null on the first sample. */
  cpuPercent: number | null;
  /** Bytes read+written per second since the previous scan; null when unavailable. */
  ioBytesPerSecond: number | null;
  /** Did work since the previous scan (CPU or I/O above the threshold). */
  busy: boolean;
  /** `proc:<pid>:<start>` - pass to the ignore command to stop waiting for this process. */
  ignoreKey: string;
  ignored: boolean;
}

export interface Session {
  /** Unique within a scan and stable across scans. Use as list key. */
  key: string;
  origin: SessionOrigin;
  liveness: Liveness;
  pid: number | null;
  sessionId: string;
  /** Display name: registry name, else first 8 chars of the session id, else the file name. */
  name: string;
  cwd: string;
  /** Last path segment of cwd ('' if unknown). */
  folder: string;
  /** Raw registry entrypoint ('cli', 'claude-desktop', 'claude-vscode', ...), '' if unknown. */
  entrypoint: string;
  /** Label of the Claude config dir it was found in ('~/.claude', 'WSL: Ubuntu', ...). */
  rootLabel: string;
  startedAtMs: number | null;
  transcriptPath: string | null;
  /** Newest write across transcript and subagents, or change of Claude Code's status (epoch ms); null = unknown. */
  lastActivityMs: number | null;
  /** Seconds since lastActivityMs; null = unknown (never Infinity, never 0 as a stand-in). */
  silenceSeconds: number | null;
  turn: TurnState;
  turnReason: TurnReason;
  turnDetail: string | null;
  /** The registry entry's kind ('interactive', 'bg', ...); '' when it has none or there is no entry. */
  kind: string;
  /** Claude Code's own status, raw ('busy', 'idle', 'waiting', 'shell', ...); null = none given. */
  claudeStatus: string | null;
  /** With 'waiting': what for ('permission prompt', ...); null otherwise. */
  waitingFor: string | null;
  /** When claudeStatus last changed (epoch ms), if that time is plausible; null otherwise. */
  claudeStatusSinceMs: number | null;
  /** What decided `turn`: Claude Code's own status, or the transcript. */
  turnSource: TurnSource;
  activeSubagents: number;
  /** Newest first, at most 20. */
  subagents: SubagentInfo[];
  /** Descendant processes that are (or recently were) doing work. Empty when the check is off. */
  children: ChildProcessInfo[];
  status: SessionStatus;
  /** true = this session keeps the PC on (before taking `ignored` into account). */
  working: boolean;
  why: SessionWhy;
  /** `session:<...>` - pass to the ignore command. Changes whenever the session writes again or its status changes. */
  ignoreKey: string;
  /** The user said "don't wait for this session"; void as soon as ignoreKey changes. */
  ignored: boolean;
}

// ---------------------------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------------------------

export interface RootStatus {
  path: string;
  label: string;
  /** local = same PID namespace as this process; foreign = WSL / container. */
  kind: 'local' | 'foreign';
  /** false = it should exist / be readable but is not (counts as a scan error). */
  ok: boolean;
  /** The directory does not exist (fine for optional roots). */
  missing: boolean;
  detail: string | null;
}

export interface StrayProcess {
  pid: number;
  name: string;
  /** Full path, or null when it could not be read. */
  path: string | null;
  /**
   * A transcript written since this process started is judged as a session and still waited for
   * (not finished, not ignored), so that session keeps the PC on in its place. Once every such
   * transcript reads as finished, or there is none, the process blocks by itself until it exits or
   * is ignored: a finished transcript may belong to any other session.
   */
  accounted: boolean;
  /** `proc:<pid>:<start>` */
  ignoreKey: string;
  ignored: boolean;
  /**
   * Busy descendant processes (a build it left running), measured like a session's children, at
   * most 10, the ones that block first. They are waited for whether or not the stray itself is
   * ignored. Empty when the check is off.
   */
  children: ChildProcessInfo[];
}

export interface ScanResult {
  startedAtMs: number;
  completedAtMs: number;
  /** Sorted: cantTell, working, justFinished, finished; then by name. */
  sessions: Session[];
  /**
   * Anything that means "I could not see properly". Non-empty = the scanner check fails.
   * Human-readable English, one entry per problem.
   */
  errors: string[];
  roots: RootStatus[];
  /**
   * Live Claude Code processes with no registry entry. null = the process list could not be read
   * (which blocks).
   */
  strays: StrayProcess[] | null;
  /**
   * Backstop: transcripts no live session claims that were written within max(120 s, quiet time)
   * and are not judged as sessions (while a stray runs, the ones written since it started are).
   */
  unclaimedRecent: { path: string; project: string; mtimeMs: number; secondsAgo: number }[];
  /** Seconds since the last mouse / keyboard input; null = can't tell. */
  idleSeconds: number | null;
  /** Lower-cased names of running keep-on-list processes; null = the process list failed. */
  guardHits: string[] | null;
  /** The platform helper answered and listed processes. */
  processListOk: boolean;
  /** Why the helper is not fully available (limited tier, did not start, ...), else null. */
  helperProblem: string | null;
}

// ---------------------------------------------------------------------------------------------
// Checks ("what we're waiting for")
// ---------------------------------------------------------------------------------------------

export type CheckId =
  | 'armed'
  | 'stopFile'
  | 'scanner'
  | 'helper'
  | 'actionAllowed'
  | 'remoteWindows'
  | 'registry'
  | 'unclaimedTranscripts'
  | 'hasSessions'
  | 'sessionsIdle'
  | 'turnsClosed'
  | 'quiet'
  | 'childProcesses'
  | 'userIdle'
  | 'guard'
  | 'confirmed';

/**
 * - pass: fine
 * - waiting: not yet, but nothing is wrong (a timer, a session still working)
 * - cantTell: we could not find out - blocks, and is shown as a problem
 * - fail: something is wrong (emergency stop set, helper missing, action not allowed)
 */
export type CheckState = 'pass' | 'waiting' | 'cantTell' | 'fail';

export type CheckData = Record<string, string | number | boolean | null | string[] | number[]>;

export interface Check {
  id: CheckId;
  state: CheckState;
  /** Raw values for the text layer (shared/text.ts). Keys are documented in core/evaluate.ts. */
  data: CheckData;
}

export interface Verdict {
  /** In evaluation order; `confirmed` is always last. */
  checks: Check[];
  /** Every check except `confirmed` passes. */
  allClear: boolean;
  /** allClear and confirmed: the countdown may start. */
  ok: boolean;
  /** Consecutive all-clear polls after this evaluation. */
  stablePolls: number;
  requiredPolls: number;
}
