// "Waiting for": one row per unmet lane, the overrides in force, and the folded list of raw checks.

import type { CheckRow, LaneRow, LanesModel } from '../lanesModel';
import { glyph } from '../icons';
import { isOpen } from '../persist';
import { lanes as copy, regions } from '../strings';
import { Chevron, Icon, LinkButton, Meter, PlainIcon, SectionTitle, useDispatch } from './ui';

export interface LanesProps {
  model: LanesModel;
  /** Lane id -> the user opened / closed it. */
  choices: Record<string, boolean>;
  checksOpen: boolean;
  onToggleLane(lane: string, open: boolean): void;
  onToggleChecks(open: boolean): void;
}

function CheckList({ checks, id }: { checks: readonly CheckRow[]; id: string }) {
  return (
    <ul class="checks" id={id}>
      {checks.map((check) => (
        <li class="check" key={check.id}>
          <Icon glyph={check.glyph} />
          <span class="check__text">
            <span class="check__head">
              <span class="check__label">{check.label}</span>
              <span class="check__state">{check.stateWord}</span>
            </span>
            <span class="check__detail">{check.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function LaneItem({ row, open, onToggle }: { row: LaneRow; open: boolean; onToggle(open: boolean): void }) {
  const { run } = useDispatch();
  const panelId = `lane-${row.lane}`;
  return (
    <li class="lane">
      <button
        type="button"
        class="row row--lane"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onToggle(!open)}
      >
        <Icon glyph={row.glyph} />
        <span class="row__main">
          <span class="row__head">
            <span class="row__title">{row.title}</span>
            <span class="row__text">{row.text}</span>
          </span>
          {row.sub !== null && <span class="row__line">{row.sub}</span>}
        </span>
        <Chevron open={open} />
      </button>
      {row.meter !== null && <Meter fraction={row.meter.fraction} valueText={row.meter.valueText} class="row__meter" />}
      {open && (
        <div class="row__panel" id={panelId}>
          <CheckList checks={row.checks} id={`${panelId}-checks`} />
          {row.actions.map((action) => (
            <p class={action.nested ? 'row__action row__action--nested' : 'row__action'} key={action.key}>
              {action.text !== null && <span>{action.text} </span>}
              <LinkButton control={action.control} class="link--inline" />
            </p>
          ))}
          {row.settings !== null && (
            <button
              type="button"
              class="icon-button row__gear"
              aria-label={row.settings.label}
              title={row.settings.label}
              onClick={() => row.settings !== null && run(row.settings.action)}
            >
              <PlainIcon name="gear" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function Lanes({ model, choices, checksOpen, onToggleLane, onToggleChecks }: LanesProps) {
  const fold = model.fold;
  return (
    <section class="lanes" aria-label={regions.waitingFor}>
      <SectionTitle>{model.heading}</SectionTitle>
      {model.notice !== null && (
        <p class="notice">
          <Icon glyph={glyph('circle-slash', 'neutral')} />
          <span>{model.notice}</span>
        </p>
      )}
      {model.allClear !== null && <p class="lanes__clear">{model.allClear}</p>}
      <ul class="lanes__list">
        {model.rows.map((row) => (
          <LaneItem
            key={row.lane}
            row={row}
            open={isOpen(choices, row.lane, row.openByDefault)}
            onToggle={(open) => onToggleLane(row.lane, open)}
          />
        ))}
        {model.overrides.map((override) => (
          <li class="override" key={override.key}>
            <Icon glyph={glyph('debug-step-over', 'muted')} />
            <span class="override__text">
              {override.text} · {copy.notWaitedFor} · <LinkButton control={override.undo} class="link--inline" />
            </span>
          </li>
        ))}
        <li class="lane lane--fold">
          <button
            type="button"
            class="row row--fold"
            aria-expanded={checksOpen}
            aria-controls={checksOpen ? 'all-checks' : undefined}
            onClick={() => onToggleChecks(!checksOpen)}
          >
            <Icon glyph={fold.glyph} />
            <span class="row__main">{fold.label}</span>
            <Chevron open={checksOpen} />
          </button>
          {checksOpen && (
            <div class="row__panel">
              <CheckList checks={fold.checks} id="all-checks" />
            </div>
          )}
        </li>
      </ul>
      {model.earliest !== null && <p class="lanes__earliest">{model.earliest}</p>}
    </section>
  );
}
