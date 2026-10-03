// Sentences the hero shares with the status bar. shared/text.ts exposes them only as tooltip
// lines of statusBarText; they are taken from there rather than typed again, so the dashboard and
// the status bar can never describe the same state with different words.

import type { Check, CheckId, CheckState } from '../core/types';
import type { UiState } from '../shared/protocol';
import { describeCheck, statusBarText } from '../shared/text';
import type { TextContext } from '../shared/text';

/** Any role that is not 'isolated': the wording then depends on the state alone. */
const ANY_CONNECTED_ROLE = 'leader';

function tooltipOf(state: UiState): string[] {
  return statusBarText(state, ANY_CONNECTED_ROLE, null).tooltip;
}

/** "Watching · for real since 23:02. This PC will shut down when Claude finishes." */
export function watchingSentence(state: UiState): string {
  return tooltipOf(state)[0] ?? '';
}

/** "Keep VS Code open." - the last tooltip line of every watching state. */
export function keepOpenSentence(state: UiState): string {
  const lines = tooltipOf(state);
  return lines.length > 1 ? (lines[lines.length - 1] ?? '') : '';
}

/** "Everything looks finished. Making sure it stays that way (check 2 of 3)." */
export function confirmingSentence(state: UiState): string {
  return tooltipOf(state)[1] ?? '';
}

/** "Shutting down this PC now…" / "Test run: nothing will turn off." */
export function executingSentence(state: UiState): string {
  return tooltipOf(state).join(' ');
}

export function lostContactSentence(): string {
  return statusBarText(null, 'follower', null).tooltip.join(' ');
}

export function isolatedSentence(): string {
  return statusBarText(null, 'isolated', null).tooltip.join(' ');
}

export function textContextOf(state: UiState): TextContext {
  return { contract: state.contract, osName: state.platform.osName, sessions: state.sessions };
}

/**
 * The detail sentence of a check that is not (or not necessarily) in `state.checks`, e.g. the
 * Emergency stop sentence for a banner. Built by handing describeCheck a check with that state.
 */
export function checkSentence(
  id: CheckId,
  checkState: CheckState,
  data: Check['data'],
  context: TextContext,
): string {
  return describeCheck({ id, state: checkState, data }, context).detail;
}
