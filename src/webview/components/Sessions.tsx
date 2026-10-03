// The sessions list. One tab stop (roving tabindex): Up / Down move between rows, Right or Enter
// opens a row, Left closes it. An open row shows the raw details, the last transcript events, the
// subagents and the "Don't wait for…" overrides.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TranscriptEvent } from '../../core/types';
import { glyph } from '../icons';
import { toHost } from '../messages';
import { isOpen } from '../persist';
import { rowKeyIntent, tabStopIndex } from '../roving';
import { previewLength } from '../sessionsModel';
import type { SessionRow, SessionsModel } from '../sessionsModel';
import type { PreviewEntry } from '../store';
import { regions, sessions as copy } from '../strings';
import { Chevron, Icon, LinkButton, LinkRow, Meter, PlainIcon, SectionTitle, useDispatch } from './ui';

export interface SessionsProps {
  model: SessionsModel;
  previews: Record<string, PreviewEntry>;
  /** Session key -> the user opened / closed the row. */
  choices: Record<string, boolean>;
  finishedOpen: boolean;
  /** Two-column layout: rows are open unless closed, and previews are longer. */
  wide: boolean;
  onToggleRow(key: string, open: boolean): void;
  onToggleFinished(open: boolean): void;
}

function PreviewLines({ entry, wide }: { entry: PreviewEntry | undefined; wide: boolean }) {
  if (entry === undefined) return <p class="preview__status">{copy.previewLoading}</p>;
  if (entry.error !== null) return <p class="preview__status">{entry.error}</p>;
  if (entry.events.length === 0) return <p class="preview__status">{copy.previewEmpty}</p>;
  // Newest first: the line that explains the current status is the one on top.
  const shown: TranscriptEvent[] = entry.events.slice(-previewLength(wide)).reverse();
  return (
    <>
      <ol class="preview">
        {shown.map((event, index) => (
          <li class={`preview__event preview__event--${event.kind}`} key={`${event.time}-${index}`}>
            <span class="preview__time">{event.time}</span>
            <span class="preview__who">{copy.speaker[event.who]}</span>
            <span class="preview__text">{event.text}</span>
          </li>
        ))}
      </ol>
      <p class="preview__count">{copy.previewCount(shown.length)}</p>
    </>
  );
}

function RowPanel({ row, id, entry, wide }: { row: SessionRow; id: string; entry: PreviewEntry | undefined; wide: boolean }) {
  const links = [row.openTranscript, row.dontWait].filter((item) => item !== null);
  return (
    <div class="row__panel" id={id}>
      <p class="details">{row.details}</p>
      {row.notes.map((note) => (
        <p class="row__note" key={note}>
          {note}
        </p>
      ))}
      {row.hasTranscript && <PreviewLines entry={entry} wide={wide} />}
      {row.subagentsHeading !== null && (
        <div class="subagents">
          <p class="subagents__title">
            <PlainIcon name="type-hierarchy-sub" /> {row.subagentsHeading}
          </p>
          <ul class="subagents__list">
            {row.subagents.map((subagent) => (
              <li key={subagent.key} class={subagent.active ? 'subagent subagent--active' : 'subagent'}>
                <span class="subagent__name">{subagent.name}</span> · {subagent.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <LinkRow controls={links} class="row__links" />
    </div>
  );
}

interface SessionItemProps {
  row: SessionRow;
  open: boolean;
  tabStop: boolean;
  entry: PreviewEntry | undefined;
  wide: boolean;
  onToggle(open: boolean): void;
  onFocus(): void;
}

function SessionItem({ row, open, tabStop, entry, wide, onToggle, onFocus }: SessionItemProps) {
  const { request } = useDispatch();
  const panelId = `session-${row.key}`;
  useEffect(() => {
    // Asked again whenever the session writes: the preview follows the transcript.
    if (open && row.hasTranscript) request(toHost.requestPreview(row.key));
  }, [open, row.hasTranscript, row.key, row.lastActivityMs, request]);

  return (
    <li class={`session${row.ignored ? ' session--ignored' : ''}`}>
      <button
        type="button"
        class="row row--session"
        data-session-row={row.key}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        tabIndex={tabStop ? 0 : -1}
        title={row.tooltip}
        onClick={() => onToggle(!open)}
        onFocus={onFocus}
      >
        <Icon glyph={row.glyph} />
        <span class="row__main">
          <span class="row__head">
            <span class="row__name">{row.name}</span>
            <span class="row__status">{row.status}</span>
          </span>
          {row.tags.length > 0 && (
            <span class="row__tags">
              {row.tags.map((tag) => (
                <span class="tag" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
          <span class="row__line">{row.line}</span>
          {row.hint !== null && <span class="row__hint">{row.hint}</span>}
        </span>
        <Chevron open={open} />
      </button>
      {row.meter !== null && <Meter fraction={row.meter.fraction} valueText={row.meter.valueText} class="row__meter" />}
      {row.undo !== null && (
        <p class="row__after">
          <LinkButton control={row.undo} class="link--inline" />
        </p>
      )}
      {row.children.map((child) => (
        <p class="row__after row__child" key={child.key}>
          <PlainIcon name="terminal" />
          <span>
            {child.text}
            {child.control !== null && (
              <>
                {' · '}
                <LinkButton control={child.control} class="link--inline" />
              </>
            )}
          </span>
        </p>
      ))}
      {open && <RowPanel row={row} id={panelId} entry={entry} wide={wide} />}
    </li>
  );
}

const ROW_SELECTOR = 'button[data-session-row]';

export function Sessions({ model, previews, choices, finishedOpen, wide, onToggleRow, onToggleFinished }: SessionsProps) {
  const list = useRef<HTMLUListElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const fold = model.finishedFold;
  const folded = fold !== null && !finishedOpen ? new Set(fold.keys) : null;
  const active = model.rows.filter((row) => fold === null || !row.finished);
  const finished = fold === null ? [] : model.rows.filter((row) => row.finished);
  const visible = [...active, ...(folded === null ? finished : [])];
  const stop = tabStopIndex(visible.map((row) => row.key), focusedKey);
  const rowOpen = (row: SessionRow): boolean => isOpen(choices, row.key, wide);

  function onKeyDown(event: KeyboardEvent): void {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR) ?? []);
    const index = buttons.findIndex((button) => button === event.target);
    const row = visible[index];
    if (row === undefined) return;
    const intent = rowKeyIntent(event.key, index, buttons.length, rowOpen(row));
    if (intent === null) return;
    event.preventDefault();
    if ('move' in intent) buttons[intent.move]?.focus();
    else onToggleRow(row.key, intent.expand);
  }

  const renderRow = (row: SessionRow) => (
    <SessionItem
      key={row.key}
      row={row}
      open={rowOpen(row)}
      tabStop={visible[stop]?.key === row.key}
      entry={previews[row.key]}
      wide={wide}
      onToggle={(open) => onToggleRow(row.key, open)}
      onFocus={() => setFocusedKey(row.key)}
    />
  );

  return (
    <section class={`sessions${model.stale ? ' sessions--stale' : ''}`} aria-label={regions.sessions}>
      <SectionTitle>{model.heading}</SectionTitle>
      {model.empty !== null ? (
        model.empty.map((line) => (
          <p class="sessions__empty" key={line}>
            {line}
          </p>
        ))
      ) : (
        <ul class="sessions__list" ref={list} onKeyDown={onKeyDown}>
          {active.map(renderRow)}
          {fold !== null && (
            <li class="session session--fold">
              <button
                type="button"
                class="row row--fold"
                aria-expanded={finishedOpen}
                onClick={() => onToggleFinished(!finishedOpen)}
              >
                <Icon glyph={glyph('pass', 'passed')} />
                <span class="row__main">{fold.label}</span>
                <Chevron open={finishedOpen} />
              </button>
            </li>
          )}
          {folded === null && finished.map(renderRow)}
        </ul>
      )}
      {model.omitted !== null && <p class="sessions__omitted">{model.omitted}</p>}
    </section>
  );
}
