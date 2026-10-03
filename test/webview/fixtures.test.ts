// The harness catalogue is the list of states the dashboard was looked at in. These tests keep it
// honest: every hero state has a fixture, and every fixture survives the trip a real message makes.

import { describe, expect, it } from 'vitest';
import { fixtureById, FIXTURES } from '../../dev/fixtures';
// Type-only: tsconfig does not include dev/, so this is what puts the harness scripts (and the
// fake host inside them) under `tsc --noEmit` together with the protocol they imitate.
import type {} from '../../dev/harness';
import { isWebviewMessage } from '../../src/shared/protocol';
import { headline } from '../../src/shared/text';
import { present } from '../../src/webview/actions';
import type { UiAction } from '../../src/webview/actions';
import { buildBanners } from '../../src/webview/banners';
import { buildFooter } from '../../src/webview/footerModel';
import { buildHero, pickHero } from '../../src/webview/hero';
import type { HeroKind } from '../../src/webview/hero';
import { buildLanes } from '../../src/webview/lanesModel';
import { parseHostMessage } from '../../src/webview/messages';
import { buildPlan } from '../../src/webview/planModel';
import { buildSessions } from '../../src/webview/sessionsModel';
import { applyHostMessage, initialSnapshot } from '../../src/webview/store';
import { allScenes, NOW } from './support';
import type { Scene } from './support';

/** Listing every member in a Record makes the compiler complain when a hero kind is added. */
const HERO_KINDS: Record<HeroKind, true> = {
  isolated: true,
  connecting: true,
  lostContact: true,
  countdown: true,
  committing: true,
  executing: true,
  result: true,
  cantRun: true,
  degraded: true,
  off: true,
  watching: true,
  confirming: true,
};

/** Every action any view-model offers for a scene. */
function actionsOffered({ state, view }: Scene): UiAction[] {
  const variant = pickHero(state, view, 60_000);
  const hero = buildHero(variant, state, view, { scanAgeSeconds: 3, nextCheckSeconds: 6 });
  const plan = buildPlan(state, view, variant.kind, view.plan, false);
  const lanes = state === null ? null : buildLanes(state, view, NOW);
  const sessions = state === null ? null : buildSessions({ state, view, scanAgeMs: 3_000, nowMs: NOW, wide: true });
  const footer = buildFooter(state, view);
  const controls = present([
    hero.primary,
    ...hero.secondary,
    ...buildBanners(state, view).map((banner) => banner.control),
    ...(plan.kind === 'edit' ? [plan.changeRules, plan.preview] : []),
    ...(lanes?.rows.flatMap((row) => [row.settings, ...row.actions.map((action) => action.control)]) ?? []),
    ...(lanes?.overrides.map((override) => override.undo) ?? []),
    ...(sessions?.rows.flatMap((row) => [row.openTranscript, row.dontWait, row.undo, ...row.children.map((child) => child.control)]) ?? []),
    ...footer.links,
    ...footer.help,
  ]);
  return controls.map((item) => item.action);
}

describe('the fixture catalogue', () => {
  it('has unique ids', () => {
    const ids = FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the first fixture for an id it does not know', () => {
    expect(fixtureById('no-such-state').id).toBe(FIXTURES[0]?.id);
    expect(fixtureById(null).id).toBe(FIXTURES[0]?.id);
  });

  it('covers every hero state', () => {
    const seen = new Set<HeroKind>();
    for (const { scene } of allScenes()) {
      seen.add(pickHero(scene.state, scene.view, 0).kind);
      seen.add(pickHero(scene.state, scene.view, 60_000).kind);
    }
    expect([...seen].sort()).toEqual(Object.keys(HERO_KINDS).sort());
  });

  it('covers every kind of result and every kind of countdown', () => {
    const results = new Set<string>();
    const countdowns = new Set<string>();
    for (const { scene } of allScenes()) {
      if (scene.state?.lastResult) results.add(scene.state.lastResult.kind);
      if (scene.state?.countdown?.kind) countdowns.add(scene.state.countdown.kind);
    }
    expect([...results].sort()).toEqual(['cancelled', 'done', 'failed', 'stopped', 'testPassed']);
    expect([...countdowns].sort()).toEqual(['preview', 'real', 'test']);
  });

  it('survives the trip through JSON and the message parser, like a real state message', () => {
    let snapshot = initialSnapshot(0);
    for (const fixture of FIXTURES) {
      const data = fixture.build(NOW);
      const wire: unknown = JSON.parse(JSON.stringify({ type: 'state', state: data.state, view: data.view }));
      const message = parseHostMessage(wire);
      expect(message?.type, fixture.id).toBe('state');
      if (message === null) continue;
      snapshot = applyHostMessage(snapshot, message, 1_000);
      const { state } = snapshot;
      expect(state === null, fixture.id).toBe(data.state === null);
      if (state !== null) expect(() => headline(state), fixture.id).not.toThrow();
    }
  });

  it('only ever offers messages the host recognises', () => {
    for (const { id, scene } of allScenes()) {
      for (const action of actionsOffered(scene)) {
        if (action.do !== 'send') continue;
        expect(action.messages.length, id).toBeGreaterThan(0);
        for (const message of action.messages) expect(isWebviewMessage(message), `${id}: ${message.type}`).toBe(true);
      }
    }
  });

  it('has preview events for sessions that exist in the same fixture', () => {
    for (const fixture of FIXTURES) {
      const data = fixture.build(NOW);
      // One fixture carries a deliberately malformed state: its `sessions` is not a list.
      const sessions: unknown = data.state?.sessions;
      const keys = new Set(Array.isArray(sessions) ? sessions.map((session: { key: string }) => session.key) : []);
      for (const [key, events] of Object.entries(data.previews ?? {})) {
        if (keys.has(key)) expect(events.length, `${fixture.id}: ${key}`).toBeGreaterThan(0);
      }
    }
  });
});
