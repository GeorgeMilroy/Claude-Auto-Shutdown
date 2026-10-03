// Turns what this window may show (WindowSnapshot) into what the editor's own surfaces display:
// the status bar item and the context keys. Pure - statusBar.ts and contextKeys.ts only apply
// the result. The words come from shared/text.ts, so the status bar and the dashboard never
// describe one state in two ways.

import type { UiState } from '../shared/protocol';
import { countdownToast, statusBarText } from '../shared/text';
import type { StatusBarText } from '../shared/text';
import { copy } from './copy';
import { CONTEXT_KEYS } from './ids';
import type { CommandId, ContextKey, InternalCommandId } from './ids';
import { commandLink, escapeMarkdown } from './markdown';
import { countdownOf, isRecord, mayBeWatching, remainingSeconds } from './snapshot';
import type { CountdownView, WindowSnapshot } from './snapshot';

export interface StatusBarModel {
  /** With $(codicon) syntax. */
  text: string;
  /** Markdown source. Every value that came from a state is escaped; the links are ours. */
  tooltip: string;
  /** The only commands the tooltip's links may run. */
  tooltipCommands: CommandId[];
  background: 'none' | 'warning' | 'error';
  /** What a click runs; null = nothing. */
  command: CommandId | InternalCommandId | null;
  visible: boolean;
}

interface TooltipLink {
  label: string;
  command: CommandId;
}

const OPEN_DASHBOARD: TooltipLink = { label: copy.openDashboard, command: 'claudeAutoShutdown.open' };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function limitedLine(state: UiState | null): string {
  const leader: unknown = state?.leader;
  const source = isRecord(leader) ? leader : {};
  return copy.limited(text(source.app), text(source.ext));
}

function tooltipLinks(snapshot: WindowSnapshot, countdown: CountdownView | null): TooltipLink[] {
  const { state } = snapshot;
  if (state === null) return [OPEN_DASHBOARD];
  if (countdown !== null) {
    return [{ label: countdownToast(state).cancelLabel, command: 'claudeAutoShutdown.cancelCountdown' }, OPEN_DASHBOARD];
  }
  if (state.phase === 'executing') return [OPEN_DASHBOARD];
  if (mayBeWatching(state)) return [{ label: copy.stopWatching, command: 'claudeAutoShutdown.stop' }, OPEN_DASHBOARD];
  // Starting is not one of the two things that work across versions.
  if (snapshot.limited) return [OPEN_DASHBOARD];
  return [{ label: copy.startWatching, command: 'claudeAutoShutdown.start' }, OPEN_DASHBOARD];
}

function clickCommand(click: StatusBarText['click'], limited: boolean): StatusBarModel['command'] {
  switch (click) {
    case 'cancel':
      return 'claudeAutoShutdown.cancelCountdownFromStatusBar';
    case 'start':
      return limited ? 'claudeAutoShutdown.open' : 'claudeAutoShutdown.start';
    case 'open':
      return 'claudeAutoShutdown.open';
    default:
      return null;
  }
}

/** `nowMono` = performance.now(); the countdown digits are derived from it, never decremented. */
export function statusBarModel(snapshot: WindowSnapshot, nowMono: number, showStatusBar: boolean): StatusBarModel {
  const countdown = countdownOf(snapshot.state);
  const words = statusBarText(snapshot.state, snapshot.role, remainingSeconds(snapshot, nowMono));
  const links = tooltipLinks(snapshot, countdown);
  const lines = [...(snapshot.limited ? [limitedLine(snapshot.state)] : []), ...words.tooltip]
    .map((line) => escapeMarkdown(String(line)))
    .filter((line) => line !== '');
  return {
    text: words.text,
    tooltip: [...lines, links.map((link) => commandLink(link.label, link.command)).join(' · ')].join('\n\n'),
    tooltipCommands: links.map((link) => link.command),
    background: words.background,
    command: clickCommand(words.click, snapshot.limited),
    // A running countdown is shown whatever the setting says: the item is one of the ways to cancel.
    visible: showStatusBar || countdown !== null,
  };
}

export type ContextKeyValues = Record<Exclude<ContextKey, typeof CONTEXT_KEYS.previewDone>, boolean | string>;

/**
 * Values for the when-clauses of commands and the Esc key binding.
 * Without a trustworthy state nobody can say that this PC is NOT being watched, so `watching` is
 * on: "Stop Watching" stays in the Command Palette and "Start Watching" does not appear.
 */
export function contextKeyValues(snapshot: WindowSnapshot): ContextKeyValues {
  const { state, role } = snapshot;
  const countdown = countdownOf(state);
  return {
    [CONTEXT_KEYS.watching]: mayBeWatching(state),
    [CONTEXT_KEYS.countdownActive]: countdown !== null,
    [CONTEXT_KEYS.realCountdown]: countdown !== null && countdown.kind === 'real',
    [CONTEXT_KEYS.phase]: state === null ? (role === 'isolated' ? 'isolated' : 'unknown') : String(state.phase),
    [CONTEXT_KEYS.testPassed]: state !== null && state.testPassedOnce === true,
  };
}
