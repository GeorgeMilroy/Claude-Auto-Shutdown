// The parts around the main sections: the banner slot, the footer, the screen-reader announcer and
// the fallback shown when rendering itself fails.

import { Component } from 'preact';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { WebviewToHost } from '../../shared/protocol';
import type { BannerModel } from '../banners';
import type { FooterModel } from '../footerModel';
import { glyph } from '../icons';
import { toHost } from '../messages';
import { buttons, crash, footer as copy, regions } from '../strings';
import { Chevron, Icon, LinkButton, PlainIcon } from './ui';

export function Banners({ banners }: { banners: readonly BannerModel[] }) {
  if (banners.length === 0) return null;
  return (
    <div class="banners" role="region" aria-label={regions.notices}>
      {banners.map((banner) => (
        <div class={`banner banner--${banner.tone}`} key={banner.id}>
          <PlainIcon name={banner.icon} />
          <p class="banner__text">
            {banner.text}
            {banner.control !== null && (
              <>
                {' '}
                <LinkButton control={banner.control} class="link--inline" />
              </>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

export function Footer({ model }: { model: FooterModel }) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <footer class="footer">
      <div class="link-row">
        {model.links.map((item, index) => (
          <span class="link-row__item" key={item.label}>
            {index > 0 && (
              <span class="link-row__dot" aria-hidden="true">
                ·
              </span>
            )}
            <LinkButton control={item} />
          </span>
        ))}
        {model.help.length > 0 && (
          <span class="link-row__item">
            {model.links.length > 0 && (
              <span class="link-row__dot" aria-hidden="true">
                ·
              </span>
            )}
            <button
              type="button"
              class="link"
              aria-expanded={helpOpen}
              aria-controls={helpOpen ? 'footer-help' : undefined}
              onClick={() => setHelpOpen(!helpOpen)}
            >
              {copy.help}
              <Chevron open={helpOpen} />
            </button>
          </span>
        )}
      </div>
      {helpOpen && (
        <ul class="footer__help" id="footer-help">
          {model.help.map((item) => (
            <li key={item.label}>
              <LinkButton control={item} />
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}

export interface AnnouncerProps {
  /** Spoken when the reader is idle: the state line, and the countdown marks. */
  polite: string;
  /** Interrupts: results, "can't tell", lost contact, and the start of a countdown. */
  assertive: string;
}

/**
 * The two live regions. They stay mounted for the whole life of the page - a live region that is
 * inserted together with its text is not reliably announced - and only their text changes.
 */
export function Announcer({ polite, assertive }: AnnouncerProps) {
  return (
    <>
      <div class="sr-only" role="status" aria-atomic="true">
        {polite}
      </div>
      <div class="sr-only" role="alert" aria-atomic="true">
        {assertive}
      </div>
    </>
  );
}

interface BoundaryProps {
  post(message: WebviewToHost): void;
  children: ComponentChildren;
}

/**
 * If a state ever makes rendering throw, the dashboard must not go blank: a blank page has no
 * Cancel. The fallback knows nothing about the state and offers the two commands that are always
 * accepted, plus the log.
 */
export class CrashBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static override getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const { post } = this.props;
    return (
      <main class="app app--solo">
        <section class="hero hero--plain" aria-label={regions.status}>
          <div class="hero__state" role="alert">
            <Icon glyph={glyph('error', 'broken')} />
            <h1 class="hero__title">{crash.title}</h1>
          </div>
          <p class="hero__lead">{crash.lead}</p>
          <p class="hero__body">{crash.hint}</p>
          <button type="button" class="btn btn--primary hero__primary" onClick={() => post(toHost.cancel())}>
            {crash.cancel}
          </button>
          <button type="button" class="btn btn--secondary hero__primary" onClick={() => post(toHost.stop())}>
            {buttons.stopWatching}
          </button>
          <div class="link-row hero__secondary">
            <button type="button" class="link" onClick={() => post(toHost.showLog())}>
              {buttons.showLog}
            </button>
          </div>
        </section>
      </main>
    );
  }
}
