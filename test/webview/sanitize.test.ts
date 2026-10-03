import { describe, expect, it } from 'vitest';
import { headline } from '../../src/shared/text';
import { buildBanners } from '../../src/webview/banners';
import { buildFooter } from '../../src/webview/footerModel';
import { buildHero, heroKey, pickHero } from '../../src/webview/hero';
import { buildLanes } from '../../src/webview/lanesModel';
import { buildPlan } from '../../src/webview/planModel';
import { sanitizeEvents, sanitizeState, sanitizeView } from '../../src/webview/sanitize';
import { buildSessions } from '../../src/webview/sessionsModel';
import { parsePersisted, EMPTY_PERSISTED, isOpen, pruneChoices, withChoice } from '../../src/webview/persist';
import { expectPrintable, messageTypes, NOW, stateOf } from './support';

/** What a careless or foreign producer could put where a container or a value belongs. */
const GARBAGE: readonly unknown[] = [undefined, null, NaN, Infinity, -1, 0, '', 'abc', true, [], {}, [null], [{}], { length: 3 }];

const CONTAINERS = [
  'leader',
  'contract',
  'confirm',
  'countdown',
  'checks',
  'sessions',
  'strays',
  'remoteWindows',
  'scan',
  'platform',
  'stop',
  'lastResult',
  'activity',
] as const;

/** Everything the dashboard computes from a state, the way the App does. */
function renderEverything(raw: unknown, rawView: unknown = { role: 'follower', limited: true }): unknown {
  const state = sanitizeState(raw);
  const view = sanitizeView(rawView);
  const variant = pickHero(state, view, 60_000);
  const hero = buildHero(variant, state, view, { scanAgeSeconds: null, nextCheckSeconds: null });
  return {
    key: heroKey(state, view),
    hero,
    banners: buildBanners(state, view),
    plan: buildPlan(state, view, variant.kind, view.plan, false),
    lanes: state === null ? null : buildLanes(state, view, NOW),
    sessions: state === null ? null : buildSessions({ state, view, scanAgeMs: null, nowMs: NOW, wide: true }),
    footer: buildFooter(state, view),
    headline: state === null ? '' : headline(state),
  };
}

describe('sanitizeState', () => {
  it('is null for anything without a phase', () => {
    for (const bad of [...GARBAGE, { phase: 3 }, { phase: null }]) expect(sanitizeState(bad)).toBeNull();
  });

  it('gives every container the right shape when only the phase arrived', () => {
    const state = sanitizeState({ phase: 'watching' });
    expect(state).toMatchObject({
      phase: 'watching',
      countdown: null,
      checks: [],
      sessions: [],
      strays: null,
      remoteWindows: [],
      lastResult: null,
      scan: { engineActive: false, lastCompletedAgoMs: null, stale: true, errors: [], roots: [] },
      stop: { present: false, auto: false },
      platform: { problem: null, capability: null, capabilities: {}, experimental: false },
    });
  });

  it('never trusts a scan that does not explicitly say it is fresh', () => {
    expect(sanitizeState({ phase: 'off', scan: { stale: false } })?.scan.stale).toBe(false);
    for (const stale of [undefined, null, 0, '', 'false']) {
      expect(sanitizeState({ phase: 'off', scan: { stale } })?.scan.stale).toBe(true);
    }
  });

  it('keeps unknown process lists unknown', () => {
    expect(sanitizeState({ phase: 'off', strays: [] })?.strays).toEqual([]);
    expect(sanitizeState({ phase: 'off', strays: 'none' })?.strays).toBeNull();
    expect(sanitizeState({ phase: 'off' })?.strays).toBeNull();
  });

  it('gives every session a usable list key and containers', () => {
    const state = sanitizeState({ phase: 'off', sessions: [{ name: 'a' }, 'junk', { key: 'k2', subagents: 'x', children: [1, {}] }] });
    expect(state?.sessions.map((session) => session.key)).toEqual(['unnamed-0', 'k2']);
    expect(state?.sessions[1]).toMatchObject({ subagents: [], children: [{}] });
  });

  it('leaves a well-formed state as it was', () => {
    const original = stateOf('watching-overrides');
    expect(sanitizeState(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
});

describe('a state from another version never breaks the dashboard', () => {
  it('renders when any one container is garbage', () => {
    const base = stateOf('watching-overrides');
    for (const container of CONTAINERS) {
      for (const junk of GARBAGE) {
        expect(() => renderEverything({ ...base, [container]: junk }), `${container} = ${String(junk)}`).not.toThrow();
      }
    }
  });

  it('renders when every container is garbage at once, in every phase', () => {
    for (const phase of ['off', 'watching', 'confirming', 'countdown', 'committing', 'executing', 'brandNew']) {
      for (const junk of GARBAGE) {
        const state = Object.fromEntries([['phase', phase], ...CONTAINERS.map((container) => [container, junk])]);
        expect(() => renderEverything(state), `${phase} with ${String(junk)}`).not.toThrow();
        expect(() => renderEverything(state, junk), `${phase} with view ${String(junk)}`).not.toThrow();
      }
    }
  });

  it('renders when the leaves of sessions and checks are garbage', () => {
    const base = stateOf('watching-overrides');
    for (const junk of GARBAGE) {
      const sessions = base.sessions.map((session) => Object.fromEntries(Object.keys(session).map((key) => [key, junk])));
      const checks = base.checks.map((check) => ({ id: check.id, state: junk, data: { quietestSeconds: junk, names: junk, k: junk, n: junk } }));
      const strays = [{ pid: junk, name: junk, ignoreKey: junk, accounted: junk, ignored: junk }];
      const remoteWindows = [{ name: junk, ignoreKey: junk, ignored: junk, covered: junk }];
      expect(() => renderEverything({ ...base, sessions, checks, strays, remoteWindows }), String(junk)).not.toThrow();
    }
  });

  it('reads how many sessions were left out, and calls anything unreadable none', () => {
    const base = stateOf('watching-omitted');
    expect(sanitizeState(base)?.sessionsOmitted).toBe(37);
    for (const junk of [...GARBAGE, -3]) {
      expect(sanitizeState({ ...base, sessionsOmitted: junk })?.sessionsOmitted, String(junk)).toBe(0);
    }
    expect(sanitizeState({ ...base, sessionsOmitted: 2.7 })?.sessionsOmitted).toBe(2);
  });

  it('forces the commands of a stray into a list', () => {
    for (const junk of GARBAGE) {
      const state = sanitizeState({ ...stateOf('watching-stray-children'), strays: [{ pid: 1, children: junk }] });
      const stray: unknown = state?.strays?.[0];
      expect(Array.isArray((stray as { children?: unknown }).children), String(junk)).toBe(true);
    }
  });

  it('still shows Cancel for a countdown it barely understands', () => {
    const rendered = renderEverything({ phase: 'countdown', countdown: { remainingMs: 'soon' }, sessions: 'three' }) as {
      hero: ReturnType<typeof buildHero>;
    };
    expect(rendered.hero.kind).toBe('countdown');
    expect(rendered.hero.countdown?.kind).toBe('real');
    expect(messageTypes(rendered.hero.primary?.action)).toEqual(['cancel']);
  });

  it('still shows Stop watching for a watching state it barely understands', () => {
    const rendered = renderEverything({ phase: 'watching' }) as { hero: ReturnType<typeof buildHero> };
    expect(messageTypes(rendered.hero.primary?.action)).toEqual(['stop']);
  });

  it('prints no raw unknown for a state that is all holes', () => {
    for (const phase of ['off', 'watching', 'confirming', 'countdown', 'committing', 'executing']) {
      expectPrintable(renderEverything({ phase }));
    }
  });
});

describe('sanitizeView', () => {
  it('falls back to a view that claims nothing', () => {
    for (const junk of GARBAGE) {
      expect(sanitizeView(junk)).toMatchObject({ role: 'electing', limited: false, pending: null, autoStopSet: false, unsavedFiles: 0 });
    }
  });

  it('keeps what is valid', () => {
    const view = sanitizeView({ role: 'follower', limited: true, pending: 'cancel', autoStopSet: true, unsavedFiles: 3.7, windowLabel: ' api ' });
    expect(view).toMatchObject({ role: 'follower', limited: true, pending: 'cancel', autoStopSet: true, unsavedFiles: 3, windowLabel: 'api' });
  });

  it('never invents a power action for a broken plan', () => {
    expect(sanitizeView({ plan: { action: 'detonate' } }).plan.action).toBe('notify');
    expect(sanitizeView({ plan: 'shutdown' }).plan).toMatchObject({ action: 'shutdown', testMode: true });
    expect(sanitizeView({ plan: { action: 'sleep', testMode: false } }).plan).toMatchObject({ action: 'sleep', testMode: false });
  });
});

describe('sanitizeEvents', () => {
  it('is empty for anything that is not a list of records', () => {
    for (const junk of [undefined, null, 'x', 4, {}, ['a', 1, null]]) expect(sanitizeEvents(junk)).toEqual([]);
  });
});

describe('remembered rows', () => {
  it('starts empty for whatever getState returns', () => {
    for (const junk of GARBAGE) expect(parsePersisted(junk)).toMatchObject({ checksOpen: false, finishedOpen: false });
    expect(parsePersisted(undefined)).toBe(EMPTY_PERSISTED);
  });

  it('keeps only real choices', () => {
    const parsed = parsePersisted({ sessions: { a: true, b: false, c: 'yes', d: 1 }, lanes: ['claude'], checksOpen: true, finishedOpen: 'true' });
    expect(parsed).toEqual({ sessions: { a: true, b: false }, lanes: {}, checksOpen: true, finishedOpen: false });
  });

  it('follows the default until the user chooses', () => {
    expect(isOpen({}, 'a', false)).toBe(false);
    expect(isOpen({}, 'a', true)).toBe(true);
    expect(isOpen(withChoice({}, 'a', false), 'a', true)).toBe(false);
    expect(isOpen(withChoice({}, 'a', true), 'a', false)).toBe(true);
    // A key that happens to name something on Object.prototype is not a choice.
    expect(isOpen({}, 'constructor', false)).toBe(false);
  });

  it('forgets rows that are gone, and keeps the same object when nothing changed', () => {
    const choices = { a: true, b: false };
    expect(pruneChoices(choices, ['a'])).toEqual({ a: true });
    expect(pruneChoices(choices, ['a', 'b', 'c'])).toBe(choices);
  });
});
