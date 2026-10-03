import { describe, expect, it } from 'vitest';
import type { UiState, ViewContext } from '../../src/shared/protocol';
import { unmetLanes } from '../../src/shared/text';
import { buildLanes, earliestActionMs } from '../../src/webview/lanesModel';
import type { LanesModel } from '../../src/webview/lanesModel';
import { allScenes, expectPrintable, messageTypes, NOW, scene, stateOf } from './support';

function lanesOf(id: string, viewOverrides: Partial<ViewContext> = {}): LanesModel | null {
  const { state, view } = scene(id);
  if (state === null) throw new Error(`fixture ${id} has no state`);
  return buildLanes(state, { ...view, ...viewOverrides }, NOW);
}

function shown(id: string, viewOverrides: Partial<ViewContext> = {}): LanesModel {
  const model = lanesOf(id, viewOverrides);
  if (model === null) throw new Error(`fixture ${id} shows no lanes`);
  return model;
}

describe('which lanes are shown', () => {
  it('lists the unmet lanes in the fixed order while watching', () => {
    const model = shown('watching-real');
    expect(model.rows.map((row) => row.lane)).toEqual(['claude', 'you']);
    expect(model.heading).toBe('WAITING FOR 2 THINGS');
  });

  it('counts one thing as one thing', () => {
    expect(shown('confirming').heading).toBe('WAITING FOR 1 THING');
    expect(shown('confirming').rows.map((row) => row.lane)).toEqual(['recheck']);
  });

  it('says ALL CLEAR when nothing is unmet during a countdown', () => {
    const model = shown('countdown-real');
    expect(model.rows).toEqual([]);
    expect(model.heading).toBe('ALL CLEAR');
  });

  it('is titled "if you started now" while not watching, without the re-check lane', () => {
    const model = shown('off-sessions');
    expect(model.heading).toBe('IF YOU STARTED NOW');
    expect(model.rows.map((row) => row.lane)).not.toContain('recheck');
  });

  it('says so when nothing would be in the way', () => {
    const model = shown('result-test-passed');
    expect(model.rows).toEqual([]);
    expect(model.allClear).not.toBeNull();
  });

  it('is hidden while not watching when there is no session and nothing is wrong', () => {
    expect(lanesOf('off-empty')).toBeNull();
  });

  it('is hidden before the first scan has completed', () => {
    const base = stateOf('off-sessions');
    const { view } = scene('off-sessions');
    expect(buildLanes({ ...base, scan: { ...base.scan, lastCompletedAgoMs: null } }, view, NOW)).toBeNull();
  });

  it('is hidden when no checks are known at all, instead of claiming all clear', () => {
    expect(lanesOf('limited-foreign')).toBeNull();
  });

  it('gives a timer lane a meter and a waiting session lane none', () => {
    const [claude, you] = shown('watching-real').rows;
    expect(claude?.meter).toBeNull();
    expect(you?.meter?.fraction).toBeCloseTo(4 / 600);
    expect(you?.meter?.valueText).toMatch(/^Away .* of 10 minutes$/);
  });

  it('marks a lane that could not be read as "can\'t tell", not as waiting', () => {
    const [claude, you] = shown('watching-real').rows;
    expect(claude?.glyph.icon).toBe('question');
    expect(you?.glyph.icon).toBe('clock');
  });

  it('opens the right setting from each lane', () => {
    const settings = Object.fromEntries(
      ['watching-real', 'confirming', 'watching-stop-file'].flatMap((id) =>
        shown(id).rows.map((row) => [row.lane, row.settings?.action] as const),
      ),
    );
    expect(settings.claude).toEqual({ do: 'send', messages: [{ type: 'openSettings', setting: 'quietSeconds' }] });
    expect(settings.you).toEqual({ do: 'send', messages: [{ type: 'openSettings', setting: 'userIdleSeconds' }] });
    expect(settings.pc).toEqual({ do: 'send', messages: [{ type: 'openSettings', setting: 'guardProcesses' }] });
    expect(settings.recheck).toEqual({ do: 'send', messages: [{ type: 'openSettings', setting: 'requiredPolls' }] });
  });
});

describe('the "N checks OK" fold', () => {
  it('counts passes only: a can\'t-tell never hides inside it', () => {
    const state = stateOf('watching-real');
    const passes = state.checks.filter((check) => check.state === 'pass').length;
    const model = shown('watching-real');
    expect(passes).toBeLessThan(state.checks.length);
    expect(model.fold.label).toBe(`${passes} checks OK`);
  });

  it('expands to every raw check, unmet ones included', () => {
    const state = stateOf('watching-real');
    const model = shown('watching-real');
    expect(model.fold.checks).toHaveLength(state.checks.length);
    expect(model.fold.checks.map((check) => check.stateWord)).toContain("Can't tell");
  });

  it('draws a check whose state it does not know as "can\'t tell"', () => {
    const base = stateOf('watching-real');
    const odd = { ...base, checks: [{ id: 'quiet', state: 'splendid', data: {} }] } as unknown as UiState;
    const model = buildLanes(odd, scene('watching-real').view, NOW);
    expect(model?.fold.checks[0]?.glyph.icon).toBe('question');
    expect(model?.fold.label).toBe('0 checks OK');
    expect(model?.fold.glyph.icon).toBe('question');
  });
});

describe('"Don\'t wait for…" in the lanes', () => {
  const claude = () => shown('watching-overrides').rows.find((row) => row.lane === 'claude');

  it('offers one override per unmatched Claude process that is not ignored yet', () => {
    const strays = claude()?.actions.filter((action) => action.key.startsWith('proc:')) ?? [];
    expect(strays).toHaveLength(1);
    expect(strays[0]?.text).toBe("A Claude process (PID 7788, claude) can't be matched to a session");
    expect(strays[0]?.control.action).toEqual({
      do: 'send',
      messages: [{ type: 'ignore', key: 'proc:7788:133800000000000001', on: true }],
    });
  });

  it('offers one override for all blocking remote windows, leaving covered and ignored ones alone', () => {
    const remote = claude()?.actions.find((action) => action.key === 'remoteWindows');
    expect(remote?.control.action).toEqual({
      do: 'send',
      messages: [{ type: 'ignore', key: 'remote:SSH: build-box', on: true }],
    });
  });

  it('opens a lane that offers an override by default', () => {
    expect(claude()?.openByDefault).toBe(true);
    expect(shown('watching-real').rows.every((row) => !row.openByDefault)).toBe(true);
  });

  it('lists overrides in force with an Undo', () => {
    const overrides = shown('watching-overrides').overrides;
    expect(overrides.map((row) => row.text)).toEqual(['claude (PID 7790)', 'Dev Container']);
    expect(overrides.map((row) => row.undo.action)).toEqual([
      { do: 'send', messages: [{ type: 'ignore', key: 'proc:7790:133800000000000002', on: false }] },
      { do: 'send', messages: [{ type: 'ignore', key: 'remote:Dev Container', on: false }] },
    ]);
  });

  it('offers the Emergency stop folder from the lane that reports it', () => {
    const pc = shown('watching-stop-file').rows.find((row) => row.lane === 'pc');
    expect(pc?.glyph.icon).toBe('error');
    expect(pc?.actions.flatMap((action) => messageTypes(action.control.action))).toEqual(['revealStop']);
  });

  it('offers no override from a window that can only Cancel and Stop', () => {
    const model = shown('watching-overrides', { limited: true });
    const claudeLane = model.rows.find((row) => row.lane === 'claude');
    expect(claudeLane?.actions).toEqual([]);
    expect(model.overrides).toEqual([]);
  });

  it('drops an override whose key the leader would not accept', () => {
    const base = stateOf('watching-overrides');
    const strays = (base.strays ?? []).map((stray) => ({ ...stray, ignoreKey: 'nonsense' }));
    const model = buildLanes({ ...base, strays }, scene('watching-overrides').view, NOW);
    const actions = model?.rows.find((row) => row.lane === 'claude')?.actions ?? [];
    expect(actions.some((action) => action.key === 'nonsense')).toBe(false);
  });
});

describe('commands a stray Claude process started', () => {
  const claude = () => shown('watching-stray-children').rows.find((row) => row.lane === 'claude');
  const claudeActions = (state: UiState) =>
    buildLanes(state, scene('watching-stray-children').view, NOW)?.rows.find((row) => row.lane === 'claude')?.actions;

  it("are listed under the stray, each with its own \"Don't wait for it\"", () => {
    const actions = claude()?.actions ?? [];
    expect(actions.map((action) => [action.text, action.nested])).toEqual([
      ["A Claude process (PID 7788, claude) can't be matched to a session", false],
      ['node (PID 7801) is still running', true],
      ['cargo (PID 7805), started by claude (PID 7795), is still running', false],
    ]);
    expect(actions[1]?.control.label).toBe("Don't wait for it");
    expect(actions[1]?.control.action).toEqual({ do: 'send', messages: [{ type: 'ignore', key: 'proc:7801:133800000000000000', on: true }] });
  });

  it('that are no longer waited for get an Undo', () => {
    const overrides = shown('watching-stray-children').overrides;
    expect(overrides.map((row) => row.text)).toEqual(['esbuild (PID 7802)']);
    expect(overrides[0]?.undo.action).toEqual({ do: 'send', messages: [{ type: 'ignore', key: 'proc:7802:133800000000000000', on: false }] });
  });

  it('are shown while only the command check waits, and not while the Claude lane is clear', () => {
    const base = stateOf('watching-stray-children');
    const commandsOnly = base.checks.map((check) =>
      check.id === 'registry'
        ? { ...check, state: 'pass' as const }
        : check.id === 'childProcesses'
          ? { ...check, state: 'waiting' as const }
          : check,
    );
    expect(claudeActions({ ...base, checks: commandsOnly })?.map((action) => action.text)).toEqual([
      'node (PID 7801), started by claude (PID 7788), is still running',
      'cargo (PID 7805), started by claude (PID 7795), is still running',
    ]);
    const clear = base.checks.map((check) => (check.id === 'registry' ? { ...check, state: 'pass' as const } : check));
    expect(claudeActions({ ...base, checks: clear })).toBeUndefined();
  });

  it('are left out when idle, or when their key would not be accepted', () => {
    const base = stateOf('watching-stray-children');
    const strays = (base.strays ?? []).map((stray) => ({
      ...stray,
      children: [
        { pid: 1, name: 'idle', busy: false, ignored: false, ignoreKey: 'proc:1:1' },
        { pid: 2, name: 'odd', busy: true, ignored: false, ignoreKey: 'nonsense' },
      ],
    }));
    expect(claudeActions({ ...base, strays } as UiState)?.map((action) => action.text)).toEqual([
      "A Claude process (PID 7788, claude) can't be matched to a session",
    ]);
  });
});

describe('sessions left out to fit between windows', () => {
  it('make no promise about the earliest time: they could be in any state', () => {
    const state = stateOf('watching-timers');
    expect(earliestActionMs(state, unmetLanes(state), NOW)).not.toBeNull();
    const omitted = { ...state, sessionsOmitted: 3 };
    expect(earliestActionMs(omitted, unmetLanes(omitted), NOW)).toBeNull();
  });

  it('count as sessions for "if you started now"', () => {
    const base = stateOf('off-sessions');
    const { view } = scene('off-sessions');
    const passing = base.checks.map((check) => ({ ...check, state: 'pass' as const }));
    expect(buildLanes({ ...base, checks: passing, sessions: [] }, view, NOW)).toBeNull();
    expect(buildLanes({ ...base, checks: passing, sessions: [], sessionsOmitted: 4 }, view, NOW)?.heading).toBe('IF YOU STARTED NOW');
  });
});

describe('the cancelled-but-still-watching notice', () => {
  it('is shown above the lanes with the reason', () => {
    const notice = shown('watching-cancelled').notice;
    expect(notice).toMatch(/^Countdown cancelled/);
    expect(notice).toContain('web-ui went back to work');
  });

  it('is absent otherwise', () => {
    expect(shown('watching-real').notice).toBeNull();
    expect(shown('off-sessions').notice).toBeNull();
  });
});

describe('the "Earliest" line', () => {
  it('appears when every lane is a running clock', () => {
    const state = stateOf('watching-timers');
    const at = earliestActionMs(state, unmetLanes(state), NOW);
    // The slower clock is "away": 600 - 215 s. Then 3 re-checks 10 s apart and a 90 s countdown.
    expect(at).toBe(NOW + (385 + 30 + 90) * 1000);
    expect(shown('watching-timers').earliest).toMatch(/^Earliest: \d\d:\d\d \(not before\)$/);
  });

  it('counts only the re-checks still missing while double-checking', () => {
    const state = stateOf('confirming');
    expect(earliestActionMs(state, unmetLanes(state), NOW)).toBe(NOW + (10 + 90) * 1000);
  });

  it('never appears while a session is working or unreadable', () => {
    expect(shown('watching-real').earliest).toBeNull();
    expect(shown('watching-test').earliest).toBeNull();
    expect(shown('degraded').earliest).toBeNull();
  });

  it('trusts the session list over the checks: one working or unreadable session is enough to say nothing', () => {
    const base = stateOf('watching-timers');
    const busy = stateOf('watching-real').sessions;
    for (const extra of busy) {
      // The checks still read as pure timers; the sessions say otherwise.
      const state = { ...base, sessions: [...base.sessions, extra], checks: base.checks };
      expect(earliestActionMs(state, unmetLanes(base), NOW), extra.name).toBeNull();
    }
    const ignored = { ...base, sessions: [...base.sessions, ...busy.map((session) => ({ ...session, ignored: true }))] };
    expect(earliestActionMs(ignored, unmetLanes(base), NOW)).not.toBeNull();
  });

  it('never appears while not watching, or during a countdown', () => {
    for (const id of ['off-sessions', 'countdown-real', 'result-test-passed']) {
      const state = stateOf(id);
      expect(earliestActionMs(state, unmetLanes(state), NOW), id).toBeNull();
    }
  });

  it('waits out the cooldown after a cancel', () => {
    const base = stateOf('watching-timers');
    const cooling = { ...base, cooldownRemainingMs: 500_000 };
    expect(earliestActionMs(cooling, unmetLanes(cooling), NOW)).toBe(NOW + (500 + 30 + 90) * 1000);
  });

  it('makes no promise when a rule is unreadable', () => {
    const base = stateOf('watching-timers');
    for (const broken of [{ pollSeconds: NaN }, { requiredPolls: undefined }, { countdownSeconds: '90' }]) {
      const state = { ...base, contract: { ...base.contract, ...broken } } as unknown as UiState;
      expect(earliestActionMs(state, unmetLanes(base), NOW)).toBeNull();
    }
    expect(earliestActionMs(base, unmetLanes(base), NaN)).toBeNull();
  });
});

describe('every fixture', () => {
  it('builds without throwing and prints no raw unknown', () => {
    for (const { scene: each } of allScenes()) {
      if (each.state !== null) expectPrintable(buildLanes(each.state, each.view, NOW));
    }
  });
});
