// The plan: what will happen when Claude finishes, and the button that starts watching.
// While not watching it shows THIS window's settings (view.plan); while watching it is a read-only
// summary of the contract in force (state.contract).

import { POWER_ACTIONS } from '../shared/config';
import type { ArmContract, PowerAction } from '../shared/config';
import type { UiState, ViewContext } from '../shared/protocol';
import { actionWords, startLabel, timingLine } from '../shared/text';
import { control, sending } from './actions';
import type { Control } from './actions';
import { isRecord, text } from './guards';
import { isWatching, modeOf } from './hero';
import type { HeroKind } from './hero';
import { toHost } from './messages';
import { checkSentence, textContextOf } from './sharedCopy';
import { endSentence, plan as copy } from './strings';
import type { Mode } from './strings';

/**
 * A choice made in the plan that the settings have not confirmed yet. Shown at once so the
 * controls feel immediate; dropped as soon as the host reports the same value, or after a few
 * seconds if it never does (the write failed) - the settings stay the truth.
 */
export interface PlanOverride {
  action?: PowerAction;
  testMode?: boolean;
  /** performance.now() when the user chose it. */
  at: number;
}

export const OVERRIDE_TTL_MS = 3000;

function isReflected(override: PlanOverride, plan: ArmContract): boolean {
  const actionSettled = override.action === undefined || override.action === plan.action;
  const modeSettled = override.testMode === undefined || override.testMode === plan.testMode;
  return actionSettled && modeSettled;
}

export function settleOverride(override: PlanOverride | null, plan: ArmContract, now: number): PlanOverride | null {
  if (override === null || isReflected(override, plan)) return null;
  const age = now - override.at;
  return Number.isFinite(age) && age >= 0 && age < OVERRIDE_TTL_MS ? override : null;
}

export function effectivePlan(plan: ArmContract, override: PlanOverride | null, now: number): ArmContract {
  const pending = settleOverride(override, plan, now);
  if (pending === null) return plan;
  return {
    ...plan,
    ...(pending.action === undefined ? {} : { action: pending.action }),
    ...(pending.testMode === undefined ? {} : { testMode: pending.testMode }),
  };
}

export interface ActionOption {
  value: PowerAction;
  label: string;
  /** The preflight says this action can't run on this PC. */
  unavailable: boolean;
}

export interface StartButton {
  label: string;
  /** The button ignores clicks: the action can't run here, Emergency stop is set, or the click guard is up. */
  blocked: boolean;
  /** The line under the button: why it is blocked, else a hint; null when there is nothing to add. */
  note: string | null;
  /** The reason it is blocked is the inline error under the action select. */
  seeActionError: boolean;
}

export type PlanModel =
  | { kind: 'hidden' }
  | { kind: 'locked'; heading: string; summary: string; timing: string; note: string }
  | {
      kind: 'edit';
      heading: string;
      action: PowerAction;
      options: ActionOption[];
      /** Inline error under the select. */
      actionError: string | null;
      /** null for "Just notify me": nothing ever turns off, so there is no test / real choice. */
      modes: { testMode: boolean; testLabel: string; realLabel: string } | null;
      notifyNote: string | null;
      timing: string;
      changeRules: Control | null;
      start: StartButton;
      preview: Control | null;
    };

function isUnavailable(state: UiState, action: PowerAction): boolean {
  const capability: unknown = state.platform.capabilities[action];
  // Only a definite "no" disables an action here; "can't tell" is refused by the leader when
  // watching starts, with its own explanation.
  return action !== 'notify' && isRecord(capability) && capability.ok === false;
}

function unavailableText(state: UiState, action: PowerAction): string {
  const capability: unknown = state.platform.capabilities[action];
  const detail = isRecord(capability) ? text(capability.detail) : null;
  if (detail === null) return copy.unavailable(action);
  return `${endSentence(detail)} ${copy.pickAnother}`;
}

/** What pressing Start leads to. A real run goes through a native confirmation first. */
const START_HINTS: Record<Mode, string | null> = { test: copy.testTakesLong, real: copy.confirmFirst, notify: null };

function startButton(state: UiState, plan: ArmContract, guarded: boolean): StartButton {
  const label = startLabel(plan);
  if (isUnavailable(state, plan.action)) return { label, blocked: true, note: null, seeActionError: true };
  // The leader refuses to start while Emergency stop is set; say so instead of failing after the click.
  if (state.stop.present) {
    const stopIsSet = checkSentence('stopFile', 'fail', {}, textContextOf(state));
    return { label, blocked: true, note: stopIsSet, seeActionError: false };
  }
  return { label, blocked: guarded, note: guarded ? copy.ready : START_HINTS[modeOf(plan)], seeActionError: false };
}

function lockedPlan(state: UiState): PlanModel {
  return {
    kind: 'locked',
    heading: copy.lockedHeading,
    summary: copy.lockedSummary(state.contract.action, modeOf(state.contract)),
    timing: timingLine(state.contract),
    note: copy.locked,
  };
}

function editablePlan(state: UiState, plan: ArmContract, guarded: boolean): PlanModel {
  const { action } = plan;
  const notify = action === 'notify';
  const unavailable = isUnavailable(state, action);
  return {
    kind: 'edit',
    heading: copy.heading,
    action,
    options: POWER_ACTIONS.map((value) => ({
      value,
      label: actionWords(value).menu,
      unavailable: isUnavailable(state, value),
    })),
    actionError: unavailable ? unavailableText(state, action) : null,
    modes: notify ? null : { testMode: plan.testMode === true, testLabel: copy.testRadio, realLabel: copy.realRadio(action) },
    notifyNote: notify ? copy.notifyNote : null,
    timing: timingLine(plan),
    changeRules: control(copy.changeRules, sending(toHost.openSettings())),
    start: startButton(state, plan, guarded),
    preview: control(copy.preview, sending(toHost.preview())),
  };
}

/** Hero states in which there is nothing to plan: no trustworthy state, or nothing can run here. */
const NO_PLAN: readonly HeroKind[] = ['isolated', 'connecting', 'lostContact', 'cantRun', 'executing'];

/**
 * `plan` = this window's settings with any not-yet-confirmed choice applied (effectivePlan).
 * `guarded` = the click guard is up.
 */
export function buildPlan(
  state: UiState | null,
  view: ViewContext,
  heroKind: HeroKind,
  plan: ArmContract,
  guarded: boolean,
): PlanModel {
  // From a window that can only Cancel and Stop, a plan would be a set of dead controls.
  if (state === null || view.limited || NO_PLAN.includes(heroKind)) return { kind: 'hidden' };
  return isWatching(state) ? lockedPlan(state) : editablePlan(state, plan, guarded);
}
