// The sessions list: one row per Claude Code session, with its details, subagents, the commands it
// started, and the "Don't wait for…" overrides. Status words and row sentences come from
// shared/text.ts (describeSession).

import type { ChildProcessInfo, Session, SubagentInfo } from '../core/types';
import type { UiState, ViewContext } from '../shared/protocol';
import { describeSession, noSessionNeededText } from '../shared/text';
import { control, sending, worksHere } from './actions';
import type { Control, UiAction } from './actions';
import { agedSeconds } from './clock';
import { finite, text } from './guards';
import { isDegraded, isWatching } from './hero';
import { glyph } from './icons';
import type { Glyph } from './icons';
import { toHost } from './messages';
import { buttons, lanes, sessions as copy } from './strings';

export interface SessionMeter {
  /** 0..1 */
  fraction: number;
  /** For aria-valuetext: "Quiet 18 seconds of 5 minutes". */
  valueText: string;
}

export interface SubagentRow {
  key: string;
  name: string;
  /** "wrote 4 s ago · active" */
  text: string;
  active: boolean;
}

export interface ChildRow {
  key: string;
  text: string;
  ignored: boolean;
  /** "Don't wait for it", or "Undo" once ignored. */
  control: Control | null;
}

export interface SessionRow {
  key: string;
  name: string;
  glyph: Glyph;
  /** "Working" | "Just finished" | "Finished" | "Can't tell" | "Not waited for" */
  status: string;
  line: string;
  hint: string | null;
  tooltip: string;
  tags: string[];
  meter: SessionMeter | null;
  finished: boolean;
  ignored: boolean;
  /** "D:\work\api · CLI · PID 9120 · turn OPEN" */
  details: string;
  notes: string[];
  subagentsHeading: string | null;
  subagents: SubagentRow[];
  children: ChildRow[];
  /** A transcript exists, so its last events can be asked for. */
  hasTranscript: boolean;
  /** Changes whenever the session writes: the preview is asked for again. */
  lastActivityMs: number | null;
  openTranscript: Control | null;
  /** "Don't wait for this session" (in the expanded details). */
  dontWait: Control | null;
  /** "Undo" for a session that is not waited for (always visible). */
  undo: Control | null;
}

export interface SessionsModel {
  heading: string;
  /** The list is the last one that could be read, not the present: rows are dimmed. */
  stale: boolean;
  rows: SessionRow[];
  /** Finished rows fold into one line when the list is long and the view is narrow. */
  finishedFold: { label: string; keys: string[] } | null;
  /** Paragraphs shown instead of rows. */
  empty: string[] | null;
  /** Muted line under the list: sessions counted in every check but left out of it; null = none. */
  omitted: string | null;
}

export interface SessionsInput {
  state: UiState;
  view: ViewContext;
  /** Age of the last completed scan right now; null = none completed. */
  scanAgeMs: number | null;
  /** Wall clock, for "wrote 4 s ago" against a file time. */
  nowMs: number;
  /** Two-column layout. */
  wide: boolean;
}

/** More sessions than this and a narrow view folds the finished ones away. */
export const FOLD_FINISHED_ABOVE = 5;

const STATUS_GLYPHS: Record<string, Glyph> = {
  working: glyph('sync', 'waiting', true),
  justFinished: glyph('clock', 'waiting'),
  finished: glyph('pass', 'passed'),
};

const STATUS_ORDER: readonly string[] = ['cantTell', 'working', 'justFinished', 'finished'];
const TURN_STATES: readonly string[] = ['CLOSED', 'OPEN', 'UNKNOWN'];

function sessionGlyph(session: Session): Glyph {
  if (session.ignored === true) return glyph('debug-step-over', 'muted');
  const known = Object.hasOwn(STATUS_GLYPHS, session.status) ? STATUS_GLYPHS[session.status] : undefined;
  // A status this version does not know is "can't tell", never "finished".
  return known ?? glyph('question', 'cantTell');
}

/** Can't tell first, finished last; anything unknown sorts with can't tell. */
function statusRank(session: Session): number {
  const rank = STATUS_ORDER.indexOf(session.status);
  return rank === -1 ? 0 : rank;
}

function available(action: UiAction | null, label: string, view: ViewContext): Control | null {
  const built = control(label, action);
  return built !== null && worksHere(built.action, view) ? built : null;
}

function quietTarget(state: UiState): number | null {
  const quiet = finite(state.contract.quietSeconds);
  return quiet !== null && quiet > 0 ? quiet : null;
}

/**
 * The session's silence right now. A session whose turn has ended is only waiting out the quiet
 * period, so its clock stops at the target: past it, the next scan decides, not this window.
 */
function silenceNow(session: Session, state: UiState, scanAgeMs: number | null): number | null {
  const silence = agedSeconds(session.silenceSeconds, scanAgeMs);
  const quiet = quietTarget(state);
  if (silence === null || quiet === null || session.status !== 'justFinished') return silence;
  return Math.min(silence, quiet);
}

function meterOf(session: Session, silence: number | null, state: UiState): SessionMeter | null {
  const quiet = quietTarget(state);
  if (session.ignored === true || session.status !== 'justFinished' || silence === null || quiet === null) return null;
  const shown = Math.min(Math.max(0, silence), quiet);
  return { fraction: shown / quiet, valueText: copy.quietSpoken(shown, quiet) };
}

function tagsOf(session: Session): string[] {
  const tags: string[] = [];
  if (session.origin === 'transcript') tags.push(copy.notInList);
  const root = text(session.rootLabel);
  if (session.liveness === 'foreign' && root !== null) tags.push(root);
  return tags;
}

function detailsOf(session: Session): string {
  const entrypoint = text(session.entrypoint);
  const pid = finite(session.pid);
  const turn = TURN_STATES.includes(session.turn) ? session.turn : 'UNKNOWN';
  return [
    text(session.cwd),
    entrypoint === null ? null : copy.entrypoint(entrypoint),
    pid === null ? null : copy.pid(pid),
    copy.turn(turn),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function subagentRow(subagent: SubagentInfo, index: number, nowMs: number): SubagentRow {
  const written = finite(subagent.mtimeMs);
  const age = written === null ? null : Math.max(0, (nowMs - written) / 1000);
  const active = subagent.active === true;
  const wrote = copy.subagentWrote(Number.isFinite(age) ? age : null);
  return {
    key: `${text(subagent.path) ?? 'subagent'}-${index}`,
    name: text(subagent.name) ?? `#${index + 1}`,
    text: active ? `${wrote} · ${copy.subagentActive}` : wrote,
    active,
  };
}

function childRow(child: ChildProcessInfo, index: number, view: ViewContext): ChildRow | null {
  const ignored = child.ignored === true;
  if (!ignored && child.busy !== true) return null;
  const name = text(child.name) ?? copy.unnamedCommand;
  const pid = finite(child.pid);
  return {
    key: `${String(child.ignoreKey)}-${index}`,
    text: ignored ? `${copy.childIgnored(name, pid)} · ${lanes.notWaitedFor}` : copy.childRunning(name, pid),
    ignored,
    control: ignored
      ? available(sending(toHost.ignore(child.ignoreKey, false)), buttons.undo, view)
      : available(sending(toHost.ignore(child.ignoreKey, true)), lanes.dontWaitForIt, view),
  };
}

function sessionRow(session: Session, input: SessionsInput, stale: boolean): SessionRow {
  const { state, view } = input;
  // A stale list is shown as it was last seen; ageing it would pretend to know the present.
  const silence = silenceNow(session, state, stale ? null : input.scanAgeMs);
  const described = describeSession(session, state.contract.quietSeconds, silence);
  const ignored = session.ignored === true;
  const transcript = text(session.transcriptPath);
  return {
    key: session.key,
    name: text(session.name) ?? copy.unnamedSession,
    glyph: sessionGlyph(session),
    status: described.status,
    line: described.line,
    hint: ignored ? null : described.hint,
    tooltip: described.tooltip,
    tags: tagsOf(session),
    meter: meterOf(session, silence, state),
    finished: session.status === 'finished',
    ignored,
    details: detailsOf(session),
    notes: session.liveness === 'unverified' ? [copy.unverified] : [],
    subagentsHeading: session.subagents.length > 0 ? copy.subagentsHeading(session.subagents.length) : null,
    subagents: session.subagents.map((subagent, index) => subagentRow(subagent, index, input.nowMs)),
    children: session.children
      .map((child, index) => childRow(child, index, view))
      .filter((row): row is ChildRow => row !== null),
    hasTranscript: transcript !== null,
    lastActivityMs: finite(session.lastActivityMs),
    openTranscript: transcript === null ? null : available(sending(toHost.openTranscript(transcript)), copy.openTranscript, view),
    dontWait: described.canIgnore ? available(sending(toHost.ignore(session.ignoreKey, true)), copy.dontWait, view) : null,
    undo: ignored ? available(sending(toHost.ignore(session.ignoreKey, false)), buttons.undo, view) : null,
  };
}

/**
 * What happens with no session: the rules being watched with, or - before watching - the plan
 * this window would start. Only rules that wait for a session may say "I wait".
 */
function noSessionLine(state: UiState, view: ViewContext): string | null {
  const watching = isWatching(state);
  const needed = noSessionNeededText(watching ? state.contract : view.plan);
  if (needed !== null) return needed;
  return watching ? null : copy.canStartNow;
}

function emptyText(state: UiState, view: ViewContext, scanned: boolean): string[] {
  if (!scanned) return [copy.looking];
  const roots = [...new Set(state.scan.roots.map((root) => text(root.label)).filter((label): label is string => label !== null))];
  const advice = noSessionLine(state, view);
  return [copy.none(roots), copy.unseen, ...(advice === null ? [] : [advice])];
}

/** Sessions every check counts that the state does not list (UiState.sessionsOmitted). */
export function omittedCount(state: UiState): number {
  const omitted = finite(state.sessionsOmitted);
  return omitted === null ? 0 : Math.max(0, Math.floor(omitted));
}

export function buildSessions(input: SessionsInput): SessionsModel {
  const { state, view, scanAgeMs } = input;
  const omitted = omittedCount(state);
  const stale = isDegraded(state);
  const ordered = state.sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => statusRank(a.session) - statusRank(b.session) || a.index - b.index)
    .map(({ session }) => session);
  const rows = ordered.map((session) => sessionRow(session, input, stale));
  const finishedKeys = rows.filter((row) => row.finished).map((row) => row.key);
  const foldFinished = !input.wide && rows.length > FOLD_FINISHED_ABOVE && finishedKeys.length > 0;
  return {
    heading: stale ? copy.staleHeading(scanAgeMs === null ? null : scanAgeMs / 1000) : copy.heading(rows.length, omitted),
    stale,
    rows,
    finishedFold: foldFinished ? { label: copy.finishedGroup(finishedKeys.length), keys: finishedKeys } : null,
    // Sessions left out are sessions all the same: the list is not empty then.
    empty: rows.length === 0 && omitted === 0 ? emptyText(state, view, scanAgeMs !== null) : null,
    omitted: omitted > 0 ? copy.omitted(omitted) : null,
  };
}

/** How many transcript events a row shows. */
export function previewLength(wide: boolean): number {
  return wide ? 12 : 5;
}
