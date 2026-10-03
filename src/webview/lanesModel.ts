// "Waiting for": the unmet lanes (Claude, You, This PC, Re-check), the overrides that are in force,
// and the fold with every raw check. The lane grouping and every sentence come from
// shared/text.ts; this adds only what the dashboard needs to lay them out and act on them.

import type { Check, StrayProcess } from '../core/types';
import type { RemoteWindow, UiState, ViewContext } from '../shared/protocol';
import { describeCheck, describeResult, fmtTime, laneSetting, unmetLanes } from '../shared/text';
import type { LaneSummary } from '../shared/text';
import { control, present, sending, worksHere } from './actions';
import type { Control } from './actions';
import { finite, recordsIn, text } from './guards';
import { isWatching, stillWatchingCancel } from './hero';
import { glyph } from './icons';
import type { Glyph } from './icons';
import { toHost } from './messages';
import { omittedCount } from './sessionsModel';
import { textContextOf } from './sharedCopy';
import { buttons, lanes as copy } from './strings';

export interface CheckRow {
  /** List key: the position in the list (a check id from another version may not be usable). */
  id: string;
  glyph: Glyph;
  label: string;
  detail: string;
  /** "Pass" | "Waiting" | "Can't tell" | "Problem" */
  stateWord: string;
}

/** Something the user can do about a blocker, with the sentence that explains it (if any). */
export interface LaneAction {
  key: string;
  text: string | null;
  control: Control;
  /** Drawn indented, under the action before it (a command a stray Claude process started). */
  nested: boolean;
}

export interface LaneMeter {
  /** 0..1 */
  fraction: number;
  /** For aria-valuetext: "Quiet 18 seconds of 5 minutes". */
  valueText: string;
}

export interface LaneRow {
  lane: LaneSummary['lane'];
  title: string;
  glyph: Glyph;
  text: string;
  sub: string | null;
  meter: LaneMeter | null;
  checks: CheckRow[];
  actions: LaneAction[];
  /** The gear: opens the setting that tunes this lane. */
  settings: Control | null;
  /** A lane that offers an override opens by itself, so the override is never hidden. */
  openByDefault: boolean;
}

/** A "don't wait for it" that is in force and has no session row to live in. */
export interface OverrideRow {
  key: string;
  text: string;
  undo: Control;
}

export interface LanesModel {
  heading: string;
  /** "Countdown cancelled at 02:13: web-ui went back to work. No new countdown for 60 s." */
  notice: string | null;
  rows: LaneRow[];
  /** Shown instead of rows when nothing is in the way. */
  allClear: string | null;
  overrides: OverrideRow[];
  /** "Earliest: 02:21 (not before)" */
  earliest: string | null;
  /** "N checks OK": every raw check, behind one line. */
  fold: { label: string; glyph: Glyph; checks: CheckRow[] };
}

const STATE_GLYPHS: Record<string, Glyph> = {
  pass: glyph('pass', 'passed'),
  waiting: glyph('clock', 'waiting'),
  fail: glyph('error', 'broken'),
};

/** A state this version does not know is drawn as "can't tell", never as a pass. */
const CANT_TELL_GLYPH = glyph('question', 'cantTell');

function checkGlyph(state: unknown): Glyph {
  return (typeof state === 'string' && Object.hasOwn(STATE_GLYPHS, state) ? STATE_GLYPHS[state] : undefined) ?? CANT_TELL_GLYPH;
}

function laneGlyph(summary: LaneSummary): Glyph {
  if (summary.state !== 'waiting') return checkGlyph(summary.state);
  // Claude still at work is activity, everything else that waits is a clock.
  return summary.lane === 'claude' && summary.progress === null ? glyph('sync', 'waiting', true) : glyph('clock', 'waiting');
}

function checkRow(check: Check, state: UiState, index: number): CheckRow {
  const described = describeCheck(check, textContextOf(state));
  return {
    id: `check-${index}`,
    glyph: checkGlyph(check.state),
    label: described.label,
    detail: described.detail,
    stateWord: described.stateWord,
  };
}

function meterOf(summary: LaneSummary): LaneMeter | null {
  const progress = summary.progress;
  if (progress === null) return null;
  const value = finite(progress.value);
  const max = finite(progress.max);
  if (value === null || max === null || max <= 0) return null;
  return { fraction: Math.min(1, Math.max(0, value / max)), valueText: progress.valueText };
}

function hasUnmet(summary: LaneSummary, id: string): boolean {
  return summary.unmet.some((check) => check.id === id);
}

/** A stray whose own row is shown: it blocks by itself. */
function strayBlocks(stray: StrayProcess): boolean {
  return stray.accounted !== true && stray.ignored !== true;
}

/** The commands a stray Claude process started, as the scan reports them (the busy ones, at most 10). */
function strayChildren(stray: StrayProcess): Record<string, unknown>[] {
  return recordsIn((stray as { children?: unknown }).children);
}

function strayRow(stray: StrayProcess): LaneAction[] {
  const dontWait = control(copy.dontWaitForIt, sending(toHost.ignore(stray.ignoreKey, true)));
  if (dontWait === null) return [];
  return [{ key: stray.ignoreKey, text: copy.stray(finite(stray.pid), text(stray.name)), control: dontWait, nested: false }];
}

/** Under the stray's row when it has one; on its own, naming the stray, when it does not. */
function strayChildRows(stray: StrayProcess, underRow: boolean): LaneAction[] {
  const strayName = copy.strayName(finite(stray.pid), text(stray.name));
  return strayChildren(stray)
    .filter((child) => child.busy === true && child.ignored !== true)
    .flatMap((child, index) => {
      const dontWait = control(copy.dontWaitForIt, sending(toHost.ignore(child.ignoreKey, true)));
      if (dontWait === null) return [];
      const name = text(child.name) ?? copy.unnamedCommand;
      const pid = finite(child.pid);
      const line = underRow ? copy.strayChild(name, pid) : copy.strayChildOf(name, pid, strayName);
      return [{ key: `${String(child.ignoreKey)}-${index}`, text: line, control: dontWait, nested: underRow }];
    });
}

function strayActions(strays: readonly StrayProcess[] | null, withRows: boolean, withChildren: boolean): LaneAction[] {
  return (strays ?? []).flatMap((stray) => {
    const row = withRows && strayBlocks(stray) ? strayRow(stray) : [];
    return [...row, ...(withChildren ? strayChildRows(stray, row.length > 0) : [])];
  });
}

/** One control for all of them: each remote window blocks for the same reason. */
function remoteAction(remotes: readonly RemoteWindow[]): LaneAction[] {
  const blocking = remotes.filter((remote) => remote.ignored !== true && remote.covered !== true);
  if (blocking.length === 0) return [];
  const dontWait = control(copy.dontWaitForRemotes, sending(...blocking.map((remote) => toHost.ignore(remote.ignoreKey, true))));
  return dontWait === null ? [] : [{ key: 'remoteWindows', text: copy.staysOn, control: dontWait, nested: false }];
}

function stopFileAction(): LaneAction[] {
  const reveal = control(buttons.stopFolder, sending(toHost.revealStop()));
  return reveal === null ? [] : [{ key: 'stopFile', text: null, control: reveal, nested: false }];
}

function laneActions(summary: LaneSummary, state: UiState): LaneAction[] {
  const straysWait = hasUnmet(summary, 'registry');
  // A stray's busy commands hold this PC up through the process check or the command check.
  const commandsWait = straysWait || hasUnmet(summary, 'childProcesses');
  return [
    ...strayActions(state.strays, straysWait, commandsWait),
    ...(hasUnmet(summary, 'remoteWindows') ? remoteAction(state.remoteWindows) : []),
    ...(hasUnmet(summary, 'stopFile') ? stopFileAction() : []),
  ];
}

function laneRow(summary: LaneSummary, state: UiState, view: ViewContext): LaneRow {
  const actions = laneActions(summary, state).filter((action) => worksHere(action.control.action, view));
  return {
    lane: summary.lane,
    title: summary.title,
    glyph: laneGlyph(summary),
    text: summary.text,
    sub: summary.sub,
    meter: meterOf(summary),
    checks: summary.unmet.map((check, index) => checkRow(check, state, index)),
    actions,
    settings: control(copy.laneSettings(summary.title), sending(toHost.openSettings(laneSetting(summary.lane)))),
    openByDefault: actions.length > 0,
  };
}

function overridesOf(state: UiState, view: ViewContext): OverrideRow[] {
  const strays = (state.strays ?? [])
    .filter((stray) => stray.ignored === true)
    .map((stray) => ({ key: stray.ignoreKey, text: copy.strayName(finite(stray.pid), text(stray.name)) }));
  const strayCommands = (state.strays ?? []).flatMap((stray) =>
    strayChildren(stray)
      .filter((child) => child.ignored === true && typeof child.ignoreKey === 'string')
      .map((child) => ({
        key: child.ignoreKey as string,
        text: copy.strayName(finite(child.pid), text(child.name) ?? copy.unnamedCommand),
      })),
  );
  const remotes = state.remoteWindows
    .filter((remote) => remote.ignored === true)
    .map((remote) => ({ key: remote.ignoreKey, text: text(remote.name) ?? remote.ignoreKey }));
  return present(
    [...strays, ...strayCommands, ...remotes].map(({ key, text: label }) => {
      const undo = control(buttons.undo, sending(toHost.ignore(key, false)));
      return undo === null || !worksHere(undo.action, view) ? null : { key, text: label, undo };
    }),
  );
}

/**
 * When this PC could act at the earliest, as epoch ms. Only when every lane is a clock running
 * towards a known target and no session is working or unreadable - otherwise any time would be a
 * guess, and a guess here reads as a promise.
 */
export function earliestActionMs(state: UiState, summaries: readonly LaneSummary[], nowMs: number): number | null {
  if (state.phase !== 'watching' && state.phase !== 'confirming') return null;
  if (summaries.length === 0 || summaries.some((summary) => summary.progress === null)) return null;
  // A session that is counted but not listed could be in any state.
  const undecided =
    omittedCount(state) > 0 ||
    state.sessions.some((session) => session.ignored !== true && session.status !== 'justFinished' && session.status !== 'finished');
  if (undecided) return null;

  const { contract } = state;
  const poll = finite(contract.pollSeconds);
  const polls = finite(contract.requiredPolls);
  const countdown = contract.action === 'notify' ? 0 : finite(contract.countdownSeconds);
  const now = finite(nowMs);
  if (poll === null || polls === null || countdown === null || now === null) return null;

  let timerSeconds = 0;
  let agreed = 0;
  for (const summary of summaries) {
    const value = finite(summary.progress?.value);
    const max = finite(summary.progress?.max);
    if (value === null || max === null) return null;
    if (summary.lane === 'recheck') agreed = value;
    else timerSeconds = Math.max(timerSeconds, max - value);
  }
  const cooldownSeconds = Math.max(0, finite(state.cooldownRemainingMs) ?? 0) / 1000;
  const waitSeconds = Math.max(timerSeconds, cooldownSeconds) + Math.max(0, polls - agreed) * poll + countdown;
  return now + waitSeconds * 1000;
}

function earliestLine(state: UiState, summaries: readonly LaneSummary[], nowMs: number): string | null {
  const at = earliestActionMs(state, summaries, nowMs);
  return at === null ? null : copy.earliest(fmtTime(at));
}

function noticeOf(state: UiState): string | null {
  const cancelled = stillWatchingCancel(state);
  return cancelled === null ? null : describeResult(cancelled, state.platform.osName).oneLine;
}

function foldOf(state: UiState): LanesModel['fold'] {
  // Only a real pass is counted: a can't-tell never hides inside "N checks OK".
  const passed = state.checks.filter((check) => check.state === 'pass').length;
  return {
    label: copy.checksOk(passed),
    glyph: passed > 0 ? glyph('pass', 'passed') : CANT_TELL_GLYPH,
    checks: state.checks.map((check, index) => checkRow(check, state, index)),
  };
}

/** null = the section is not shown at all. `nowMs` is the wall clock (for the "Earliest" line). */
export function buildLanes(state: UiState, view: ViewContext, nowMs: number): LanesModel | null {
  // No checks at all (a state from another version): nothing is known, and an empty list under
  // "all clear" would claim the opposite.
  if (state.checks.length === 0) return null;
  const armed = isWatching(state);
  // Not watching, "0 of 3 re-checks" is only a consequence of not having started.
  const summaries = unmetLanes(state).filter((summary) => armed || summary.lane !== 'recheck');
  const overrides = overridesOf(state, view);
  if (!armed) {
    const scanned = state.scan.lastCompletedAgoMs !== null;
    const problem = summaries.some((summary) => summary.state !== 'waiting');
    const sessions = state.sessions.length + omittedCount(state);
    if (!scanned || (sessions === 0 && !problem && overrides.length === 0)) return null;
  }
  return {
    heading: armed ? copy.waitingHeading(summaries.length) : copy.ifStartedHeading,
    notice: noticeOf(state),
    rows: summaries.map((summary) => laneRow(summary, state, view)),
    allClear: !armed && summaries.length === 0 ? copy.nothingInTheWay : null,
    overrides,
    earliest: earliestLine(state, summaries, nowMs),
    fold: foldOf(state),
  };
}
