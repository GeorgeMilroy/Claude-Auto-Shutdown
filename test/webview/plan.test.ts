import { describe, expect, it } from 'vitest';
import type { ArmContract } from '../../src/shared/config';
import type { UiState, ViewContext } from '../../src/shared/protocol';
import { buildBanners } from '../../src/webview/banners';
import { buildFooter } from '../../src/webview/footerModel';
import { pickHero } from '../../src/webview/hero';
import { buildPlan, effectivePlan, OVERRIDE_TTL_MS, settleOverride } from '../../src/webview/planModel';
import type { PlanModel } from '../../src/webview/planModel';
import { allScenes, expectPrintable, messageTypes, scene, stateOf } from './support';

function planOf(id: string, options: { guarded?: boolean; view?: Partial<ViewContext>; state?: Partial<UiState> } = {}): PlanModel {
  const base = scene(id);
  const view = { ...base.view, ...options.view };
  const state = base.state === null ? null : { ...base.state, ...options.state };
  const hero = pickHero(state, view, 60_000);
  return buildPlan(state, view, hero.kind, view.plan, options.guarded ?? false);
}

function editable(model: PlanModel): Extract<PlanModel, { kind: 'edit' }> {
  if (model.kind !== 'edit') throw new Error(`expected an editable plan, got ${model.kind}`);
  return model;
}

describe('which plan is shown', () => {
  it('is editable while not watching', () => {
    for (const id of ['off-empty', 'off-sessions', 'result-test-passed', 'result-failed', 'degraded-off', 'countdown-preview']) {
      expect(planOf(id).kind, id).toBe('edit');
    }
  });

  it('is a read-only summary of the contract in force while watching', () => {
    for (const id of ['watching-real', 'confirming', 'countdown-real', 'committing', 'degraded']) {
      expect(planOf(id).kind, id).toBe('locked');
    }
    const locked = planOf('watching-real');
    expect(locked).toMatchObject({ kind: 'locked', summary: 'Shut down · For real', note: 'Stop watching to change this.' });
  });

  it('summarises the leader\'s contract, not this window\'s settings', () => {
    const otherPlan: ArmContract = { ...stateOf('watching-real').contract, action: 'lock', testMode: true };
    expect(planOf('watching-real', { view: { plan: otherPlan } })).toMatchObject({ summary: 'Shut down · For real' });
  });

  it('is hidden without a trustworthy state, when nothing can run here, and from a limited window', () => {
    for (const id of ['lost-contact', 'isolated', 'cant-run', 'executing', 'limited', 'limited-foreign']) {
      expect(planOf(id).kind, id).toBe('hidden');
    }
  });
});

describe('the editable plan', () => {
  it('offers the five actions and the two modes', () => {
    const plan = editable(planOf('off-sessions'));
    expect(plan.options.map((option) => option.label)).toEqual(['Shut down', 'Hibernate', 'Sleep', 'Lock', 'Just notify me']);
    expect(plan.modes).toEqual({
      testMode: true,
      testLabel: 'Test run: PC stays on, you get a message',
      realLabel: 'For real: this PC shuts down',
    });
    expect(plan.start).toEqual({
      label: 'Start test run',
      blocked: false,
      note: 'A test run takes as long as the real thing.',
      seeActionError: false,
    });
  });

  it('names the consequence on the button of a real run', () => {
    const plan = editable(planOf('off-real'));
    expect(plan.start.label).toBe('Shut down when Claude finishes…');
    expect(plan.modes?.testMode).toBe(false);
  });

  it('has no test / real choice for "Just notify me"', () => {
    const plan = editable(planOf('off-notify'));
    expect(plan.modes).toBeNull();
    expect(plan.notifyNote).toMatch(/Nothing ever turns off/);
    expect(plan.start.label).toBe('Notify me when Claude finishes');
  });

  it('blocks the start, with the reason under the select, when the action cannot run on this PC', () => {
    const plan = editable(planOf('off-unavailable'));
    expect(plan.actionError).toBe('Hibernation is turned off on this PC. Pick another action.');
    expect(plan.start).toMatchObject({ blocked: true, seeActionError: true, note: null });
    expect(plan.options.find((option) => option.value === 'hibernate')?.unavailable).toBe(true);
    expect(plan.options.find((option) => option.value === 'shutdown')?.unavailable).toBe(false);
  });

  it('does not block on a capability that is merely unknown', () => {
    const base = stateOf('off-real');
    const unknown = { ...base.platform, capabilities: { shutdown: { ok: null, detail: 'Could not find out' } } };
    const plan = editable(planOf('off-real', { state: { platform: unknown } }));
    expect(plan.actionError).toBeNull();
    expect(plan.start.blocked).toBe(false);
  });

  it('blocks the start while Emergency stop is set, and says so', () => {
    const stop = { present: true, dir: 'C:\\fixture', auto: false };
    const plan = editable(planOf('off-sessions', { state: { stop } }));
    expect(plan.start.blocked).toBe(true);
    expect(plan.start.note).toMatch(/Emergency stop is set/);
  });

  it('holds the start button back while the click guard is up, without removing it', () => {
    const plan = editable(planOf('off-sessions', { guarded: true }));
    expect(plan.start).toMatchObject({ label: 'Start test run', blocked: true, note: 'Ready in a moment' });
  });

  it('offers the demo countdown and the settings', () => {
    const plan = editable(planOf('off-sessions'));
    expect(messageTypes(plan.preview?.action)).toEqual(['preview']);
    expect(messageTypes(plan.changeRules?.action)).toEqual(['openSettings']);
  });
});

describe('a choice the settings have not confirmed yet', () => {
  const plan = stateOf('off-sessions').contract;

  it('is shown at once', () => {
    expect(effectivePlan(plan, { action: 'sleep', at: 1_000 }, 1_010).action).toBe('sleep');
    expect(effectivePlan(plan, { testMode: false, at: 1_000 }, 1_010).testMode).toBe(false);
    expect(effectivePlan(plan, null, 1_010)).toBe(plan);
  });

  it('is dropped once the host reports the same value', () => {
    expect(settleOverride({ action: 'sleep', at: 1_000 }, { ...plan, action: 'sleep' }, 1_500)).toBeNull();
  });

  it('survives a state that arrives before the setting was written', () => {
    const pending = { action: 'sleep' as const, at: 1_000 };
    expect(settleOverride(pending, plan, 1_500)).toBe(pending);
  });

  it('gives way to the settings when the write never shows up', () => {
    const pending = { action: 'sleep' as const, at: 1_000 };
    expect(settleOverride(pending, plan, 1_000 + OVERRIDE_TTL_MS)).toBeNull();
    expect(effectivePlan(plan, pending, 1_000 + OVERRIDE_TTL_MS).action).toBe(plan.action);
    expect(settleOverride(pending, plan, NaN)).toBeNull();
  });
});

describe('banners', () => {
  const ids = (id: string, view: Partial<ViewContext> = {}): string[] =>
    buildBanners(scene(id).state, { ...scene(id).view, ...view }).map((banner) => banner.id);

  it('shows none in an ordinary window, leader or follower', () => {
    expect(ids('watching-real')).toEqual([]);
    expect(ids('watching-real', { role: 'follower' })).toEqual([]);
  });

  it('names the controlling editor when this window is limited', () => {
    const [banner] = buildBanners(scene('limited').state, scene('limited').view);
    expect(banner?.text).toBe('Controlled by Cursor (0.3.0). Only Cancel and Stop watching work from this window.');
  });

  it('still explains the limitation when the controlling editor is unknown', () => {
    const [banner] = buildBanners(null, scene('limited').view);
    expect(banner?.text).toMatch(/^Controlled by another version of this extension\./);
  });

  it('reports Emergency stop, and who set it', () => {
    const [set] = buildBanners(scene('watching-stop-file').state, scene('watching-stop-file').view);
    expect(set?.text).toMatch(/^Emergency stop is set\./);
    expect(messageTypes(set?.control?.action)).toEqual(['revealStop']);
    const [auto] = buildBanners(null, scene('lost-contact-stop').view);
    expect(auto?.text).toMatch(/^Couldn't reach the window in control, so I set Emergency stop\./);
  });

  it('warns that macOS support is experimental', () => {
    expect(ids('macos')).toEqual(['experimental']);
  });
});

describe('footer', () => {
  it('always has the log, the settings and help', () => {
    const footer = buildFooter(scene('off-sessions').state, scene('off-sessions').view);
    expect(footer.links.flatMap((item) => messageTypes(item.action))).toEqual(['showLog', 'openSettings']);
    expect(footer.help.flatMap((item) => messageTypes(item.action))).toEqual(['openWalkthrough', 'preview', 'lastRun', 'revealStop']);
  });

  it('offers the demo countdown only while nothing is watched or counting', () => {
    for (const id of ['watching-real', 'countdown-real', 'countdown-preview', 'lost-contact']) {
      const footer = buildFooter(scene(id).state, scene(id).view);
      expect(footer.help.flatMap((item) => messageTypes(item.action)), id).not.toContain('preview');
    }
  });
});

describe('every fixture', () => {
  it('builds a plan, banners and a footer without throwing or printing a raw unknown', () => {
    for (const { scene: each } of allScenes()) {
      const hero = pickHero(each.state, each.view, 60_000);
      expectPrintable(buildPlan(each.state, each.view, hero.kind, each.view.plan, false));
      expectPrintable(buildBanners(each.state, each.view));
      expectPrintable(buildFooter(each.state, each.view));
    }
  });
});
