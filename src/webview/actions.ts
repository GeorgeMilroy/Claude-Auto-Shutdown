// What a control on the dashboard does. View-models hand these to the components, which only run
// them: no component decides by itself what a click means.

import type { ViewContext, WebviewToHost } from '../shared/protocol';
import { worksWhenLimited } from './messages';

export type UiAction =
  /** Post these messages to the extension host, in order. */
  | { do: 'send'; messages: WebviewToHost[] }
  /** Scroll to the plan and focus it. Starts nothing. */
  | { do: 'focusPlan' }
  /** Select "For real" in the plan and focus it. Starts nothing. */
  | { do: 'switchToReal' };

export interface Control {
  label: string;
  action: UiAction;
}

/** An action that posts the given messages; null when any of them could not be built. */
export function sending(...messages: (WebviewToHost | null)[]): UiAction | null {
  const built = messages.filter((message): message is WebviewToHost => message !== null);
  if (built.length === 0 || built.length !== messages.length) return null;
  return { do: 'send', messages: built };
}

export function control(label: string, action: UiAction | null): Control | null {
  return action === null ? null : { label, action };
}

/**
 * Whether the action can do anything from this window. When the controlling window runs another
 * version, only Cancel, Stop watching and what the host answers by itself still work; a control
 * that would silently do nothing is not shown.
 */
export function worksHere(action: UiAction, view: ViewContext): boolean {
  if (!view.limited) return true;
  return action.do === 'send' && action.messages.every(worksWhenLimited);
}

/**
 * During a countdown the dashboard is one button: Cancel. The rest of the page is inert in the
 * DOM; this is the same rule for anything that reaches the dispatcher regardless.
 */
export function allowedDuringCountdown(action: UiAction): boolean {
  return action.do === 'send' && action.messages.every((message) => message.type === 'cancel');
}

export function present<T>(items: readonly (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}
