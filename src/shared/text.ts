// Every user-facing sentence that more than one surface needs (dashboard, status bar, modals,
// notifications, log). Pure, no vscode / DOM import: bundled into both the extension host and the
// webview. The vocabulary is fixed by the UI spec - one word per concept, used everywhere:
//   Watching / Not watching, Test run / For real, This PC, away,
//   sessions are Working / Just finished / Finished / Can't tell, STOP file = Emergency stop.
//
// Everything rendered here crossed a boundary first (another window, possibly another version of
// the extension, a JSON record on disk), so every value is re-checked before it is printed. An
// unknown value reads "unknown" or "can't tell" - never NaN / undefined / null, and never a
// reassuring default: when the mode or the action is unclear the text describes the real thing.

import type { Check, CheckData, CheckId, CheckState, Session, SessionStatus, TurnReason } from '../core/types';
import { POWER_ACTIONS } from './config';
import type { ArmContract, Config, PowerAction } from './config';
import type { CancelReason, CountdownKind, LastResult, Role, StopCause, UiState } from './protocol';

const UNKNOWN = 'unknown';
const THIS_PC = 'this PC';
const NOT_CHECKED = "Haven't checked yet";
const NO_PROCESS_LIST = "Couldn't read the process list";
const KEEP_ON = 'Keep this PC on';
const CANCEL_KEEP_ON = 'Cancel: keep this PC on';
const NOT_WATCHING = 'Not watching. This PC stays on.';
const KEEP_EDITOR_OPEN = 'Keep VS Code open.';
/** A turn that is not closed and has written nothing for this long is probably stuck. */
const STUCK_AFTER_SECONDS = 600;
/** After an automatic cancel the controller starts no new countdown for this long. */
const COOLDOWN_SECONDS = 60;
const MAX_LINE_LENGTH = 200;

// --- reading untrusted values ------------------------------------------------------------------

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-negative whole number (seconds, a count); null when the value is not a finite number. */
function whole(value: unknown): number | null {
  const number = finite(value);
  return number === null ? null : Math.max(0, Math.floor(number));
}

/** One printable line: whitespace collapsed, length capped; null when there is nothing to print. */
function clean(value: unknown, maxLength = MAX_LINE_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item)).filter((item): item is string => item !== null);
}

function wholeList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => whole(item)).filter((item): item is number => item !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// --- small wording helpers ---------------------------------------------------------------------

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c", "a, b and 3 more". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const shown = items.length > 3 ? [...items.slice(0, 2), `${items.length - 2} more`] : items;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}

function andMore(extra: number): string {
  return extra > 0 ? ` (+${extra} more)` : '';
}

/** Ends the text with a full stop unless it already ends a sentence. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function joinParts(parts: readonly (string | null)[], separator = ' · '): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(separator);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// --- actions -----------------------------------------------------------------------------------

export interface ActionWords {
  /** Menu label: "Shut down", "Hibernate", "Sleep", "Lock", "Just notify me" */
  menu: string;
  /** "shuts down", "hibernates", "goes to sleep", "locks", "notifies you" (after "this PC") */
  present: string;
  /** "will shut down", "will hibernate", "will go to sleep", "will lock", "will notify you" */
  future: string;
  /** "would have shut down", ... */
  wouldHave: string;
  /** "Shutting down", "Hibernating", "Going to sleep", "Locking", "" for notify */
  gerund: string;
  /** "shut down", "hibernated", "went to sleep", "was locked", "notified you" */
  past: string;
  /** Imperative verb in a sentence: "shut down", "hibernate", "sleep", "lock", "notify" */
  verb: string;
}

interface ActionCopy extends ActionWords {
  /** For "{Shutdown} failed". */
  noun: string;
  /** The imperative with its object: "Shut down this PC", "Put this PC to sleep". */
  imperative(pc: string): string;
  /** "Shutting down this PC", "Putting this PC to sleep". */
  progressive(pc: string): string;
}

const ACTION_COPY: Record<PowerAction, ActionCopy> = {
  shutdown: {
    menu: 'Shut down',
    present: 'shuts down',
    future: 'will shut down',
    wouldHave: 'would have shut down',
    gerund: 'Shutting down',
    past: 'shut down',
    verb: 'shut down',
    noun: 'Shutdown',
    imperative: (pc) => `Shut down ${pc}`,
    progressive: (pc) => `Shutting down ${pc}`,
  },
  hibernate: {
    menu: 'Hibernate',
    present: 'hibernates',
    future: 'will hibernate',
    wouldHave: 'would have hibernated',
    gerund: 'Hibernating',
    past: 'hibernated',
    verb: 'hibernate',
    noun: 'Hibernate',
    imperative: (pc) => `Hibernate ${pc}`,
    progressive: (pc) => `Hibernating ${pc}`,
  },
  sleep: {
    menu: 'Sleep',
    present: 'goes to sleep',
    future: 'will go to sleep',
    wouldHave: 'would have gone to sleep',
    gerund: 'Going to sleep',
    past: 'went to sleep',
    verb: 'sleep',
    noun: 'Sleep',
    imperative: (pc) => `Put ${pc} to sleep`,
    progressive: (pc) => `Putting ${pc} to sleep`,
  },
  lock: {
    menu: 'Lock',
    present: 'locks',
    future: 'will lock',
    wouldHave: 'would have locked',
    gerund: 'Locking',
    past: 'was locked',
    verb: 'lock',
    noun: 'Lock',
    imperative: (pc) => `Lock ${pc}`,
    progressive: (pc) => `Locking ${pc}`,
  },
  notify: {
    menu: 'Just notify me',
    present: 'notifies you',
    future: 'will notify you',
    wouldHave: 'would have notified you',
    gerund: '',
    past: 'notified you',
    verb: 'notify',
    noun: 'Notification',
    imperative: () => 'Notify me',
    progressive: () => 'Notifying you',
  },
};

/**
 * A window running another version can name an action this one has never heard of. It is described
 * as an unknown action that DOES act on this PC - the alarming reading, never "just a message".
 */
const UNKNOWN_ACTION: ActionCopy = {
  menu: 'Unknown action',
  present: 'runs an unknown action',
  future: 'will run an unknown action',
  wouldHave: 'would have run an unknown action',
  gerund: 'Running an unknown action',
  past: 'ran an unknown action',
  verb: 'run an unknown action',
  noun: 'Action',
  imperative: (pc) => `Run an unknown action on ${pc}`,
  progressive: (pc) => `Running an unknown action on ${pc}`,
};

function isPowerAction(value: unknown): value is PowerAction {
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value);
}

function copyFor(action: unknown): ActionCopy {
  return isPowerAction(action) ? ACTION_COPY[action] : UNKNOWN_ACTION;
}

/** "shut down", "go to sleep", "notify you": the form after "would" / "couldn't" / "won't". */
function infinitive(copy: ActionCopy): string {
  return copy.future.replace(/^will /, '');
}

/** "Shut down", "Went to sleep", "Locked": the past as a title. */
function doneTitle(copy: ActionCopy): string {
  return capitalize(copy.past.replace(/^was /, ''));
}

export function actionWords(action: PowerAction): ActionWords {
  const { menu, present, future, wouldHave, gerund, past, verb } = copyFor(action);
  return { menu, present, future, wouldHave, gerund, past, verb };
}

/** Only an explicit `true` is a test run; a missing or odd value is described as for real. */
function isTestRun(contract: ArmContract): boolean {
  return contract.testMode === true;
}

/** A missing contract (a state from another version) reads as "nothing known", never as defaults. */
function asContract(value: unknown): ArmContract {
  return (isRecord(value) ? value : {}) as unknown as ArmContract;
}

function contractOf(state: UiState): ArmContract {
  return asContract(state.contract);
}

// --- numbers and time --------------------------------------------------------------------------

function units(big: number, bigUnit: string, small: number, smallUnit: string): string {
  return small > 0 ? `${big} ${bigUnit} ${small} ${smallUnit}` : `${big} ${bigUnit}`;
}

/**
 * Elapsed time, rounded down: "18 s", "90 s", "4 min", "1 h 12 min", "2 d 3 h"; null -> "unknown".
 * Never "NaN". Anything under 2 min stays in seconds, so a 90 s countdown is never told as
 * "1 min". For a configured duration that must not lose its remainder use fmtSetting.
 */
export function fmtDuration(seconds: number | null): string {
  const total = whole(seconds);
  if (total === null) return UNKNOWN;
  if (total < 120) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min`;
  if (total < 86_400) return units(Math.floor(total / 3600), 'h', Math.floor((total % 3600) / 60), 'min');
  return units(Math.floor(total / 86_400), 'd', Math.floor((total % 86_400) / 3600), 'h');
}

/**
 * A configured duration, exact: "90 s", "5 min", "2 min 30 s", "1 h 30 min"; null -> "unknown".
 * These are the rules the user agrees to, so nothing is rounded away.
 */
export function fmtSetting(seconds: number | null): string {
  const total = whole(seconds);
  if (total === null) return UNKNOWN;
  if (total < 120) return `${total} s`;
  const parts: [number, string][] = [
    [Math.floor(total / 3600), 'h'],
    [Math.floor((total % 3600) / 60), 'min'],
    [total % 60, 's'],
  ];
  return parts
    .filter(([amount]) => amount > 0)
    .map(([amount, unit]) => `${amount} ${unit}`)
    .join(' ');
}

/** Countdown / meter clock: 87 -> "1:27", 3725 -> "1:02:05". Negative / NaN -> "0:00". */
export function fmtClock(seconds: number): string {
  const total = whole(seconds) ?? 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = pad2(total % 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${rest}` : `${minutes}:${rest}`;
}

/**
 * The whole seconds a countdown shows with `remainingMs` left - the one rule for the status bar,
 * the notification and the dashboard. Rounded up, so "0:00" appears exactly when no time is left;
 * every published remainder already lacks a 1 s guard band, so rounding up never shows more time
 * than really remains. Not a number or nothing left -> 0.
 */
export function countdownSeconds(remainingMs: number): number {
  const ms = finite(remainingMs);
  return ms === null || ms <= 0 ? 0 : Math.ceil(ms / 1000);
}

/** Local wall-clock time "HH:MM" (24 h); with seconds when `withSeconds`. Not a time -> "unknown". */
export function fmtTime(epochMs: number, withSeconds?: boolean): string {
  const date = new Date(finite(epochMs) ?? NaN);
  if (!Number.isFinite(date.getTime())) return UNKNOWN;
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${time}:${pad2(date.getSeconds())}` : time;
}

/** Screen-reader form: 87 -> "1 minute 27 seconds". Negative / NaN -> "0 seconds". */
export function fmtSpoken(seconds: number): string {
  const total = whole(seconds) ?? 0;
  const parts: [number, string][] = [
    [Math.floor(total / 3600), 'hour'],
    [Math.floor((total % 3600) / 60), 'minute'],
    [total % 60, 'second'],
  ];
  const spoken = parts.filter(([amount]) => amount > 0).map(([amount, unit]) => plural(amount, unit));
  return spoken.length > 0 ? spoken.join(' ') : '0 seconds';
}

/** "About 7 min": the nearest minute once the seconds stop mattering. */
function fmtAbout(seconds: number): string {
  return fmtDuration(seconds < 120 ? seconds : Math.round(seconds / 60) * 60);
}

/** "02:14", or null when the time is unknown (the sentence then simply leaves it out). */
function timeOf(epochMs: unknown, withSeconds = false): string | null {
  const ms = finite(epochMs);
  if (ms === null) return null;
  const time = fmtTime(ms, withSeconds);
  return time === UNKNOWN ? null : time;
}

function at(time: string | null): string {
  return time === null ? '' : ` at ${time}`;
}

function stamped(title: string, time: string | null): string {
  return time === null ? title : `${title} · ${time}`;
}

// --- checks and lanes --------------------------------------------------------------------------

/** The four "what are we waiting for" groups, in display order. 'none' = not shown in a lane. */
export type Lane = 'claude' | 'you' | 'pc' | 'recheck' | 'none';

type LaneId = Exclude<Lane, 'none'>;

export interface TextContext {
  contract: ArmContract;
  osName: string;
  sessions: readonly Session[];
}

export interface CheckText {
  lane: Lane;
  /** Plain-language name of the check, e.g. "No session working". */
  label: string;
  /** Detail for the check's CURRENT state (passed detail or failed detail). */
  detail: string;
  /** "Pass" | "Waiting" | "Can't tell" | "Problem" */
  stateWord: string;
  /** Setting that tunes this check (gear button), if any. */
  setting: keyof Config | null;
}

interface CheckCopy {
  label: string;
  detail: string;
  /** Short fragment that follows the lane title while the check is unmet; the detail when omitted. */
  line?: string;
}

interface CheckSpec {
  lane: Lane;
  setting: keyof Config | null;
  copy(check: Check, context: TextContext): CheckCopy;
}

const STATE_WORDS: Record<CheckState, string> = {
  pass: 'Pass',
  waiting: 'Waiting',
  cantTell: "Can't tell",
  fail: 'Problem',
};

/** A state this version does not know is never read as a pass. */
function stateWord(state: unknown): string {
  return typeof state === 'string' && Object.hasOwn(STATE_WORDS, state)
    ? STATE_WORDS[state as CheckState]
    : STATE_WORDS.cantTell;
}

function isPass(check: Check): boolean {
  return check.state === 'pass';
}

/** A threshold the check reported, else the one in the contract; null when neither is a number. */
function target(reported: unknown, agreed: unknown): number | null {
  return finite(reported) ?? finite(agreed);
}

function targetText(seconds: number | null): string {
  return seconds === null ? 'long enough' : fmtSetting(seconds);
}

function armedCopy(check: Check): CheckCopy {
  const label = 'Watching is on';
  if (isPass(check)) return { label, detail: 'Yes' };
  return { label, detail: check.state === 'waiting' ? 'Not watching' : "Can't tell whether watching is on" };
}

function stopFileCopy(check: Check): CheckCopy {
  const label = 'No Emergency stop';
  if (isPass(check)) return { label, detail: 'None set' };
  if (check.state === 'fail') {
    return {
      label,
      detail: 'Emergency stop is set. Nothing happens until you delete the STOP file.',
      line: 'Emergency stop is set',
    };
  }
  return {
    label,
    detail: "Can't tell whether Emergency stop is set, so nothing happens.",
    line: "can't tell whether Emergency stop is set",
  };
}

function scannerCopy(check: Check): CheckCopy {
  const label = 'Can see Claude';
  if (isPass(check)) return { label, detail: 'Checked just now' };
  const errors = cleanList(check.data.errors);
  const firstError = errors[0];
  if (check.data.reason === 'noScan') return { label, detail: NOT_CHECKED, line: lowerFirst(NOT_CHECKED) };
  if (check.data.reason === 'stale') {
    return { label, detail: 'The last check is too old to trust', line: 'the last check is too old to trust' };
  }
  if (firstError !== undefined) {
    const problems = errors.length > 1 ? ` (${errors.length} problems)` : '';
    return {
      label,
      detail: `${firstError}${andMore(errors.length - 1)}`,
      line: `couldn't read the session list${problems}`,
    };
  }
  return { label, detail: "Can't tell whether the session list is readable", line: "can't see Claude's sessions" };
}

function helperCopy(check: Check): CheckCopy {
  const label = 'Can check this PC';
  const problem = clean(check.data.problem);
  if (isPass(check)) return { label, detail: problem === null ? 'Helper running' : `Helper running. ${sentence(problem)}` };
  const cause = problem ?? (check.state === 'fail' ? "The helper didn't start" : NO_PROCESS_LIST);
  return { label, detail: `${sentence(cause)} Nothing will be shut down.`, line: "can't check this PC" };
}

function actionAllowedCopy(check: Check, context: TextContext): CheckCopy {
  const action = isPowerAction(check.data.action) ? check.data.action : context.contract.action;
  const copy = copyFor(action);
  const subject = action === 'notify' ? copy.noun : copy.menu;
  const label = `${subject} is available`;
  const detail = clean(check.data.detail);
  if (isPass(check)) {
    const fallback = action === 'notify' ? 'Only a message. Nothing ever turns off.' : `Allowed by ${context.osName}`;
    return { label, detail: detail ?? fallback };
  }
  if (check.state === 'fail') {
    return {
      label,
      detail: detail ?? `${subject} isn't available on this PC`,
      line: `${copy.verb} isn't available on this PC`,
    };
  }
  const cantConfirm = `Can't confirm ${copy.verb} is allowed on this PC.`;
  return {
    label,
    detail: detail === null ? cantConfirm : `${cantConfirm} ${sentence(detail)}`,
    line: `can't confirm ${copy.verb} is allowed`,
  };
}

function remoteWindowsCopy(check: Check): CheckCopy {
  const label = 'No unseen remote sessions';
  if (isPass(check)) {
    const ignored = cleanList(check.data.ignored);
    const covered = cleanList(check.data.covered);
    const parts = [
      ignored.length > 0 ? `Not waiting for: ${listOf(ignored)}` : null,
      covered.length > 0 ? `Covered: ${listOf(covered)}` : null,
    ];
    return { label, detail: joinParts(parts) || 'None' };
  }
  const blocking = cleanList(check.data.blocking);
  if (blocking.length === 0) {
    return {
      label,
      detail: "Can't tell whether a VS Code window is connected to another machine, so I wait.",
      line: "can't tell whether a remote window is open",
    };
  }
  const where = listOf(blocking);
  const windows = blocking.length > 1 ? 'VS Code windows are' : 'A VS Code window is';
  return {
    label,
    detail: `${windows} connected to ${where}. Claude sessions there can't be seen from here.`,
    line: `can't see Claude sessions in ${where}`,
  };
}

function registryCopy(check: Check): CheckCopy {
  const label = 'Every Claude process accounted for';
  if (isPass(check)) {
    const strays = whole(check.data.strays) ?? 0;
    if (strays === 0) return { label, detail: 'All matched' };
    // A passing check with strays means each one is either still busy in a transcript we watch, or
    // waived by the user - say both, not just the first.
    return { label, detail: `${plural(strays, 'extra process', 'extra processes')} accounted for or not waited for` };
  }
  if (check.data.reason === 'noProcessList') return { label, detail: NO_PROCESS_LIST, line: lowerFirst(NO_PROCESS_LIST) };
  const pids = wholeList(check.data.pids);
  if (pids.length > 1) {
    const some = `${pids.length} Claude processes`;
    return {
      label,
      detail: `${some} (PIDs ${listOf(pids.map(String))}) can't be matched to a session. Staying on until they exit, or until you choose "Don't wait for it" for each.`,
      line: `${some} can't be matched to a session`,
    };
  }
  if (pids.length === 1 || check.data.reason === 'unaccounted') {
    const pid = pids[0] === undefined ? '' : ` (PID ${pids[0]})`;
    return {
      label,
      detail: `A Claude process${pid} can't be matched to a session. Staying on until it exits, or until you choose "Don't wait for it".`,
      line: "a Claude process can't be matched to a session",
    };
  }
  return { label, detail: NOT_CHECKED, line: lowerFirst(NOT_CHECKED) };
}

function unclaimedTranscriptsCopy(check: Check, context: TextContext): CheckCopy {
  const label = 'No stray transcript activity';
  if (isPass(check)) return { label, detail: 'None' };
  if (check.state !== 'waiting') return { label, detail: NOT_CHECKED, line: lowerFirst(NOT_CHECKED) };
  const project = clean(check.data.project);
  const secondsAgo = finite(check.data.secondsAgo);
  const count = whole(check.data.count) ?? 1;
  const where = project === null ? '' : ` in ${project}`;
  const when = secondsAgo === null ? 'recently' : `${fmtDuration(secondsAgo)} ago`;
  const more = count > 1 ? ` (+${count - 1} more like it)` : '';
  const quiet = targetText(target(check.data.quietSeconds, context.contract.quietSeconds));
  const stray = `A Claude transcript${where} changed ${when} and no running session owns it${more}.`;
  return {
    label,
    detail: `${stray} Waiting until it has been quiet ${quiet}.`,
    line: `a transcript${where} changed ${when}`,
  };
}

function hasSessionsCopy(check: Check, context: TextContext): CheckCopy {
  const label = 'A session was seen';
  const sawAny = check.data.sawAny === true;
  const sinceLast = finite(check.data.secondsSinceLast);
  if (isPass(check)) {
    const ended = sawAny && sinceLast !== null;
    return { label, detail: ended ? `Last one ended ${fmtDuration(sinceLast)} ago` : 'Not required' };
  }
  if (check.data.sawAny === false) {
    return {
      label,
      detail: 'No Claude session yet. I wait for one to appear and finish.',
      line: 'no Claude session yet',
    };
  }
  if (!sawAny) {
    return {
      label,
      detail: "Can't tell whether a Claude session was seen, so I wait.",
      line: "can't tell whether a session was seen",
    };
  }
  if (sinceLast === null) {
    return {
      label,
      detail: "Can't tell when the last session ended, so I wait.",
      line: "can't tell when the last session ended",
    };
  }
  const quiet = targetText(target(check.data.quietSeconds, context.contract.quietSeconds));
  const waiting = `ended ${fmtDuration(sinceLast)} ago; waiting ${quiet}`;
  return { label, detail: `The last session ${waiting}.`, line: `the last session ${waiting}` };
}

interface SessionCounts {
  /** null = no session list and no count from the check. */
  total: number | null;
  working: number;
  /** Working sessions Claude Code reports as waiting for the user's answer (counted apart). */
  needsAnswer: number;
  justFinished: number;
  cantTell: number;
  ignored: number;
}

/** A session keeps this PC on unless it is known to be finished or the user stopped waiting for it. */
function isBlocking(session: Session): boolean {
  return session.working !== false && session.ignored !== true;
}

/**
 * The session list splits the blockers by status, which the check's own counts do not ("Just
 * finished" is counted as working there). The check's numbers stand whenever the list is missing
 * or is not the list the check was computed from.
 */
function sessionCounts(check: Check, context: TextContext): SessionCounts {
  const sessions = context.sessions;
  const reported = whole(check.data.total);
  if (sessions.length === 0 || (reported !== null && reported !== sessions.length)) {
    return {
      total: reported,
      working: whole(check.data.working) ?? 0,
      needsAnswer: 0,
      justFinished: 0,
      cantTell: whole(check.data.cantTell) ?? 0,
      ignored: whole(check.data.ignored) ?? 0,
    };
  }
  const blocking = sessions.filter(isBlocking);
  const justFinished = blocking.filter((session) => session.status === 'justFinished').length;
  const working = blocking.filter((session) => session.status === 'working');
  // "Still working" would be wrong for these: nothing happens until the user answers.
  const needsAnswer = working.filter((session) => session.turn === 'OPEN' && session.turnReason === 'claudeWaiting').length;
  return {
    total: sessions.length,
    working: working.length - needsAnswer,
    needsAnswer,
    justFinished,
    // Anything that blocks without a known status is a "can't tell", not a guess.
    cantTell: blocking.length - working.length - justFinished,
    ignored: sessions.filter((session) => session.ignored === true).length,
  };
}

function finishedText({ total, ignored }: SessionCounts): string {
  if (total === null) return 'All finished';
  if (total === 0) return 'No session running';
  if (ignored > 0) return `${Math.max(0, total - ignored)} of ${total} finished (${ignored} not waited for)`;
  if (total === 1) return 'The only session finished';
  return total === 2 ? 'Both finished' : `All ${total} finished`;
}

/** "2 of 3 still working · 1 can't tell": only the first part carries the total. */
function blockingText({ total, working, needsAnswer, justFinished, cantTell }: SessionCounts): string {
  const ofTotal = total === null ? '' : ` of ${total}`;
  const parts: string[] = [];
  if (working > 0) parts.push(`${working}${ofTotal} still working`);
  if (needsAnswer > 0) {
    parts.push(`${needsAnswer}${parts.length === 0 ? ofTotal : ''} ${needsAnswer === 1 ? 'needs' : 'need'} your answer`);
  }
  if (justFinished > 0) parts.push(`${justFinished}${parts.length === 0 ? ofTotal : ''} just finished`);
  if (cantTell > 0) parts.push(parts.length === 0 ? `can't tell about ${cantTell}${ofTotal}` : `${cantTell} can't tell`);
  return parts.join(' · ');
}

function sessionsIdleCopy(check: Check, context: TextContext): CheckCopy {
  const label = 'No session working';
  const counts = sessionCounts(check, context);
  if (isPass(check)) return { label, detail: finishedText(counts) };
  const line = blockingText(counts);
  if (line === '') return { label, detail: NOT_CHECKED, line: lowerFirst(NOT_CHECKED) };
  return { label, detail: capitalize(line), line };
}

function turnsClosedCopy(check: Check): CheckCopy {
  const label = 'Every turn ended';
  if (isPass(check)) return { label, detail: 'All ended' };
  const names: unknown[] = Array.isArray(check.data.names) ? check.data.names : [];
  const reasons: unknown[] = Array.isArray(check.data.reasons) ? check.data.reasons : [];
  if (names.length === 0) return { label, detail: NOT_CHECKED, line: lowerFirst(NOT_CHECKED) };
  const name = clean(names[0]) ?? 'A session';
  const reason = clean(reasons[0]);
  const why = reason === null ? STATE_WORDS.cantTell : turnReasonWords(reason, null);
  return { label, detail: `${name}: ${why}${andMore(names.length - 1)}` };
}

function quietCopy(check: Check, context: TextContext): CheckCopy {
  const quietSeconds = target(check.data.quietSeconds, context.contract.quietSeconds);
  const label = `Quiet for ${targetText(quietSeconds)}`;
  const quietest = finite(check.data.quietestSeconds);
  const name = clean(check.data.name);
  const who = name === null ? '' : ` (${name})`;
  if (isPass(check)) {
    return { label, detail: quietest === null ? 'Quiet long enough' : `Quietest: ${fmtDuration(quietest)}${who}` };
  }
  if (quietest !== null && quietSeconds === null) {
    const soFar = `${fmtDuration(quietest)}${who}, but can't tell how long is required`;
    return { label, detail: `Quiet ${soFar}`, line: `quiet ${soFar}` };
  }
  if (check.state !== 'waiting' || quietest === null || quietSeconds === null) {
    const subject = name === null ? 'the sessions have' : `${name} has`;
    return {
      label,
      detail: `Can't tell how long ${subject} been quiet`,
      line: `can't tell how long ${subject} been quiet`,
    };
  }
  const progress = `${fmtClock(quietest)} of ${fmtClock(quietSeconds)}${who}`;
  return { label, detail: `Quiet ${progress}`, line: `quiet ${progress}` };
}

function childProcessesCopy(check: Check): CheckCopy {
  const label = 'No command still running';
  if (isPass(check)) return { label, detail: 'None' };
  const items = cleanList(check.data.items);
  const first = items[0];
  if (first !== undefined) return { label, detail: `${first}${andMore(items.length - 1)}` };
  const running = 'a command started by a session is still running';
  const line = check.state === 'waiting' ? running : `can't tell whether ${running}`;
  return { label, detail: capitalize(line), line };
}

function userIdleCopy(check: Check, context: TextContext): CheckCopy {
  const required = target(check.data.userIdleSeconds, context.contract.userIdleSeconds);
  const label = `You've been away ${targetText(required)}`;
  const idle = finite(check.data.idleSeconds);
  if (isPass(check)) return { label, detail: idle === null ? 'Away long enough' : `Away ${fmtDuration(idle)}` };
  if (idle !== null && required === null) {
    const soFar = `${fmtDuration(idle)}, but can't tell how long is required`;
    return { label, detail: `Away ${soFar}`, line: `away ${soFar}` };
  }
  if (check.state !== 'waiting' || idle === null || required === null) {
    return {
      label,
      detail: 'Can\'t tell whether you\'re away, so I wait. Turn off "Require me to be away" to skip this.',
      line: "can't tell whether you're away",
    };
  }
  const progress = `${fmtClock(idle)} of ${fmtClock(required)}`;
  return { label, detail: `You're here. Away ${progress}`, line: `away ${progress}` };
}

function guardCopy(check: Check): CheckCopy {
  const label = 'Nothing on your keep-on list';
  if (isPass(check)) return { label, detail: 'None running' };
  const hits = cleanList(check.data.hits);
  if (hits.length > 0) {
    return { label, detail: `${listOf(hits)} ${hits.length === 1 ? 'is' : 'are'} running (keep-on list)` };
  }
  if (check.state === 'waiting') {
    return {
      label,
      detail: 'Something on your keep-on list is running',
      line: 'something on your keep-on list is running',
    };
  }
  return { label, detail: NO_PROCESS_LIST, line: lowerFirst(NO_PROCESS_LIST) };
}

function confirmedCopy(check: Check, context: TextContext): CheckCopy {
  const required = target(check.data.n, context.contract.requiredPolls);
  const label = required === null ? 'Stayed that way' : `Stayed that way ${required}×`;
  const agreed = whole(check.data.k);
  if (check.state === 'cantTell' || agreed === null || required === null) {
    return { label, detail: STATE_WORDS.cantTell, line: "can't tell" };
  }
  return { label, detail: `${agreed} of ${required}`, line: `${agreed} of ${required} in a row` };
}

const CHECKS: Record<CheckId, CheckSpec> = {
  armed: { lane: 'none', setting: null, copy: armedCopy },
  stopFile: { lane: 'pc', setting: null, copy: stopFileCopy },
  scanner: { lane: 'pc', setting: null, copy: scannerCopy },
  helper: { lane: 'pc', setting: null, copy: helperCopy },
  actionAllowed: { lane: 'pc', setting: 'action', copy: actionAllowedCopy },
  remoteWindows: { lane: 'claude', setting: null, copy: remoteWindowsCopy },
  registry: { lane: 'claude', setting: null, copy: registryCopy },
  unclaimedTranscripts: { lane: 'claude', setting: 'quietSeconds', copy: unclaimedTranscriptsCopy },
  hasSessions: { lane: 'claude', setting: 'allowWhenNoSessions', copy: hasSessionsCopy },
  sessionsIdle: { lane: 'claude', setting: 'quietSeconds', copy: sessionsIdleCopy },
  turnsClosed: { lane: 'claude', setting: null, copy: turnsClosedCopy },
  quiet: { lane: 'claude', setting: 'quietSeconds', copy: quietCopy },
  childProcesses: { lane: 'claude', setting: 'waitForChildProcesses', copy: childProcessesCopy },
  userIdle: { lane: 'you', setting: 'userIdleSeconds', copy: userIdleCopy },
  guard: { lane: 'pc', setting: 'guardProcesses', copy: guardCopy },
  confirmed: { lane: 'recheck', setting: 'requiredPolls', copy: confirmedCopy },
};

/**
 * When a lane has several unmet checks of the same severity, the one named first here gives the
 * lane its one line: the cause ("2 of 3 still working") before its consequences ("quiet 0:18").
 */
const LINE_PRIORITY: readonly CheckId[] = [
  'stopFile',
  'helper',
  'scanner',
  'actionAllowed',
  'guard',
  'sessionsIdle',
  'turnsClosed',
  'registry',
  'remoteWindows',
  'childProcesses',
  'unclaimedTranscripts',
  'hasSessions',
  'quiet',
  'userIdle',
  'confirmed',
];

function specOf(id: unknown): CheckSpec | null {
  return typeof id === 'string' && Object.hasOwn(CHECKS, id) ? CHECKS[id as CheckId] : null;
}

/** Raw data of a check this version does not know, with unknown values spelled out. */
function rawData(data: CheckData): string {
  const text = JSON.stringify(data, (_key, value: unknown) =>
    value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? UNKNOWN : value,
  );
  return clean(text, 300) ?? '';
}

function normalCheck(check: Check): Check {
  return { id: check.id, state: check.state, data: isRecord(check.data) ? (check.data as CheckData) : {} };
}

/** The entries that are at least objects; their fields are still read one by one. */
function sessionList(value: unknown): Session[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  return items.filter(isRecord) as unknown as Session[];
}

function normalContext(context: TextContext): TextContext {
  return {
    contract: asContract(context.contract),
    osName: clean(context.osName) ?? 'the operating system',
    sessions: sessionList(context.sessions),
  };
}

function contextOf(state: UiState): TextContext {
  return normalContext({
    contract: state.contract,
    osName: isRecord(state.platform) ? state.platform.osName : '',
    sessions: state.sessions,
  });
}

function checksOf(state: UiState): Check[] {
  const checks: unknown[] = Array.isArray(state.checks) ? state.checks : [];
  return checks.filter(isRecord).map((check) => normalCheck(check as unknown as Check));
}

function checkText(check: Check, context: TextContext): CheckText {
  const spec = specOf(check.id);
  if (spec === null) {
    return {
      lane: 'pc',
      label: clean(check.id) ?? 'Unnamed check',
      detail: rawData(check.data),
      stateWord: stateWord(check.state),
      setting: null,
    };
  }
  const { label, detail } = spec.copy(check, context);
  return { lane: spec.lane, label, detail, stateWord: stateWord(check.state), setting: spec.setting };
}

/** Unknown check ids print verbatim (label = id, detail = JSON of data) in the 'pc' lane. */
export function describeCheck(check: Check, context: TextContext): CheckText {
  return checkText(normalCheck(check), normalContext(context));
}

export interface LaneSummary {
  lane: Exclude<Lane, 'none'>;
  /** "Claude" | "You" | "This PC" | "Re-check" */
  title: string;
  /** Worst state among the lane's unmet checks. */
  state: 'waiting' | 'cantTell' | 'fail';
  /** One line with `value of target`, e.g. "2 of 3 still working", "away 0:04 of 10:00". */
  text: string;
  /** Extra line, e.g. "web-ui: nothing written for 1 h 12 min"; null when there is none. */
  sub: string | null;
  /** For a meter, when the lane is a pure timer. */
  progress: { value: number; max: number; valueText: string } | null;
  /** The lane's unmet checks (expanded view). */
  unmet: Check[];
}

type UnmetState = LaneSummary['state'];
type Meter = NonNullable<LaneSummary['progress']>;

const LANE_ORDER: readonly LaneId[] = ['claude', 'you', 'pc', 'recheck'];

const LANE_TITLES: Record<LaneId, string> = { claude: 'Claude', you: 'You', pc: 'This PC', recheck: 'Re-check' };

const LANE_PHRASES: Record<LaneId, string> = {
  claude: 'Claude',
  you: 'you to step away',
  pc: 'something on this PC',
  recheck: 'a final re-check',
};

const LANE_SETTINGS: Record<LaneId, keyof Config> = {
  claude: 'quietSeconds',
  you: 'userIdleSeconds',
  pc: 'guardProcesses',
  recheck: 'requiredPolls',
};

const SEVERITY: Record<UnmetState, number> = { waiting: 0, cantTell: 1, fail: 2 };

/** The setting the gear on an expanded lane opens. */
export function laneSetting(lane: Exclude<Lane, 'none'>): keyof Config {
  return LANE_SETTINGS[lane];
}

/** Whatever is not a pass, a wait or a failure - including a state from another version - blocks as "can't tell". */
function unmetState(state: unknown): UnmetState {
  return state === 'waiting' || state === 'fail' ? state : 'cantTell';
}

function worstState(checks: readonly Check[]): UnmetState {
  return checks.reduce<UnmetState>((worst, check) => {
    const state = unmetState(check.state);
    return SEVERITY[state] > SEVERITY[worst] ? state : worst;
  }, 'waiting');
}

function linePriority(check: Check): number {
  const index = LINE_PRIORITY.indexOf(check.id);
  return index === -1 ? LINE_PRIORITY.length : index;
}

/** The check that speaks for a lane: the most severe one, then the cause before its consequences. */
function leadingCheck(checks: readonly Check[]): Check | undefined {
  return [...checks].sort(
    (a, b) => SEVERITY[unmetState(b.state)] - SEVERITY[unmetState(a.state)] || linePriority(a) - linePriority(b),
  )[0];
}

function laneLine(check: Check, context: TextContext): string {
  const spec = specOf(check.id);
  if (spec === null) return checkText(check, context).label;
  const copy = spec.copy(check, context);
  return copy.line ?? copy.detail;
}

function meter(value: unknown, max: number | null, word: string): Meter | null {
  const elapsed = finite(value);
  if (elapsed === null || max === null || max <= 0) return null;
  const shown = Math.min(Math.max(0, elapsed), max);
  return { value: shown, max, valueText: `${word} ${fmtSpoken(shown)} of ${fmtSpoken(max)}` };
}

/** The check as a meter when it is nothing but a clock running towards a known target. */
function meterOf(check: Check, context: TextContext): Meter | null {
  if (check.state !== 'waiting') return null;
  const { data } = check;
  const { contract } = context;
  switch (check.id) {
    case 'quiet':
      return meter(data.quietestSeconds, target(data.quietSeconds, contract.quietSeconds), 'Quiet');
    case 'unclaimedTranscripts':
      return meter(data.secondsAgo, target(data.quietSeconds, contract.quietSeconds), 'Quiet');
    case 'hasSessions':
      return data.sawAny === true
        ? meter(data.secondsSinceLast, target(data.quietSeconds, contract.quietSeconds), 'Quiet')
        : null;
    case 'userIdle':
      return meter(data.idleSeconds, target(data.userIdleSeconds, contract.userIdleSeconds), 'Away');
    case 'confirmed': {
      const agreed = whole(data.k);
      const required = target(data.n, contract.requiredPolls);
      if (agreed === null || required === null || required <= 0) return null;
      return { value: Math.min(agreed, required), max: required, valueText: `Check ${agreed} of ${required} passed` };
    }
    default:
      return null;
  }
}

/** `sessionsIdle` held up only by sessions that already ended their turn: the quiet clock says it all. */
function isOnlyQuietTime(check: Check, context: TextContext): boolean {
  if (check.id !== 'sessionsIdle' || check.state !== 'waiting') return false;
  const counts = sessionCounts(check, context);
  return counts.justFinished > 0 && counts.working === 0 && counts.needsAnswer === 0 && counts.cantTell === 0;
}

/**
 * A lane is a pure timer when every unmet check in it is a running clock. The clock with the most
 * time left is the one the user is really waiting for.
 */
function laneTimer(unmet: readonly Check[], context: TextContext): { check: Check; meter: Meter } | null {
  let slowest: { check: Check; meter: Meter } | null = null;
  for (const check of unmet) {
    if (isOnlyQuietTime(check, context)) continue;
    const clock = meterOf(check, context);
    if (clock === null) return null;
    if (slowest === null || clock.max - clock.value > slowest.meter.max - slowest.meter.value) {
      slowest = { check, meter: clock };
    }
  }
  return slowest;
}

/** Blocking on a turn that never closed, with no subagent at work and nothing written for a long time. */
function isStuck(session: Session, silenceSeconds: number | null): boolean {
  return (
    isBlocking(session) &&
    session.turn !== 'CLOSED' &&
    (whole(session.activeSubagents) ?? 0) === 0 &&
    silenceSeconds !== null &&
    silenceSeconds > STUCK_AFTER_SECONDS
  );
}

/** The blocking session that has written nothing for the longest: the likely abandoned one. */
function stuckLine(sessions: readonly Session[]): string | null {
  let longest: { name: string; silence: number } | null = null;
  for (const session of sessions) {
    const silence = finite(session.silenceSeconds);
    if (silence === null || !isStuck(session, silence)) continue;
    if (longest === null || silence > longest.silence) longest = { name: clean(session.name) ?? 'A session', silence };
  }
  return longest === null ? null : `${longest.name}: nothing written for ${fmtDuration(longest.silence)}`;
}

function summarizeLane(lane: LaneId, unmet: Check[], context: TextContext): LaneSummary {
  const timer = laneTimer(unmet, context);
  const speaker = timer?.check ?? leadingCheck(unmet);
  return {
    lane,
    title: LANE_TITLES[lane],
    state: worstState(unmet),
    text: speaker === undefined ? '' : laneLine(speaker, context),
    sub: lane === 'claude' ? stuckLine(context.sessions) : null,
    progress: timer?.meter ?? null,
    unmet,
  };
}

/**
 * Unmet lanes in fixed order (Claude, You, This PC, Re-check). Excludes the `armed` check.
 * The Re-check lane appears only once every other lane is clear: until then "0 of 3" is a
 * consequence of the other lanes, not something of its own to wait for.
 */
export function unmetLanes(state: UiState): LaneSummary[] {
  const context = contextOf(state);
  const byLane = new Map<LaneId, Check[]>();
  for (const check of checksOf(state)) {
    if (isPass(check)) continue;
    const lane = specOf(check.id)?.lane ?? 'pc';
    if (lane === 'none') continue;
    byLane.set(lane, [...(byLane.get(lane) ?? []), check]);
  }
  if (byLane.size > 1) byLane.delete('recheck');
  return LANE_ORDER.flatMap((lane) => {
    const unmet = byLane.get(lane);
    return unmet === undefined ? [] : [summarizeLane(lane, unmet, context)];
  });
}

/** "Still on: waiting for Claude, and for you to step away." '' when nothing is unmet. */
export function headline(state: UiState): string {
  const phrases = unmetLanes(state).map((lane) => LANE_PHRASES[lane.lane]);
  const last = phrases.pop();
  if (last === undefined) return '';
  if (phrases.length === 0) return `Still on: waiting for ${last}.`;
  return `Still on: waiting for ${phrases.join(', for ')}, and for ${last}.`;
}

// --- sessions ----------------------------------------------------------------------------------

const TURN_REASONS: Record<TurnReason, string> = {
  turnEnded: 'Turn ended',
  interrupted: 'Interrupted',
  toolDeclined: 'Stopped after a declined permission',
  localCommand: 'Ran a local command',
  claudeIdle: 'Idle, says Claude Code',
  claudeShell: 'Idle with a background command, says Claude Code',
  claudeWaiting: 'Needs your answer',
  claudeBusy: 'Busy, says Claude Code',
  claudeStatusUnknown: 'Unknown status from Claude Code',
  toolInFlight: 'Running a tool',
  cutAtTokenLimit: 'Reply cut off at the token limit',
  replyInProgress: 'Writing a reply',
  readingToolResult: 'Reading a tool result',
  thinking: 'Thinking',
  compacting: 'Compacting context',
  recordBeingWritten: 'Writing to the transcript',
  unknownRecord: 'Unrecognised transcript record',
  noTranscript: 'No transcript found',
  cannotRead: "Couldn't read the transcript",
  noConversationRecord: 'No conversation in the transcript yet',
  ambiguousTranscripts: 'Several transcripts changed at once',
};

/** Reasons whose raw detail (a record type, an OS error) says something the wording does not. */
const REASONS_SHOWING_DETAIL: ReadonlySet<string> = new Set<TurnReason>([
  'unknownRecord',
  'cannotRead',
  'claudeWaiting',
  'claudeStatusUnknown',
]);

/** A reason this version does not know prints verbatim. */
function turnReasonWords(reason: unknown, detail: unknown): string {
  const extra = clean(detail);
  if (typeof reason !== 'string' || !Object.hasOwn(TURN_REASONS, reason)) {
    return joinParts([clean(reason) ?? STATE_WORDS.cantTell, extra === null ? null : `(${extra})`], ' ');
  }
  const words = TURN_REASONS[reason as TurnReason];
  return extra !== null && REASONS_SHOWING_DETAIL.has(reason) ? `${words} (${extra})` : words;
}

/** "Running a tool", "Reading a tool result", "Compacting context", "Turn ended", ... */
export function turnReasonText(reason: TurnReason, detail: string | null): string {
  return turnReasonWords(reason, detail);
}

export interface SessionText {
  /** "Working" | "Just finished" | "Finished" | "Can't tell" | "Not waited for" (ignored) */
  status: string;
  /** Second line of the row, e.g. "Running a tool · last wrote 18 s ago · 2 subagents active". */
  line: string;
  /** Stuck hint ("Nothing written for 47 min. May be waiting for your approval, ..."), else null. */
  hint: string | null;
  /** Raw truth for the tooltip: "{engine reason} · turn OPEN · PID 9120". */
  tooltip: string;
  /** Offer "Don't wait for this session" on this row. */
  canIgnore: boolean;
}

const STATUS_WORDS: Record<SessionStatus, string> = {
  working: 'Working',
  justFinished: 'Just finished',
  finished: 'Finished',
  cantTell: "Can't tell",
};

const TURN_STATES: readonly string[] = ['CLOSED', 'OPEN', 'UNKNOWN'];

function statusWord(session: Session): string {
  if (session.ignored === true) return 'Not waited for';
  return Object.hasOwn(STATUS_WORDS, session.status) ? STATUS_WORDS[session.status] : STATUS_WORDS.cantTell;
}

function lastWrote(silenceSeconds: number | null): string | null {
  return silenceSeconds === null ? null : `last wrote ${fmtDuration(silenceSeconds)} ago`;
}

function activeSubagents(count: unknown): string | null {
  const active = whole(count) ?? 0;
  return active > 0 ? `${plural(active, 'subagent')} active` : null;
}

function sessionLine(session: Session, quietSeconds: number, silenceSeconds: number | null): string {
  const turn = turnReasonWords(session.turnReason, session.turnDetail);
  const why = isRecord(session.why) ? session.why : { id: undefined };
  switch (why.id) {
    case 'turnUnknown':
      return `${sentence(turn)} Counted as working.`;
    case 'silenceUnknown':
      return "Can't tell when it last wrote. Counted as working.";
    case 'subagentsActive': {
      const subagents = activeSubagents(why.count) ?? activeSubagents(session.activeSubagents);
      return joinParts([turn, subagents, lastWrote(silenceSeconds)]);
    }
    case 'childBusy': {
      const pid = whole(why.pid);
      const child = `${clean(why.name) ?? 'A command'}${pid === null ? '' : ` (PID ${pid})`}`;
      return joinParts([turn, `${child} is still running`]);
    }
    case 'scheduledWakeup': {
      // Covers both /loop forms (ScheduleWakeup and a CronCreate task); 0 also means "time unknown".
      const delay = finite(why.inSeconds);
      return joinParts([turn, delay === null || delay <= 0 ? 'a scheduled run is pending' : `next scheduled run in ${fmtDuration(delay)}`]);
    }
    case 'recentWrite': {
      const quiet = finite(quietSeconds);
      if (silenceSeconds === null || quiet === null) return joinParts([turn, "can't tell how long it has been quiet"]);
      return `Quiet ${fmtClock(silenceSeconds)} of ${fmtClock(quiet)}`;
    }
    case 'quiet':
      return joinParts([turn, silenceSeconds === null ? null : `quiet ${fmtDuration(silenceSeconds)}`]);
    default:
      return joinParts([turn, lastWrote(silenceSeconds), activeSubagents(session.activeSubagents)]);
  }
}

function stuckHint(session: Session, silenceSeconds: number | null): string | null {
  if (session.turn !== 'OPEN' || !isStuck(session, silenceSeconds)) return null;
  const quiet = `Nothing written for ${fmtDuration(silenceSeconds)}`;
  // Claude Code's own status says why the session is silent: no need to guess.
  if (session.turnReason === 'claudeWaiting') {
    const what = clean(session.waitingFor) ?? clean(session.turnDetail);
    return `Needs your answer${what === null ? '' : ` (${what})`}. ${quiet}.`;
  }
  if (session.turnReason === 'claudeBusy') return `${quiet}, but Claude Code says it is still busy.`;
  return `${quiet}. May be waiting for your approval, or was interrupted.`;
}

function sessionTooltip(session: Session): string {
  const detail = clean(session.turnDetail);
  const reason = `${clean(session.turnReason) ?? UNKNOWN}${detail === null ? '' : ` (${detail})`}`;
  const turn = TURN_STATES.includes(session.turn) ? session.turn : 'UNKNOWN';
  const pid = whole(session.pid);
  return joinParts([reason, `turn ${turn}`, pid === null ? null : `PID ${pid}`, claudeStatusText(session)]);
}

/** "Claude Code: idle since 14:03"; null when Claude Code gave no status (or an older window sent none). */
function claudeStatusText(session: Session): string | null {
  const status = clean(session.claudeStatus, 32);
  if (status === null) return null;
  const since = finite(session.claudeStatusSinceMs);
  // The status was there but could not be checked (or was stale): the transcript decided.
  const note = session.turnSource === 'transcript' ? ', judged by the transcript' : '';
  return `Claude Code: ${status}${since === null ? '' : ` since ${fmtTime(since)}`}${note}`;
}

/**
 * The override is offered only where fail-closed would otherwise block for good: a session we
 * can't read, or a working one that has gone silent. It needs a key the leader will accept.
 */
function canIgnoreSession(session: Session, silenceSeconds: number | null): boolean {
  if (session.ignored === true) return false;
  if (typeof session.ignoreKey !== 'string' || !session.ignoreKey.startsWith('session:')) return false;
  if (session.status === 'cantTell') return true;
  return session.status === 'working' && silenceSeconds !== null && silenceSeconds > STUCK_AFTER_SECONDS;
}

/** `silenceSeconds` = the session's silence right now (scan value + time since the scan). */
export function describeSession(session: Session, quietSeconds: number, silenceSeconds: number | null): SessionText {
  const silence = finite(silenceSeconds);
  const ignored = session.ignored === true;
  return {
    status: statusWord(session),
    line: ignored ? 'Until it writes again' : sessionLine(session, quietSeconds, silence),
    hint: stuckHint(session, silence),
    tooltip: sessionTooltip(session),
    canIgnore: canIgnoreSession(session, silence),
  };
}

// --- plan, results, cancel reasons -------------------------------------------------------------

/** "About 7 min after the last session finishes, once you've been away 10 min." */
export function timingLine(contract: ArmContract): string {
  const rules = asContract(contract);
  const quiet = finite(rules.quietSeconds);
  const polls = finite(rules.requiredPolls);
  const poll = finite(rules.pollSeconds);
  // "Just notify me" has no countdown: the message comes as soon as the re-checks agree.
  const countdown = rules.action === 'notify' ? 0 : finite(rules.countdownSeconds);
  const known = quiet !== null && polls !== null && poll !== null && countdown !== null;
  const after = known
    ? `About ${fmtAbout(quiet + polls * poll + countdown)} after the last session finishes`
    : 'Some time after the last session finishes';
  if (rules.requireUserIdle === false) return `${after}. You don't need to be away.`;
  return `${after}, once you've been away ${targetText(finite(rules.userIdleSeconds))}.`;
}

/**
 * What the rules do when no Claude session ever appears: "No Claude session needed: with your
 * settings this PC can shut down even if none ever appears. About 2 min after you start, …".
 * null only when they explicitly make this PC wait for a session to appear and finish - any other
 * reading is the one in which this PC may act.
 */
export function noSessionNeededText(contract: ArmContract): string | null {
  const rules = asContract(contract);
  if (rules.allowWhenNoSessions === false) return null;
  const outcome =
    rules.action !== 'notify' && isTestRun(rules)
      ? 'this test run can pass'
      : `this PC can ${infinitive(copyFor(rules.action))}`;
  const polls = finite(rules.requiredPolls);
  const poll = finite(rules.pollSeconds);
  const countdown = rules.action === 'notify' ? 0 : finite(rules.countdownSeconds);
  const after =
    polls !== null && poll !== null && countdown !== null
      ? `About ${fmtAbout(polls * poll + countdown)} after you start`
      : 'Some time after you start';
  const away =
    rules.requireUserIdle === false
      ? `${after}. You don't need to be away.`
      : `${after}, once you've been away ${targetText(finite(rules.userIdleSeconds))}.`;
  return `No Claude session needed: with your settings ${outcome} even if none ever appears. ${away}`;
}

/** "Start test run" | "Shut down when Claude finishes…" | "Notify me when Claude finishes" */
export function startLabel(contract: ArmContract): string {
  const rules = asContract(contract);
  if (rules.action === 'notify') return 'Notify me when Claude finishes';
  if (isTestRun(rules)) return 'Start test run';
  return `${copyFor(rules.action).menu} when Claude finishes…`;
}

/** The check's name without its numbers, for a sentence that has no contract at hand. */
const CHECK_NAMES: Record<CheckId, string> = {
  armed: 'Watching is on',
  stopFile: 'No Emergency stop',
  scanner: 'Can see Claude',
  helper: 'Can check this PC',
  actionAllowed: 'The action is available',
  remoteWindows: 'No unseen remote sessions',
  registry: 'Every Claude process accounted for',
  unclaimedTranscripts: 'No stray transcript activity',
  hasSessions: 'A session was seen',
  sessionsIdle: 'No session working',
  turnsClosed: 'Every turn ended',
  quiet: 'Every session quiet',
  childProcesses: 'No command still running',
  userIdle: "You've been away",
  guard: 'Nothing on your keep-on list',
  confirmed: 'Stayed that way',
};

function checkName(id: unknown): string {
  if (typeof id === 'string' && Object.hasOwn(CHECK_NAMES, id)) return CHECK_NAMES[id as CheckId];
  return clean(id) ?? 'an unnamed check';
}

/** "You pressed Esc", "web-ui went back to work", "This PC slept and woke up", ... */
export function cancelReasonText(reason: CancelReason): string {
  switch (reason.id) {
    case 'user':
      return reason.via === 'esc' ? 'You pressed Esc' : 'You cancelled';
    case 'userCameBack':
      return 'You came back';
    case 'sessionResumed':
      return `${clean(reason.name) ?? 'A session'} went back to work`;
    case 'checkFailed':
      return `A check stopped passing: ${checkName(reason.check)}`;
    case 'settingsChanged':
      return 'A setting changed';
    case 'timeJump':
      return 'This PC slept and woke up';
    case 'leaderChanged':
      return 'Another window took over';
    case 'emergencyStop':
      return 'Emergency stop was set';
    case 'stoppedWatching':
      return 'You stopped watching';
    case 'scanStale':
      return 'The last check became too old to trust';
    default:
      return 'The countdown was cancelled';
  }
}

export interface ResultText {
  /** e.g. "TEST RUN PASSED · 02:14" (the UI upper-cases nothing itself). */
  title: string;
  /** Body sentences, one per array entry. */
  body: string[];
  /** One-line form for notifications / the log. */
  oneLine: string;
  tone: 'ok' | 'neutral' | 'error';
}

type ResultOf<K extends LastResult['kind']> = Extract<LastResult, { kind: K }>;

function milestone(epochMs: unknown, what: string): string | null {
  const time = timeOf(epochMs);
  return time === null ? null : `${time} ${what}`;
}

function heldUpLine(heldUpBy: unknown): string | null {
  if (!isRecord(heldUpBy)) return null;
  const name = clean(heldUpBy.name);
  if (name === null) return null;
  const seconds = finite(heldUpBy.seconds);
  return `Held up longest by: ${name}${seconds === null ? '' : `, ${fmtDuration(seconds)}`}`;
}

function testPassedText(result: ResultOf<'testPassed'>): ResultText {
  const copy = copyFor(result.action);
  const time = timeOf(result.atMs);
  const milestones = joinParts([
    milestone(result.armedAtMs, 'started'),
    milestone(result.lastSessionFinishedAtMs, 'last session finished'),
    milestone(result.allClearAtMs, 'all clear'),
  ]);
  return {
    title: stamped('TEST RUN PASSED', time),
    body: [
      `${time === null ? 'This PC' : `At ${time} this PC`} ${copy.wouldHave}. Nothing was turned off.`,
      milestones,
      heldUpLine(result.heldUpBy) ?? '',
      NOT_WATCHING,
    ].filter((line) => line !== ''),
    oneLine: `Test run passed. This PC ${copy.wouldHave}${at(time)}.`,
    tone: 'ok',
  };
}

/** "A lock", "Sleep", "Hibernation": what was requested, as the subject of a sentence. */
const REQUESTED: Partial<Record<PowerAction, string>> = { lock: 'A lock', sleep: 'Sleep', hibernate: 'Hibernation' };

/** The command was sent, but nothing showed that it happened. */
function unconfirmedText(result: ResultOf<'done'>, osName: string): ResultText {
  const copy = copyFor(result.action);
  const time = timeOf(result.atMs);
  const title = stamped(`${copy.noun.toUpperCase()} NOT CONFIRMED`, time);
  if (result.action === 'shutdown') {
    const started = `A shutdown was started${at(time)}; I can't confirm it completed.`;
    const body = [started, 'This PC was still on 2 minutes later.', 'Not watching any more.'];
    return { title, body, oneLine: started, tone: 'error' };
  }
  const what = (isPowerAction(result.action) ? REQUESTED[result.action] : undefined) ?? 'An action on this PC';
  const system = clean(osName) ?? 'the operating system';
  const unseen = `but ${system} didn't confirm it happened. Check this PC.`;
  return {
    title,
    body: [`${what} was requested${at(time)} because every Claude session had finished, ${unseen}`, 'Not watching any more.'],
    oneLine: `${what} was requested${at(time)}, ${unseen}`,
    tone: 'error',
  };
}

function doneText(result: ResultOf<'done'>, osName: string): ResultText {
  const copy = copyFor(result.action);
  const time = timeOf(result.atMs);
  if (result.action === 'notify') {
    return {
      title: stamped('CLAUDE FINISHED', time),
      body: ['Every session finished. Nothing was turned off.', 'Not watching any more.'],
      oneLine: `Every Claude session finished${at(time)}. Nothing was turned off.`,
      tone: 'ok',
    };
  }
  if (result.confirmed === false) return unconfirmedText(result, osName);
  const woke = timeOf(result.resumedAtMs);
  return {
    title: stamped(doneTitle(copy).toUpperCase(), time),
    body: [
      joinParts(
        [
          `This PC ${copy.past}${at(time)} because every Claude session had finished.`,
          woke === null ? null : `Woke at ${woke}.`,
        ],
        ' ',
      ),
      `Not watching any more, so it won't ${infinitive(copy)} again by itself.`,
    ],
    oneLine: `This PC ${copy.past}${at(time)}.`,
    tone: 'ok',
  };
}

function failedText(result: ResultOf<'failed'>, osName: string): ResultText {
  const what = infinitive(copyFor(result.action));
  const message = sentence(clean(result.message) ?? `${clean(osName) ?? 'The operating system'} gave no reason`);
  return {
    title: stamped(`COULDN'T ${what.toUpperCase()}`, timeOf(result.atMs)),
    body: [`${message} This PC is still on.`, 'Not watching.'],
    oneLine: `Couldn't ${what}: ${message} This PC is still on.`,
    tone: 'error',
  };
}

const CANCELLED_TITLES: Record<CountdownKind, string> = {
  real: 'CANCELLED · PC STAYS ON',
  test: 'TEST RUN STOPPED · PC STAYS ON',
  preview: 'PREVIEW CANCELLED · PC STAYS ON',
};

function cancelledText(result: ResultOf<'cancelled'>): ResultText {
  const reason = isRecord(result.reason) ? cancelReasonText(result.reason) : 'The countdown was cancelled';
  const time = timeOf(result.atMs);
  const title = Object.hasOwn(CANCELLED_TITLES, result.countdownKind)
    ? CANCELLED_TITLES[result.countdownKind]
    : CANCELLED_TITLES.real;
  const pause = `No new countdown for ${fmtSetting(COOLDOWN_SECONDS)}.`;
  // Only an explicit `true` may say "still watching": the other reading is the one to act on.
  if (result.stillWatching === true) {
    return {
      title,
      body: [`${reason}${at(time)}.`, `Still watching. ${pause}`],
      oneLine: `Countdown cancelled${at(time)}: ${reason}. ${pause}`,
      tone: 'neutral',
    };
  }
  const byUser = isRecord(result.reason) && result.reason.id === 'user';
  return {
    title,
    body: [`${reason}${at(time)}.`, 'Not watching any more.'],
    oneLine: `${byUser ? 'Cancelled.' : `Cancelled: ${reason}.`} This PC stays on and is no longer watched.`,
    tone: 'neutral',
  };
}

const STOP_CAUSES: Record<StopCause, string> = {
  user: 'You stopped watching.',
  settingsChanged: 'A setting changed, so watching stopped.',
  timeJump: 'This PC slept and woke up (or its clock changed), so watching stopped.',
  windowClosed: 'The VS Code window that was watching closed and no other window could take over.',
  lostControl:
    'The VS Code window that was watching lost control while it was still open ' +
    '(its connection to the other windows ended), so watching stopped.',
  editorRestarted: 'VS Code closed or restarted while watching.',
  afterAction: 'Watching ended once the action had run.',
};

function stoppedText(result: ResultOf<'stopped'>): ResultText {
  const cause = Object.hasOwn(STOP_CAUSES, result.cause) ? STOP_CAUSES[result.cause] : 'Watching stopped.';
  // 'afterAction' is the one cause where something may have been turned off.
  const acted = result.cause === 'afterAction';
  const since = timeOf(result.armedAtMs);
  const mode = result.wasReal === false ? 'test run' : 'for real';
  return {
    title: stamped('WATCHING STOPPED', timeOf(result.atMs)),
    body: [
      acted ? cause : `${cause} Nothing was turned off.`,
      `Watching had been on${since === null ? '' : ` since ${since}`} (${mode}).`,
    ],
    oneLine: acted ? cause : `${cause} This PC stays on.`,
    tone: 'neutral',
  };
}

/** A result of a kind this version does not know: all that can be said is the present state. */
function unknownResultText(): ResultText {
  return { title: 'NOT WATCHING', body: [NOT_WATCHING], oneLine: NOT_WATCHING, tone: 'neutral' };
}

export function describeResult(result: LastResult, osName: string): ResultText {
  switch (result.kind) {
    case 'testPassed':
      return testPassedText(result);
    case 'done':
      return doneText(result, osName);
    case 'failed':
      return failedText(result, osName);
    case 'cancelled':
      return cancelledText(result);
    case 'stopped':
      return stoppedText(result);
    default:
      return unknownResultText();
  }
}

// --- status bar --------------------------------------------------------------------------------

export interface StatusBarText {
  /** With $(codicon) syntax. */
  text: string;
  /** Plain-text tooltip lines (the caller builds the MarkdownString and escapes them). */
  tooltip: string[];
  background: 'none' | 'warning' | 'error';
  /** What a click does. */
  click: 'open' | 'cancel' | 'start' | 'none';
}

function countdownKindOf(state: UiState): CountdownKind {
  const kind: unknown = state.countdown?.kind;
  if (kind === 'test' || kind === 'preview') return kind;
  // A countdown whose kind is missing is judged by the contract; any other kind - including one
  // this version does not know - is described as the real thing.
  return kind === undefined && isTestRun(contractOf(state)) ? 'test' : 'real';
}

function countdownAction(state: UiState): unknown {
  return state.countdown?.action ?? contractOf(state).action;
}

/**
 * Seconds left on this window's clock, rounded like every other countdown (countdownSeconds).
 * With no usable value the clock reads 0:00 - "any moment now" - because a warning must never
 * show more time than may really be left.
 */
function secondsLeft(state: UiState, remainingSeconds: number | null): number {
  const live = finite(remainingSeconds);
  const ms = live !== null ? live * 1000 : finite(state.countdown?.remainingMs);
  return ms === null ? 0 : countdownSeconds(ms);
}

function sinceText(state: UiState): string {
  const since = timeOf(state.armedAtMs);
  return since === null ? '' : ` since ${since}`;
}

function watchingIntro(state: UiState): string {
  const contract = contractOf(state);
  const copy = copyFor(contract.action);
  if (contract.action === 'notify') {
    return `Watching${sinceText(state)}. You get a message when Claude finishes. Nothing will turn off.`;
  }
  if (isTestRun(contract)) {
    const promise = `You get a message when this PC ${copy.wouldHave}.`;
    return `Watching · test run${sinceText(state)}. Nothing will turn off. ${promise}`;
  }
  return `Watching · for real${sinceText(state)}. This PC ${copy.future} when Claude finishes.`;
}

/** "$(eye) Will shut down" / "$(beaker) Test run", with the icon a real run uses in this phase. */
function modeText(contract: ArmContract, realIcon: string): string {
  return isTestRun(contract) ? '$(beaker) Test run' : `$(${realIcon}) Will ${infinitive(copyFor(contract.action))}`;
}

/** A real run that turns something off: the only case that earns a coloured background. */
function actsOnThisPc(contract: ArmContract): boolean {
  return !isTestRun(contract) && contract.action !== 'notify';
}

function isolatedBar(): StatusBarText {
  return {
    text: "$(question) Can't coordinate",
    tooltip: ["Can't reach the other VS Code windows, so watching is off in this window."],
    background: 'warning',
    click: 'open',
  };
}

function lostContactBar(role: Role): StatusBarText {
  return {
    text: "$(question) Lost contact · can't tell",
    tooltip: ['The window in control stopped answering. Treat this PC as not watched.'],
    // Only a follower had a window in control to lose; during an election nothing has gone wrong yet.
    background: role === 'follower' ? 'warning' : 'none',
    click: 'open',
  };
}

function countdownBar(state: UiState, remainingSeconds: number | null): StatusBarText {
  const kind = countdownKindOf(state);
  const copy = copyFor(countdownAction(state));
  const clock = fmtClock(secondsLeft(state, remainingSeconds));
  const finalCheck = state.phase === 'committing';
  if (kind === 'real') {
    const doing = (copy.gerund || copy.progressive(THIS_PC)).toUpperCase();
    return {
      text: `$(warning) ${doing} ${finalCheck ? '· final check' : `in ${clock}`} · click to cancel`,
      tooltip: [
        finalCheck ? 'Final check: making sure nothing changed.' : `${copy.progressive(THIS_PC)} in ${clock}.`,
        'Click to cancel and keep this PC on.',
      ],
      background: 'error',
      click: 'cancel',
    };
  }
  const word = kind === 'preview' ? 'Preview' : 'Test run';
  return {
    text: `$(beaker) ${word} ${finalCheck ? '· final check' : clock} · click to stop`,
    tooltip: [
      `${word}: nothing will turn off.`,
      finalCheck ? 'Final check: making sure nothing changed.' : `"${copy.menu}" would happen in ${clock}.`,
      `Click to stop the ${word.toLowerCase()}.`,
    ],
    background: 'warning',
    click: 'cancel',
  };
}

function executingBar(state: UiState): StatusBarText {
  const contract = contractOf(state);
  const copy = copyFor(contract.action);
  if (isTestRun(contract)) {
    return {
      text: '$(beaker) Test run finishing…',
      tooltip: ['Test run: nothing will turn off.'],
      background: 'none',
      click: 'none',
    };
  }
  return {
    text: `$(loading~spin) ${copy.gerund || copy.progressive(THIS_PC)}…`,
    tooltip: [`${copy.progressive(THIS_PC)} now…`],
    background: actsOnThisPc(contract) ? 'error' : 'none',
    click: 'none',
  };
}

function resultWords(result: LastResult): Pick<StatusBarText, 'text' | 'background'> | null {
  switch (result.kind) {
    case 'testPassed':
      return { text: '$(pass) Test run passed', background: 'none' };
    case 'done': {
      const copy = copyFor(result.action);
      if (result.confirmed === false && result.action !== 'notify') {
        return { text: `$(warning) ${copy.noun} not confirmed`, background: 'warning' };
      }
      const what = result.action === 'notify' ? 'Claude finished' : doneTitle(copy);
      return { text: joinParts([`$(pass) ${what}`, timeOf(result.atMs)], ' '), background: 'none' };
    }
    case 'failed':
      return { text: `$(error) ${copyFor(result.action).noun} failed`, background: 'error' };
    case 'cancelled':
      return { text: '$(circle-slash) Cancelled', background: 'none' };
    case 'stopped':
      return { text: '$(warning) Watching stopped', background: 'warning' };
    default:
      return null;
  }
}

function notWatchingBar(state: UiState): StatusBarText {
  const result = isRecord(state.lastResult) ? state.lastResult : null;
  const words = result === null ? null : resultWords(result);
  if (result === null || words === null) {
    return { text: '$(eye-closed) Auto Shutdown', tooltip: [NOT_WATCHING], background: 'none', click: 'start' };
  }
  return { ...words, tooltip: describeResult(result, contextOf(state).osName).body, click: 'open' };
}

function confirmingBar(state: UiState): StatusBarText {
  const contract = contractOf(state);
  const agreed = whole(state.confirm?.k);
  const required = whole(state.confirm?.n);
  const known = agreed !== null && required !== null;
  return {
    text: `${modeText(contract, 'check-all')} · ${known ? `check ${agreed}/${required}` : 'double-checking'}`,
    tooltip: [
      watchingIntro(state),
      `Everything looks finished. Making sure it stays that way${known ? ` (check ${agreed} of ${required})` : ''}.`,
      KEEP_EDITOR_OPEN,
    ],
    background: actsOnThisPc(contract) ? 'warning' : 'none',
    click: 'open',
  };
}

/** Why watching cannot get anywhere by waiting, in the status bar's few words; null when it can. */
function blockedText(state: UiState, lanes: readonly LaneSummary[]): string | null {
  const stopSet = lanes.some((lane) => lane.unmet.some((check) => check.id === 'stopFile' && check.state === 'fail'));
  if (stopSet || state.stop?.present === true) return '$(stop-circle) Emergency stop · PC stays on';
  if (lanes.some((lane) => lane.state === 'fail')) return '$(warning) Problem · PC stays on';
  if (lanes.some((lane) => lane.state === 'cantTell')) return "$(question) Can't tell · PC stays on";
  return null;
}

function watchingBar(state: UiState): StatusBarText {
  const lanes = unmetLanes(state);
  const tooltip = [watchingIntro(state), ...lanes.map((lane) => `${lane.title}: ${lane.text}`), KEEP_EDITOR_OPEN];
  const blocked = blockedText(state, lanes);
  if (blocked !== null) return { text: blocked, tooltip, background: 'warning', click: 'open' };
  const waiting = lanes.length > 0 ? ` · waiting on ${lanes.length}` : '';
  return { text: `${modeText(contractOf(state), 'eye')}${waiting}`, tooltip, background: 'none', click: 'open' };
}

/**
 * `state` null = no trustworthy state (electing / lost contact). `remainingSeconds` = live
 * countdown value for this window, null when no countdown.
 */
export function statusBarText(state: UiState | null, role: Role, remainingSeconds: number | null): StatusBarText {
  if (role === 'isolated') return isolatedBar();
  if (!isRecord(state)) return lostContactBar(role);
  if (isRecord(state.countdown) || state.phase === 'countdown' || state.phase === 'committing') {
    return countdownBar(state, remainingSeconds);
  }
  switch (state.phase) {
    case 'off':
      return notWatchingBar(state);
    case 'executing':
      return executingBar(state);
    case 'confirming':
      return confirmingBar(state);
    default:
      // 'watching', and any phase this version does not know: the reading in which this PC may act.
      return watchingBar(state);
  }
}

// --- dialogs and notifications -----------------------------------------------------------------

export interface RealModalText {
  title: string;
  /** Multi-line detail. */
  detail: string;
  /** e.g. "Shut down when finished" */
  confirm: string;
  /** e.g. "Save all and shut down when finished"; null when nothing is unsaved. */
  confirmAfterSave: string | null;
  /** "Keep this PC on" - the default / Esc / close button. */
  cancel: string;
}

const MODAL_KEEP_OPEN =
  'Keep VS Code open: quitting it, or closing its last window, stops watching. ' +
  'Work outside Claude (a build, a git push) is not seen.';

function modalRules(contract: ArmContract, copy: ActionCopy): string {
  const quiet = `has been quiet for ${targetText(finite(contract.quietSeconds))}`;
  // The away clause goes only when the gate is explicitly off.
  const away =
    contract.requireUserIdle === false ? '' : ` and you've been away ${targetText(finite(contract.userIdleSeconds))}`;
  const countdown = finite(contract.countdownSeconds);
  const warning = countdown === null ? 'a short time' : fmtSetting(countdown);
  const condition = `Once every Claude session and subagent ${quiet}${away}`;
  return `${condition}, you get ${warning} to cancel, then this PC ${copy.present}.`;
}

function modalClosingApps(contract: ArmContract, unsavedFiles: number): string | null {
  if (contract.action !== 'shutdown') return null;
  // Only an explicit `false` drops the warning about other apps.
  const apps = contract.forceCloseApps === false ? null : 'Other apps are closed without asking.';
  const files = unsavedFiles > 0 ? `${plural(unsavedFiles, 'unsaved file')} in VS Code.` : null;
  return joinParts([apps, files], ' ') || null;
}

/**
 * The confirmation for a real run. `plan` is the contract this window is about to send; without
 * it the text describes `state.contract` (the leader's rules), which is the same thing unless the
 * two windows belong to different editors.
 */
export function realModalText(
  state: UiState,
  context: { unsavedFiles: number; remoteWindows: string[]; plan?: ArmContract },
): RealModalText {
  const contract = context.plan === undefined ? contractOf(state) : asContract(context.plan);
  const copy = copyFor(contract.action);
  const hostname = clean(state.hostname);
  const unsavedFiles = whole(context.unsavedFiles) ?? 0;
  const remotes = cleanList(context.remoteWindows);
  return {
    title: `${copy.imperative(hostname === null ? THIS_PC : `${THIS_PC} (${hostname})`)} when Claude finishes?`,
    detail: joinParts(
      [
        modalRules(contract, copy),
        MODAL_KEEP_OPEN,
        modalClosingApps(contract, unsavedFiles),
        remotes.length > 0 ? `Claude sessions in ${listOf(remotes)} are not visible.` : null,
        state.testPassedOnce === true ? null : "You haven't completed a test run on this PC yet.",
      ],
      '\n\n',
    ),
    confirm: `${copy.menu} when finished`,
    confirmAfterSave: unsavedFiles > 0 ? `Save all and ${copy.verb} when finished` : null,
    cancel: KEEP_ON,
  };
}

function deadlineText(nowMs: unknown, remainingMs: unknown): string {
  const now = finite(nowMs);
  const remaining = finite(remainingMs);
  const time = now === null || remaining === null ? null : timeOf(now + Math.max(0, remaining), true);
  return time === null ? 'shortly' : `at ${time}`;
}

/**
 * Notification text when a countdown starts (real or test or preview). `nowMs` is the wall clock
 * the deadline is shown against; it only ever feeds the displayed time.
 */
export function countdownToast(state: UiState, nowMs: number = Date.now()): { message: string; cancelLabel: string } {
  const copy = copyFor(countdownAction(state));
  const when = deadlineText(nowMs, state.countdown?.remainingMs);
  switch (countdownKindOf(state)) {
    case 'test':
      return {
        message: `Test run: this PC would ${infinitive(copy)} ${when}. Nothing will turn off.`,
        cancelLabel: 'Stop test run',
      };
    case 'preview':
      return {
        message: `Preview: a demo of the countdown, over ${when}. Nothing will turn off.`,
        cancelLabel: 'Cancel preview',
      };
    default:
      return { message: `Claude finished. This PC ${copy.present} ${when}.`, cancelLabel: 'Cancel' };
  }
}

/** `omitted` = sessions the state counts but does not list (UiState.sessionsOmitted). */
function finishedSessionsSentence(sessions: readonly Session[], omitted: number): string {
  const ignored = sessions.filter((session) => session.ignored === true).length;
  const total = sessions.length + omitted;
  if (total === 0) return 'No Claude session is running.';
  if (ignored > 0) return `Every Claude session being waited for finished (${ignored} not waited for).`;
  if (total === 1) return 'The Claude session finished.';
  return total === 2 ? 'Both Claude sessions finished.' : `All ${total} Claude sessions finished.`;
}

/**
 * First alert sentence for screen readers and the OS alert: title / body / cancel label. Every
 * title ends in "in" - the remaining time follows it ("Shutting down this PC in" + "1:27").
 */
export function countdownAlertText(state: UiState): { title: string; body: string; cancelLabel: string } {
  const contract = contractOf(state);
  const action = countdownAction(state);
  const copy = copyFor(action);
  switch (countdownKindOf(state)) {
    case 'test':
      return {
        title: `Test run: "${copy.menu}" would happen in`,
        body: 'Nothing will turn off.',
        cancelLabel: 'Stop test run',
      };
    case 'preview':
      return {
        title: `Preview: "${copy.menu}" would happen in`,
        body: 'A demo of the countdown. Nothing will turn off.',
        cancelLabel: 'Cancel preview',
      };
    default: {
      // Only an explicit `false` drops the warning about other apps.
      const losesWork = action === 'shutdown' && contract.forceCloseApps !== false;
      const finished = finishedSessionsSentence(contextOf(state).sessions, whole(state.sessionsOmitted) ?? 0);
      return {
        title: `${copy.progressive(THIS_PC)} in`,
        body: joinParts([finished, losesWork ? 'Unsaved work in other apps will be lost.' : null], ' '),
        cancelLabel: CANCEL_KEEP_ON,
      };
    }
  }
}
