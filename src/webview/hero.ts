// The hero: which of the dashboard's top-level states to show for a (state, view) pair, and what
// that state says. Pure - the components only lay the result out.
//
// Slot P (the primary button) only ever holds a safe or neutral control: Stop watching, Cancel,
// Check again, Show log, Got it. Nothing in the hero starts watching.

import type { ArmContract } from '../shared/config';
import type { CountdownKind, LastResult, UiState, ViewContext } from '../shared/protocol';
import { countdownAlertText, describeResult, fmtSpoken, headline } from '../shared/text';
import { control, present, sending, worksHere } from './actions';
import type { Control } from './actions';
import { finite, text } from './guards';
import { glyph } from './icons';
import type { Glyph } from './icons';
import { toHost } from './messages';
import {
  checkSentence,
  confirmingSentence,
  executingSentence,
  isolatedSentence,
  keepOpenSentence,
  lostContactSentence,
  textContextOf,
  watchingSentence,
} from './sharedCopy';
import { buttons, endSentence, hero, settingText } from './strings';
import type { Mode } from './strings';

export type HeroVariant =
  | { kind: 'isolated' }
  | { kind: 'connecting' }
  | { kind: 'lostContact' }
  | { kind: 'countdown'; countdownKind: CountdownKind }
  | { kind: 'committing'; countdownKind: CountdownKind }
  | { kind: 'executing' }
  | { kind: 'result'; result: LastResult }
  | { kind: 'cantRun'; problem: string }
  | { kind: 'degraded'; armed: boolean }
  | { kind: 'off' }
  | { kind: 'watching' }
  | { kind: 'confirming' };

export type HeroKind = HeroVariant['kind'];

/** A window that has just opened shows "connecting" this long before it calls the silence lost contact. */
export const CONNECTING_GRACE_MS = 2000;

/** Only an explicit `true` is a test run; an unknown action or mode reads as the real thing. */
export function modeOf(contract: ArmContract): Mode {
  if (contract.action === 'notify') return 'notify';
  return contract.testMode === true ? 'test' : 'real';
}

/**
 * A countdown whose kind is missing is judged by the contract; any kind this version does not know
 * is shown as the real thing.
 */
export function countdownKindOf(state: UiState): CountdownKind {
  const kind: unknown = state.countdown?.kind;
  if (kind === 'test' || kind === 'preview') return kind;
  return kind === undefined && state.contract.testMode === true ? 'test' : 'real';
}

/** Watching, in any phase. A preview countdown is a demo: nothing is being watched. */
export function isWatching(state: UiState): boolean {
  if (state.countdown !== null && countdownKindOf(state) === 'preview') return false;
  return state.phase !== 'off';
}

/** The scanner could not see properly: its picture of the sessions is not to be trusted. */
export function isDegraded(state: UiState): boolean {
  return state.scan.stale || state.scan.errors.length > 0;
}

const STOP_CAUSES_SHOWN: readonly string[] = ['settingsChanged', 'timeJump', 'windowClosed', 'lostControl', 'editorRestarted'];

/**
 * The result to show as the hero while not watching; null when there is none worth a card.
 * A cancel that left watching on is not a result (it is a notice above the lanes), and a stop the
 * user asked for, or one that followed the action, needs no morning-after explanation.
 */
export function shownResult(result: LastResult | null): LastResult | null {
  if (result === null) return null;
  switch (result.kind) {
    case 'testPassed':
    case 'done':
    case 'failed':
      return result;
    case 'cancelled':
      return result.stillWatching === true ? null : result;
    case 'stopped':
      return STOP_CAUSES_SHOWN.includes(result.cause) ? result : null;
    default:
      return null;
  }
}

/** The cancel that left watching on, for the one-line notice; null when there is none. */
export function stillWatchingCancel(state: UiState): Extract<LastResult, { kind: 'cancelled' }> | null {
  const result = state.lastResult;
  if (state.phase === 'off' || result === null || result.kind !== 'cancelled') return null;
  return result.stillWatching === true ? result : null;
}

/**
 * Picks the hero. `nullForMs` = how long there has been no trustworthy state.
 * Order matters: a running countdown outranks everything that is known about the state, because
 * its Cancel button must be on screen.
 */
export function pickHero(state: UiState | null, view: ViewContext, nullForMs: number): HeroVariant {
  if (view.role === 'isolated') return { kind: 'isolated' };
  if (state === null) {
    const waited = finite(nullForMs);
    return waited !== null && waited < CONNECTING_GRACE_MS ? { kind: 'connecting' } : { kind: 'lostContact' };
  }
  if (state.countdown !== null || state.phase === 'countdown' || state.phase === 'committing') {
    const countdownKind = countdownKindOf(state);
    return state.phase === 'committing' ? { kind: 'committing', countdownKind } : { kind: 'countdown', countdownKind };
  }
  if (state.phase === 'executing') return { kind: 'executing' };
  if (state.phase === 'off') {
    const result = shownResult(state.lastResult);
    if (result !== null) return { kind: 'result', result };
    const problem = text(state.platform.problem);
    if (problem !== null) return { kind: 'cantRun', problem };
    return isDegraded(state) ? { kind: 'degraded', armed: false } : { kind: 'off' };
  }
  // 'watching', 'confirming', and any phase this version does not know: the reading in which this
  // PC may act, with Stop watching on screen.
  if (isDegraded(state)) return { kind: 'degraded', armed: true };
  return state.phase === 'confirming' ? { kind: 'confirming' } : { kind: 'watching' };
}

/** Changes whenever the layout around the start button may shift; restarts the click guard. */
export function heroKey(state: UiState | null, view: ViewContext): string {
  const variant = pickHero(state, view, 0);
  const detail =
    variant.kind === 'countdown' || variant.kind === 'committing'
      ? variant.countdownKind
      : variant.kind === 'result'
        ? variant.result.kind
        : '';
  return `${state?.phase ?? 'none'}|${variant.kind}|${detail}`;
}

// --- model -------------------------------------------------------------------------------------

export interface HeroControl extends Control {
  emphasis: 'primary' | 'secondary';
}

export interface HeroCountdown {
  kind: CountdownKind;
  committing: boolean;
  /** Whether moving the mouse cancels - said in words either way. */
  mouseLine: string;
  /** Start of the one-off screen-reader alert; the remaining time follows it. */
  announceTitle: string;
  /** Sentence after the time in that alert ("Nothing will turn off."), if any. */
  announceBody: string | null;
}

export interface HeroConfirm {
  k: number;
  n: number;
  /** "Check 2 of 3" */
  label: string;
  /** "Check 2 of 3 passed" - the dots are decoration. */
  spoken: string;
  /** "next ~6 s", null when the leader did not say. */
  next: string | null;
}

export interface HeroModel {
  kind: HeroKind;
  glyph: Glyph;
  /** plain = ordinary card; warning = warning strip; real = solid 2 px; test = dashed 2 px. */
  frame: 'plain' | 'warning' | 'real' | 'test';
  /** Results, degraded and lost contact interrupt a screen reader; everything else is polite. */
  live: 'status' | 'alert';
  title: string;
  lead: string | null;
  body: string[];
  confirm: HeroConfirm | null;
  countdown: HeroCountdown | null;
  primary: HeroControl | null;
  secondary: Control[];
  /** Muted lines under the buttons ("Keep VS Code open."). */
  notes: string[];
  /** A warning line under everything ("Don't trust the list below."). */
  warning: string | null;
}

export interface HeroClock {
  /** Age of the last completed scan in seconds; null = none has completed. */
  scanAgeSeconds: number | null;
  /** Seconds until the next check; null = unknown. */
  nextCheckSeconds: number | null;
}

const BASE: Pick<HeroModel, 'frame' | 'live' | 'lead' | 'body' | 'confirm' | 'countdown' | 'primary' | 'secondary' | 'notes' | 'warning'> = {
  frame: 'plain',
  live: 'status',
  lead: null,
  body: [],
  confirm: null,
  countdown: null,
  primary: null,
  secondary: [],
  notes: [],
  warning: null,
};

function heroControl(label: string, emphasis: HeroControl['emphasis'], action: Control['action'] | null): HeroControl | null {
  return action === null ? null : { label, action, emphasis };
}

function stopControl(view: ViewContext): HeroControl | null {
  const label = view.pending === 'disarm' ? buttons.stopping : buttons.stopWatching;
  return heroControl(label, 'secondary', sending(toHost.stop()));
}

const showLog = (): Control | null => control(buttons.showLog, sending(toHost.showLog()));
const gotIt = (): Control | null => control(buttons.gotIt, sending(toHost.dismissResult()));
const checkAgain = (): Control | null => control(buttons.checkAgain, sending(toHost.refresh()));
const openSettings = (): Control | null => control(buttons.settings, sending(toHost.openSettings()));
const stopFolder = (): Control | null => control(buttons.stopFolder, sending(toHost.revealStop()));

function nonEmpty(lines: readonly (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null && line !== '');
}

/** "Keep VS Code open." and, when there will be a countdown, how long it gives. */
function watchingNotes(state: UiState): string[] {
  const countdown = state.contract.action === 'notify' ? null : settingText(state.contract.countdownSeconds);
  return nonEmpty([keepOpenSentence(state), countdown === null ? null : hero.cancelNotice(countdown)]);
}

function armedByLine(state: UiState): string | null {
  if (state.armedBy === 'startup') return hero.startedWithEditor;
  return state.armedBy === 'handover' ? hero.tookOver : null;
}

function watchingHero(state: UiState, view: ViewContext): HeroModel {
  const mode = modeOf(state.contract);
  return {
    ...BASE,
    kind: 'watching',
    glyph: glyph(mode === 'test' ? 'beaker' : 'eye', 'neutral'),
    title: hero.watchingTitle(mode),
    lead: watchingSentence(state),
    body: nonEmpty([headline(state), armedByLine(state)]),
    primary: stopControl(view),
    notes: watchingNotes(state),
  };
}

/** Bounds of the "checks in a row" setting: a count outside them is not drawn as dots. */
const MAX_CONFIRM_DOTS = 10;

function confirmOf(state: UiState, clock: HeroClock): HeroConfirm | null {
  const k = finite(state.confirm.k);
  const n = finite(state.confirm.n);
  if (k === null || n === null || n < 1 || n > MAX_CONFIRM_DOTS || k < 0) return null;
  const done = Math.min(Math.floor(k), Math.floor(n));
  const total = Math.floor(n);
  return {
    k: done,
    n: total,
    label: hero.confirmProgress(done, total),
    spoken: hero.confirmSpoken(done, total),
    next: clock.nextCheckSeconds === null ? null : hero.nextCheck(clock.nextCheckSeconds),
  };
}

function confirmingHero(state: UiState, view: ViewContext, clock: HeroClock): HeroModel {
  const mode = modeOf(state.contract);
  return {
    ...BASE,
    kind: 'confirming',
    glyph: glyph('check-all', 'waiting'),
    // Only a real run is about to act on this PC; only that earns the warning colours.
    frame: mode === 'real' ? 'warning' : 'plain',
    title: hero.confirmingTitle(mode),
    lead: confirmingSentence(state),
    confirm: confirmOf(state, clock),
    primary: stopControl(view),
    notes: watchingNotes(state),
  };
}

function countdownHero(
  variant: Extract<HeroVariant, { kind: 'countdown' | 'committing' }>,
  state: UiState,
  view: ViewContext,
): HeroModel {
  const alert = countdownAlertText(state);
  const kind = variant.countdownKind;
  const committing = variant.kind === 'committing';
  const real = kind === 'real';
  // Only a real or test countdown samples the mouse, and only when the contract says so. Claiming
  // "moving the mouse cancels" when it does not is the dangerous mistake, so that needs a `true`.
  const mouseCancels = kind !== 'preview' && state.contract.requireUserIdle === true;
  const cancelLabel = view.pending === 'cancel' ? buttons.cancelling : alert.cancelLabel;
  return {
    ...BASE,
    kind: variant.kind,
    glyph: committing ? glyph('sync', 'neutral', true) : glyph(real ? 'warning' : 'beaker', 'neutral'),
    frame: real ? 'real' : 'test',
    title: committing ? hero.committingTitle(kind) : real ? alert.title.toUpperCase() : hero.countdownTitle[kind],
    lead: committing ? hero.committingLead : real ? null : alert.title,
    body: nonEmpty([alert.body]),
    countdown: {
      kind,
      committing,
      mouseLine: mouseCancels ? hero.mouseCancels : hero.mouseDoesNotCancel,
      announceTitle: alert.title,
      announceBody: real ? null : alert.body,
    },
    primary: heroControl(cancelLabel, 'primary', sending(toHost.cancel())),
  };
}

function executingHero(state: UiState): HeroModel {
  return {
    ...BASE,
    kind: 'executing',
    glyph: glyph('sync', 'neutral', true),
    title: hero.executingTitle(state.contract.action, modeOf(state.contract)),
    lead: executingSentence(state),
  };
}

const RESULT_GLYPHS: Record<LastResult['kind'], Glyph> = {
  testPassed: glyph('pass', 'passed'),
  done: glyph('pass', 'passed'),
  failed: glyph('error', 'broken'),
  cancelled: glyph('circle-slash', 'neutral'),
  stopped: glyph('warning', 'cantTell'),
};

function resultControls(result: LastResult, view: ViewContext): Pick<HeroModel, 'primary' | 'secondary'> {
  const dismiss = heroControl(buttons.gotIt, 'primary', sending(toHost.dismissResult()));
  const startAgain = control(buttons.startAgain, { do: 'focusPlan' });
  switch (result.kind) {
    case 'testPassed': {
      const canSwitch = view.plan.testMode === true && view.plan.action !== 'notify';
      const switchToReal = canSwitch ? control(buttons.switchToReal, { do: 'switchToReal' }) : null;
      return { primary: dismiss, secondary: present([switchToReal, showLog()]) };
    }
    case 'done':
      return { primary: dismiss, secondary: present([control(buttons.openLogFile, sending(toHost.openLogFile()))]) };
    case 'failed':
      return {
        primary: heroControl(buttons.showLog, 'secondary', sending(toHost.showLog())),
        secondary: present([control(buttons.setUpAgain, { do: 'focusPlan' }), gotIt()]),
      };
    case 'cancelled':
      return { primary: dismiss, secondary: present([startAgain]) };
    case 'stopped':
      return { primary: dismiss, secondary: present([startAgain, showLog()]) };
  }
}

function resultHero(result: LastResult, state: UiState, view: ViewContext): HeroModel {
  const copy = describeResult(result, state.platform.osName);
  const [lead, ...body] = copy.body;
  // A "done" that could not be confirmed is told as a warning, not a success.
  const unconfirmed = result.kind === 'done' && copy.tone === 'error';
  return {
    ...BASE,
    kind: 'result',
    glyph: unconfirmed ? glyph('warning', 'cantTell') : RESULT_GLYPHS[result.kind],
    live: 'alert',
    title: copy.title,
    lead: lead ?? null,
    body,
    ...resultControls(result, view),
  };
}

function cantRunHero(problem: string, state: UiState): HeroModel {
  return {
    ...BASE,
    kind: 'cantRun',
    glyph: glyph('error', 'broken'),
    live: 'alert',
    title: hero.cantRunTitle,
    lead: checkSentence('helper', 'fail', { problem, tier: state.platform.helperTier }, textContextOf(state)),
    primary: heroControl(buttons.showDetails, 'secondary', sending(toHost.showLog())),
  };
}

function scannerSentence(state: UiState): string {
  const { scan } = state;
  const reason = scan.errors.length > 0 ? 'errors' : 'stale';
  const data = { reason, errors: scan.errors, roots: scan.roots.length };
  return endSentence(checkSentence('scanner', 'cantTell', data, textContextOf(state)));
}

function degradedHero(armed: boolean, state: UiState, view: ViewContext, clock: HeroClock): HeroModel {
  const refresh = checkAgain();
  return {
    ...BASE,
    kind: 'degraded',
    glyph: glyph('question', 'cantTell'),
    live: 'alert',
    title: hero.degradedTitle,
    lead: hero.degradedLead,
    body: nonEmpty([
      `${scannerSentence(state)} ${hero.lastGoodCheck(clock.scanAgeSeconds)}`,
      armed ? watchingSentence(state) : null,
    ]),
    // While watching, Stop keeps its place; "Check again" moves to the row below.
    primary: armed ? stopControl(view) : refresh === null ? null : { ...refresh, emphasis: 'primary' },
    secondary: present([armed ? refresh : null, showLog(), openSettings()]),
    notes: armed ? watchingNotes(state) : [],
    warning: hero.distrustList,
  };
}

function offHero(): HeroModel {
  return { ...BASE, kind: 'off', glyph: glyph('eye-closed', 'muted'), title: hero.offTitle, lead: hero.offLead };
}

function connectingHero(): HeroModel {
  return {
    ...BASE,
    kind: 'connecting',
    glyph: glyph('sync', 'muted', true),
    title: hero.connectingTitle,
    lead: hero.connectingLead,
  };
}

function lostContactHero(view: ViewContext): HeroModel {
  // Stop watching is a command that is retried against whichever window takes over, and the host
  // sets Emergency stop when nobody acknowledges it: the one button that works with no contact.
  const label = view.pending === 'disarm' ? buttons.stopping : buttons.keepOn;
  return {
    ...BASE,
    kind: 'lostContact',
    glyph: glyph('question', 'cantTell'),
    live: 'alert',
    title: hero.lostContactTitle,
    lead: lostContactSentence(),
    primary: heroControl(label, 'secondary', sending(toHost.stop())),
    secondary: present([showLog(), stopFolder()]),
  };
}

function isolatedHero(): HeroModel {
  return {
    ...BASE,
    kind: 'isolated',
    glyph: glyph('error', 'broken'),
    live: 'alert',
    title: hero.isolatedTitle,
    lead: isolatedSentence(),
    primary: heroControl(buttons.showLog, 'secondary', sending(toHost.showLog())),
    secondary: present([stopFolder()]),
  };
}

function modelFor(variant: HeroVariant, state: UiState | null, view: ViewContext, clock: HeroClock): HeroModel {
  if (variant.kind === 'isolated') return isolatedHero();
  if (variant.kind === 'connecting') return connectingHero();
  if (variant.kind === 'lostContact' || state === null) return lostContactHero(view);
  switch (variant.kind) {
    case 'countdown':
    case 'committing':
      return countdownHero(variant, state, view);
    case 'executing':
      return executingHero(state);
    case 'result':
      return resultHero(variant.result, state, view);
    case 'cantRun':
      return cantRunHero(variant.problem, state);
    case 'degraded':
      return degradedHero(variant.armed, state, view, clock);
    case 'off':
      return offHero();
    case 'confirming':
      return confirmingHero(state, view, clock);
    case 'watching':
      return watchingHero(state, view);
  }
}

/** Drops every control that would do nothing from this window (see actions.worksHere). */
export function buildHero(variant: HeroVariant, state: UiState | null, view: ViewContext, clock: HeroClock): HeroModel {
  const model = modelFor(variant, state, view, clock);
  return {
    ...model,
    primary: model.primary !== null && worksHere(model.primary.action, view) ? model.primary : null,
    secondary: model.secondary.filter((item) => worksHere(item.action, view)),
  };
}

export interface Speech {
  /** Spoken when the screen reader is idle. */
  polite: string;
  /** Interrupts. */
  assertive: string;
}

/**
 * What the live regions say outside a countdown: the state line, followed by what is being waited
 * for (or the lead). Nothing here ticks, so it is spoken only when the state really changes.
 */
export function heroSpeech(model: HeroModel, waitingFor: string): Speech {
  const follow = model.live === 'status' && waitingFor !== '' ? waitingFor : model.lead;
  const sentence = nonEmpty([model.title, follow]).map(endSentence).join(' ');
  return model.live === 'alert' ? { polite: '', assertive: sentence } : { polite: sentence, assertive: '' };
}

/** The one-off alert when a countdown appears: "Shutting down this PC in 1 minute 30 seconds. Press Escape to cancel." */
export function countdownAnnouncement(countdown: HeroCountdown, seconds: number): string {
  const parts = [`${countdown.announceTitle} ${fmtSpoken(seconds)}.`, countdown.announceBody, hero.escapeHint];
  return nonEmpty(parts).join(' ');
}
