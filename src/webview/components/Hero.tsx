// The hero card: state line, consequence sentence, slot P (one safe or neutral button), the row
// of secondary links below it. During a countdown it is the only live part of the page.

import { useEffect, useRef } from 'preact/hooks';
import { fmtClock } from '../../shared/text';
import { remainingFraction, remainingSeconds, URGENT_SECONDS } from '../clock';
import type { CountdownAnchor } from '../clock';
import type { HeroConfirm, HeroControl, HeroModel } from '../hero';
import { glyph } from '../icons';
import { hero as copy, regions } from '../strings';
import { Icon, LinkRow, useDispatch } from './ui';

function PrimaryButton({ control, focusOnMount }: { control: HeroControl; focusOnMount: boolean }) {
  const { run } = useDispatch();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Take the focus only when it is already inside the dashboard: a countdown that appears while
    // the user types in the editor must not steal their keystrokes.
    if (focusOnMount && document.hasFocus()) button.current?.focus();
  }, [focusOnMount]);
  return (
    <button
      ref={button}
      type="button"
      class={`btn btn--${control.emphasis} hero__primary`}
      onClick={() => run(control.action)}
    >
      {control.label}
    </button>
  );
}

function ConfirmDots({ confirm }: { confirm: HeroConfirm }) {
  const dots = Array.from({ length: confirm.n }, (_, index) => index < confirm.k);
  return (
    <p class="hero__confirm">
      <span aria-hidden="true">{confirm.label}</span>
      <span class="sr-only">{confirm.spoken}</span>
      <span class="dots" aria-hidden="true">
        {dots.map((done, index) =>
          // Done and pending differ in shape (a ticked circle, an empty ring), not only in colour.
          done ? <Icon key={index} glyph={glyph('pass', 'passed')} class="dot" /> : <span key={index} class="dot dot--pending" />,
        )}
      </span>
      {confirm.next !== null && <span class="hero__next">{confirm.next}</span>}
    </p>
  );
}

function Clock({ anchor, now, urgentAllowed }: { anchor: CountdownAnchor | null; now: number; urgentAllowed: boolean }) {
  // Without a usable value the clock reads 0:00: a warning never shows more time than may be left.
  const seconds = anchor === null ? 0 : remainingSeconds(anchor, now);
  const fraction = anchor === null ? null : remainingFraction(anchor, now);
  const urgent = urgentAllowed && seconds <= URGENT_SECONDS;
  return (
    <>
      <div class={`hero__digits${urgent ? ' hero__digits--urgent' : ''}`} aria-hidden="true">
        {fmtClock(seconds)}
      </div>
      {fraction !== null && (
        <div class="meter meter--countdown" aria-hidden="true">
          <div class="meter__fill" style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
        </div>
      )}
      <span class="sr-only" role="timer">
        {copy.timeLeft(seconds)}
      </span>
    </>
  );
}

export interface HeroProps {
  model: HeroModel;
  anchor: CountdownAnchor | null;
  /** performance.now() of this render. */
  now: number;
}

export function Hero({ model, anchor, now }: HeroProps) {
  const countdown = model.countdown;
  const strip = model.frame !== 'plain';
  return (
    <section class={`hero hero--${model.frame} hero--${model.kind}`} aria-label={regions.status}>
      <div class={`hero__state${strip ? ' hero__state--strip' : ''}`}>
        <Icon glyph={model.glyph} />
        <h1 class="hero__title">{model.title}</h1>
      </div>
      {model.lead !== null && <p class="hero__lead">{model.lead}</p>}
      {countdown !== null && !countdown.committing && (
        <Clock anchor={anchor} now={now} urgentAllowed={countdown.kind === 'real'} />
      )}
      {countdown === null && model.body.map((line) => (
        <p class="hero__body" key={line}>
          {line}
        </p>
      ))}
      {model.confirm !== null && <ConfirmDots confirm={model.confirm} />}
      {model.primary !== null && <PrimaryButton control={model.primary} focusOnMount={countdown !== null} />}
      <LinkRow controls={model.secondary} class="hero__secondary" />
      {countdown !== null && <p class="hero__note">{countdown.mouseLine}</p>}
      {countdown !== null && model.body.map((line) => (
        <p class="hero__body" key={line}>
          {line}
        </p>
      ))}
      {model.notes.map((line) => (
        <p class="hero__note" key={line}>
          {line}
        </p>
      ))}
      {model.warning !== null && (
        <p class="hero__warning">
          <Icon glyph={glyph('warning', 'cantTell')} />
          <span>{model.warning}</span>
        </p>
      )}
    </section>
  );
}
