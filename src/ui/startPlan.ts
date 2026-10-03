// The decisions of the start flow that need no editor API: whether watching can be started from
// this window at all, whether the plan needs the confirmation dialog, and what the Start picker
// offers. startFlow.ts asks the questions and shows the dialogs.

import type { ArmContract, PowerAction } from '../shared/config';
import type { UiState } from '../shared/protocol';
import { copy } from './copy';
import { isRecord } from './snapshot';
import type { WindowSnapshot } from './snapshot';

/** Why watching cannot be started from this window right now; null when it can be tried. */
export function startRefusal(snapshot: WindowSnapshot): string | null {
  if (snapshot.role === 'isolated') return copy.isolated;
  const { state } = snapshot;
  if (state === null) return copy.notConnected;
  if (snapshot.limited) return copy.limited(textOf(state.leader, 'app'), textOf(state.leader, 'ext'));
  if (state.armed !== false) return copy.alreadyWatching;
  // The epoch ties the request to the leader the user was looking at; without one nothing is sent.
  if (typeof state.epoch !== 'string' || state.epoch === '') return copy.unreadableState;
  return null;
}

function textOf(record: unknown, key: string): string | null {
  const value: unknown = isRecord(record) ? record[key] : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A plan that will do something to this PC is confirmed in a dialog every time. Only an explicit
 * test run, or "just notify me", starts without one.
 */
export function needsConfirmation(plan: ArmContract): boolean {
  return plan.action !== 'notify' && plan.testMode !== true;
}

/** Names of connected remote windows whose Claude sessions the leader cannot see. */
export function unseenRemotes(state: UiState): string[] {
  const windows: unknown[] = Array.isArray(state.remoteWindows) ? state.remoteWindows : [];
  return windows
    .filter(isRecord)
    .filter((window) => window.covered !== true && typeof window.name === 'string')
    .map((window) => window.name as string);
}

/**
 * The leader shows its own settings as the plan while not watching. When it reads the same
 * settings as this window, its plan must have caught up with a change made here before "start" is
 * sent - otherwise it refuses with "Settings changed". Another editor's leader never catches up,
 * and there is nothing to wait for.
 */
export function leaderHasPlan(state: UiState | null, realm: string, digest: string): boolean {
  if (state === null || state.armed !== false) return true;
  return state.contractRealm !== realm || state.contractDigest === digest;
}

/** What a choice in the Start picker changes in the settings before watching starts. */
export interface PlanChange {
  action?: PowerAction;
  testMode?: boolean;
}

export interface StartChoice {
  label: string;
  detail: string;
  /** null = this choice opens the setting instead of starting. */
  change: PlanChange | null;
}

/** Test run / For real / Just notify me, for the action that is configured now. */
export function startChoices(action: PowerAction): StartChoice[] {
  const picker = copy.startPicker;
  const notify: StartChoice = { label: picker.notify, detail: picker.notifyDetail, change: { action: 'notify' } };
  // With "just notify me" selected there is no action to test or to run for real.
  if (action === 'notify') return [notify, { label: picker.chooseAction, detail: picker.chooseActionDetail, change: null }];
  return [
    { label: picker.test, detail: picker.testDetail(action), change: { testMode: true } },
    { label: picker.real(action), detail: picker.realDetail(action), change: { testMode: false } },
    notify,
  ];
}
