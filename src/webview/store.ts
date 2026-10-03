// Everything the dashboard knows, and how a message from the host changes it. Pure: the component
// tree renders a Snapshot, and time enters only as the `now` (performance.now()) of each message.

import type { TranscriptEvent } from '../core/types';
import type { HostToWebview, UiState, ViewContext } from '../shared/protocol';
import { anchorCountdown } from './clock';
import type { CountdownAnchor } from './clock';
import { heroKey } from './hero';
import { sanitizeView } from './sanitize';

export interface PreviewEntry {
  events: TranscriptEvent[];
  error: string | null;
}

export interface Snapshot {
  /** null = no trustworthy state (not connected yet, lost contact, isolated). */
  state: UiState | null;
  view: ViewContext;
  /** performance.now() when `state` arrived: the anchor for every duration inside it. */
  receivedAt: number;
  countdown: CountdownAnchor | null;
  /** Since when there has been no trustworthy state; null while there is one. */
  nullSince: number | null;
  /** See hero.heroKey: a change restarts the click guard. */
  heroKey: string;
  heroChangedAt: number;
  /** Transcript previews by session key. */
  previews: Record<string, PreviewEntry>;
  /** Counts 'focusPlan' requests from the host; a change moves focus to the plan. */
  focusPlanRequests: number;
}

export function initialSnapshot(now: number): Snapshot {
  const view = sanitizeView(undefined);
  return {
    state: null,
    view,
    receivedAt: now,
    countdown: null,
    nullSince: now,
    heroKey: heroKey(null, view),
    heroChangedAt: now,
    previews: {},
    focusPlanRequests: 0,
  };
}

/** Previews of sessions that are gone are dropped with them. */
function livePreviews(previews: Record<string, PreviewEntry>, state: UiState | null): Record<string, PreviewEntry> {
  if (state === null) return {};
  const live = new Set(state.sessions.map((session) => session.key));
  return Object.fromEntries(Object.entries(previews).filter(([key]) => live.has(key)));
}

function withState(snapshot: Snapshot, state: UiState | null, view: ViewContext, now: number): Snapshot {
  const key = heroKey(state, view);
  return {
    ...snapshot,
    state,
    view,
    receivedAt: now,
    countdown: state === null || state.countdown === null ? null : anchorCountdown(snapshot.countdown, state.countdown, now),
    nullSince: state === null ? (snapshot.nullSince ?? now) : null,
    heroKey: key,
    heroChangedAt: key === snapshot.heroKey ? snapshot.heroChangedAt : now,
    previews: livePreviews(snapshot.previews, state),
  };
}

/** `message` has been through messages.parseHostMessage; `now` is performance.now() at receipt. */
export function applyHostMessage(snapshot: Snapshot, message: HostToWebview, now: number): Snapshot {
  switch (message.type) {
    case 'state':
      return withState(snapshot, message.state, message.view, now);
    case 'preview':
      return {
        ...snapshot,
        previews: { ...snapshot.previews, [message.key]: { events: message.events, error: message.error } },
      };
    case 'focusPlan':
      return { ...snapshot, focusPlanRequests: snapshot.focusPlanRequests + 1 };
  }
}
