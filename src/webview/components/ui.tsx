// Small building blocks shared by every section.

import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import type { WebviewToHost } from '../../shared/protocol';
import type { Control, UiAction } from '../actions';
import type { Glyph, IconName } from '../icons';

export interface Dispatch {
  /** Run what a control does (subject to the countdown rule). */
  run(action: UiAction): void;
  /** Post a message that is not a user action (a transcript preview request). */
  request(message: WebviewToHost | null): void;
}

export const DispatchContext = createContext<Dispatch>({ run: () => undefined, request: () => undefined });

export function useDispatch(): Dispatch {
  return useContext(DispatchContext);
}

/** Decorative: every icon sits next to the words that say the same thing. */
export function Icon({ glyph, class: extra }: { glyph: Glyph; class?: string }) {
  const spin = glyph.spin ? ' codicon-modifier-spin' : '';
  return (
    <span
      class={`codicon codicon-${glyph.icon}${spin} icon icon--${glyph.tone}${extra === undefined ? '' : ` ${extra}`}`}
      aria-hidden="true"
    />
  );
}

export function PlainIcon({ name, class: extra }: { name: IconName; class?: string }) {
  return <span class={`codicon codicon-${name} icon${extra === undefined ? '' : ` ${extra}`}`} aria-hidden="true" />;
}

export function Chevron({ open }: { open: boolean }) {
  return <PlainIcon name={open ? 'chevron-down' : 'chevron-right'} class="chevron" />;
}

export function LinkButton({ control, class: extra }: { control: Control; class?: string }) {
  const { run } = useDispatch();
  return (
    <button type="button" class={`link${extra === undefined ? '' : ` ${extra}`}`} onClick={() => run(control.action)}>
      {control.label}
    </button>
  );
}

/** Links on one wrapping line, separated by a middle dot. */
export function LinkRow({ controls, class: extra }: { controls: readonly Control[]; class?: string }) {
  if (controls.length === 0) return null;
  return (
    <div class={`link-row${extra === undefined ? '' : ` ${extra}`}`}>
      {controls.map((item, index) => (
        <span class="link-row__item" key={item.label}>
          {index > 0 && (
            <span class="link-row__dot" aria-hidden="true">
              ·
            </span>
          )}
          <LinkButton control={item} />
        </span>
      ))}
    </div>
  );
}

export interface MeterProps {
  /** 0..1 */
  fraction: number;
  valueText: string;
  class?: string;
}

export function Meter({ fraction, valueText, class: extra }: MeterProps) {
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 100);
  return (
    <div
      class={`meter${extra === undefined ? '' : ` ${extra}`}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
    >
      <div class="meter__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function SectionTitle({ children }: { children: ComponentChildren }) {
  return <h2 class="section__title">{children}</h2>;
}
