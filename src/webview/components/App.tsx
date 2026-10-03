// The dashboard. It renders whatever the host last posted and sends the user's intent back; it
// decides nothing about the machine. Layout, top to bottom: banners, hero, plan, "waiting for",
// sessions, footer - two columns from 640 px, with a countdown hero spanning both.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { WebviewToHost } from '../../shared/protocol';
import { headline } from '../../shared/text';
import { allowedDuringCountdown } from '../actions';
import type { UiAction } from '../actions';
import { buildBanners } from '../banners';
import { isGuarded } from '../clickGuard';
import { remainingOf, scanAgeMs } from '../clock';
import { buildFooter } from '../footerModel';
import { buildHero, pickHero } from '../hero';
import type { HeroKind } from '../hero';
import { buildLanes } from '../lanesModel';
import { parseHostMessage, toHost } from '../messages';
import { parsePersisted, pruneChoices, withChoice } from '../persist';
import type { PersistedUi } from '../persist';
import { buildPlan, effectivePlan, settleOverride } from '../planModel';
import type { PlanOverride } from '../planModel';
import { buildSessions } from '../sessionsModel';
import { applyHostMessage, initialSnapshot } from '../store';
import { Announcer, Banners, Footer } from './Chrome';
import { Hero } from './Hero';
import { useMediaQuery, useSpeech, useTick } from './hooks';
import { Lanes } from './Lanes';
import { Plan } from './Plan';
import type { PlanChange } from './Plan';
import { Sessions } from './Sessions';
import { DispatchContext } from './ui';
import type { Dispatch } from './ui';

export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const WIDE_QUERY = '(min-width: 640px)';
/** While digits, the click guard or the connecting grace are running, the page re-renders this often. */
const FAST_TICK_MS = 250;
const SLOW_TICK_MS = 1000;

/** Hero states that leave nothing below them to act on: only the hero's own button is live. */
const HERO_ONLY: readonly HeroKind[] = ['countdown', 'committing', 'executing'];
/** Hero states with no state to show below them at all. */
const NOTHING_BELOW: readonly HeroKind[] = ['isolated', 'connecting', 'lostContact'];

function toSeconds(ms: number | null): number | null {
  return ms === null ? null : ms / 1000;
}

export function App({ api }: { api: VsCodeApi }) {
  const [snapshot, setSnapshot] = useState(() => initialSnapshot(performance.now()));
  const [persisted, setPersisted] = useState<PersistedUi>(() => parsePersisted(api.getState()));
  const [planOverride, setPlanOverride] = useState<PlanOverride | null>(null);
  const wide = useMediaQuery(WIDE_QUERY);
  const planAnchor = useRef<HTMLElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = parseHostMessage(event.data);
      if (message !== null) setSnapshot((previous) => applyHostMessage(previous, message, performance.now()));
    };
    window.addEventListener('message', onMessage);
    api.postMessage(toHost.ready());
    return () => window.removeEventListener('message', onMessage);
  }, [api]);

  const { state, view } = snapshot;
  const now = performance.now();
  const variant = pickHero(state, view, snapshot.nullSince === null ? 0 : now - snapshot.nullSince);
  const heroOnly = HERO_ONLY.includes(variant.kind);
  const inCountdown = variant.kind === 'countdown' || variant.kind === 'committing';
  const guarded = isGuarded(snapshot.heroChangedAt, now);
  useTick(inCountdown || guarded || variant.kind === 'connecting' ? FAST_TICK_MS : SLOW_TICK_MS);

  useEffect(() => {
    api.setState(persisted);
  }, [api, persisted]);

  // Session keys as one string, so the effect below runs only when the set of rows changes.
  const liveKeys = state === null ? null : JSON.stringify(state.sessions.map((session) => session.key));
  useEffect(() => {
    // Without a state nothing is known about which rows exist: keep the choices.
    if (liveKeys === null) return;
    const live = JSON.parse(liveKeys) as string[];
    setPersisted((previous) => {
      const sessions = pruneChoices(previous.sessions, live);
      return sessions === previous.sessions ? previous : { ...previous, sessions };
    });
  }, [liveKeys]);

  useEffect(() => {
    setPlanOverride((override) => settleOverride(override, view.plan, performance.now()));
  }, [view.plan]);

  const focusPlan = useCallback(() => {
    const plan = planAnchor.current;
    if (plan === null) return;
    plan.scrollIntoView({ block: 'nearest' });
    plan.querySelector<HTMLElement>('select, input:checked, button')?.focus();
  }, []);

  useEffect(() => {
    if (snapshot.focusPlanRequests > 0) focusPlan();
  }, [snapshot.focusPlanRequests, focusPlan]);

  const choose = useCallback(
    (change: PlanChange) => {
      setPlanOverride((override) => ({ ...(override ?? {}), ...change, at: performance.now() }));
      const messages = [
        change.action === undefined ? null : toHost.setAction(change.action),
        change.testMode === undefined ? null : toHost.setTestMode(change.testMode),
      ];
      for (const message of messages) if (message !== null) api.postMessage(message);
    },
    [api],
  );

  // The dispatcher is created once; it reads the latest countdown flag through a ref so that the
  // rows' effects (which depend on it) do not re-run on every render.
  const countdownRef = useRef(inCountdown);
  countdownRef.current = inCountdown;
  const dispatch = useMemo<Dispatch>(() => {
    const run = (action: UiAction): void => {
      if (countdownRef.current && !allowedDuringCountdown(action)) return;
      if (action.do === 'send') action.messages.forEach((message) => api.postMessage(message));
      else if (action.do === 'focusPlan') focusPlan();
      else {
        choose({ testMode: false });
        focusPlan();
      }
    };
    const request = (message: WebviewToHost | null): void => {
      if (message !== null) api.postMessage(message);
    };
    return { run, request };
  }, [api, choose, focusPlan]);

  useEffect(() => {
    if (!inCountdown) return;
    // Esc anywhere in the dashboard cancels. So do Enter and Space unless a button has the focus -
    // and during a countdown the only button that can have it is Cancel, which they press.
    const onKey = (event: KeyboardEvent): void => {
      const onButton = event.target instanceof HTMLButtonElement;
      const cancels = event.key === 'Escape' || ((event.key === 'Enter' || event.key === ' ') && !onButton);
      if (!cancels) return;
      event.preventDefault();
      api.postMessage(toHost.cancel());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inCountdown, api]);

  const scanAge = state === null ? null : scanAgeMs(state.scan.lastCompletedAgoMs, snapshot.receivedAt, now);
  const nextCheck = state === null ? null : remainingOf(state.confirm.nextCheckInMs, snapshot.receivedAt, now);
  const heroModel = buildHero(variant, state, view, {
    scanAgeSeconds: toSeconds(scanAge),
    nextCheckSeconds: toSeconds(nextCheck),
  });
  const showBelow = state !== null && !NOTHING_BELOW.includes(variant.kind);
  const planModel = buildPlan(state, view, variant.kind, effectivePlan(view.plan, planOverride, now), guarded);
  const lanesModel = showBelow ? buildLanes(state, view, Date.now()) : null;
  const sessionsModel = showBelow ? buildSessions({ state, view, scanAgeMs: scanAge, nowMs: Date.now(), wide }) : null;
  // "Still on: waiting for…" is only true while watching.
  const waitingFor = state !== null && variant.kind === 'watching' ? headline(state) : '';
  const speech = useSpeech(heroModel, snapshot.countdown, now, waitingFor);

  const banners = buildBanners(state, view);
  const hero = <Hero model={heroModel} anchor={snapshot.countdown} now={now} />;
  const hasStack = planModel.kind !== 'hidden' || lanesModel !== null;
  const layout = `app${sessionsModel === null ? ' app--solo' : ''}`;

  return (
    <DispatchContext.Provider value={dispatch}>
      <main class={layout}>
        {(banners.length > 0 || inCountdown) && (
          <div class="app__top">
            {banners.length > 0 && (
              <div inert={heroOnly}>
                <Banners banners={banners} />
              </div>
            )}
            {inCountdown && hero}
          </div>
        )}
        {(!inCountdown || hasStack) && (
          <div class="app__left">
            {!inCountdown && hero}
            {hasStack && (
              <div class="app__stack" inert={heroOnly}>
                <Plan model={planModel} anchor={planAnchor} onChange={choose} />
                {lanesModel !== null && (
                  <Lanes
                    model={lanesModel}
                    choices={persisted.lanes}
                    checksOpen={persisted.checksOpen}
                    onToggleLane={(lane, open) => setPersisted((previous) => ({ ...previous, lanes: withChoice(previous.lanes, lane, open) }))}
                    onToggleChecks={(open) => setPersisted((previous) => ({ ...previous, checksOpen: open }))}
                  />
                )}
              </div>
            )}
          </div>
        )}
        {sessionsModel !== null && (
          <div class="app__right" inert={heroOnly}>
            <Sessions
              model={sessionsModel}
              previews={snapshot.previews}
              choices={persisted.sessions}
              finishedOpen={persisted.finishedOpen}
              wide={wide}
              onToggleRow={(key, open) => setPersisted((previous) => ({ ...previous, sessions: withChoice(previous.sessions, key, open) }))}
              onToggleFinished={(open) => setPersisted((previous) => ({ ...previous, finishedOpen: open }))}
            />
          </div>
        )}
        <div class="app__footer" inert={heroOnly}>
          <Footer model={buildFooter(state, view)} />
        </div>
        <Announcer polite={speech.polite} assertive={speech.assertive} />
      </main>
    </DispatchContext.Provider>
  );
}
