// The plan: action select, test / real radios, the timing line and the one button that starts
// watching. That button is the only guarded control on the dashboard (see clickGuard.ts).

import type { Ref } from 'preact';
import { POWER_ACTIONS } from '../../shared/config';
import type { PowerAction } from '../../shared/config';
import type { PlanModel } from '../planModel';
import { glyph } from '../icons';
import { sending } from '../actions';
import { toHost } from '../messages';
import { plan as copy, regions } from '../strings';
import { Icon, LinkButton, SectionTitle, useDispatch } from './ui';

export interface PlanChange {
  action?: PowerAction;
  testMode?: boolean;
}

export interface PlanProps {
  model: PlanModel;
  /** The element "Start again…" and the host's focusPlan scroll to and focus. */
  anchor: Ref<HTMLElement>;
  onChange(change: PlanChange): void;
}

const ACTION_ERROR_ID = 'plan-action-error';
const START_NOTE_ID = 'plan-start-note';

function asAction(value: string): PowerAction | null {
  return POWER_ACTIONS.find((action) => action === value) ?? null;
}

type EditModel = Extract<PlanModel, { kind: 'edit' }>;

function ModeRadios({ modes, onChange }: { modes: NonNullable<EditModel['modes']>; onChange(change: PlanChange): void }) {
  return (
    <div class="plan__modes" role="radiogroup" aria-label={copy.modeLabel}>
      <label class="radio">
        <input type="radio" name="plan-mode" checked={modes.testMode} onChange={() => onChange({ testMode: true })} />
        <span>{modes.testLabel}</span>
      </label>
      <label class="radio">
        <input type="radio" name="plan-mode" checked={!modes.testMode} onChange={() => onChange({ testMode: false })} />
        <span>{modes.realLabel}</span>
      </label>
    </div>
  );
}

function StartButton({ start }: { start: EditModel['start'] }) {
  const { run } = useDispatch();
  const startAction = sending(toHost.start());
  const describedBy = start.seeActionError ? ACTION_ERROR_ID : start.note === null ? undefined : START_NOTE_ID;
  return (
    <>
      <button
        type="button"
        class="btn btn--primary plan__start"
        aria-disabled={start.blocked}
        aria-describedby={describedBy}
        onClick={() => {
          if (!start.blocked && startAction !== null) run(startAction);
        }}
      >
        {start.label}
      </button>
      {/* Always present, with a line's height: nothing below jumps when the guard lifts. */}
      <p class="plan__reason" id={START_NOTE_ID}>
        {start.note}
      </p>
    </>
  );
}

function EditablePlan({ model, anchor, onChange }: { model: EditModel; anchor: Ref<HTMLElement>; onChange(change: PlanChange): void }) {
  return (
    <form class="plan" aria-label={regions.plan} ref={anchor as Ref<HTMLFormElement>} onSubmit={(event) => event.preventDefault()}>
      <SectionTitle>{model.heading}</SectionTitle>
      <label class="sr-only" for="plan-action">
        {copy.actionLabel}
      </label>
      <select
        id="plan-action"
        class="select"
        value={model.action}
        aria-invalid={model.actionError !== null}
        aria-describedby={model.actionError === null ? undefined : ACTION_ERROR_ID}
        onChange={(event) => {
          const action = asAction(event.currentTarget.value);
          if (action !== null) onChange({ action });
        }}
      >
        {model.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.unavailable ? copy.optionUnavailable(option.label) : option.label}
          </option>
        ))}
      </select>
      {model.actionError !== null && (
        <p class="plan__error" id={ACTION_ERROR_ID} role="alert">
          <Icon glyph={glyph('error', 'broken')} />
          <span>{model.actionError}</span>
        </p>
      )}
      {model.modes !== null && <ModeRadios modes={model.modes} onChange={onChange} />}
      {model.notifyNote !== null && <p class="plan__note">{model.notifyNote}</p>}
      <p class="plan__timing">
        {model.timing} {model.changeRules !== null && <LinkButton control={model.changeRules} class="link--inline" />}
      </p>
      <StartButton start={model.start} />
      {model.preview !== null && (
        <p class="plan__preview">
          <LinkButton control={model.preview} class="link--inline" />
        </p>
      )}
    </form>
  );
}

export function Plan({ model, anchor, onChange }: PlanProps) {
  if (model.kind === 'hidden') return null;
  if (model.kind === 'edit') return <EditablePlan model={model} anchor={anchor} onChange={onChange} />;
  return (
    <section class="plan plan--locked" aria-label={regions.plan} ref={anchor}>
      <SectionTitle>{model.heading}</SectionTitle>
      <p class="plan__summary">{model.summary}</p>
      <p class="plan__timing">{model.timing}</p>
      <p class="plan__note">{model.note}</p>
    </section>
  );
}
