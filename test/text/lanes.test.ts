import { describe, expect, it } from 'vitest';
import type { Check, CheckId } from '../../src/core/types';
import type { UiState } from '../../src/shared/protocol';
import { headline, laneSetting, unmetLanes } from '../../src/shared/text';
import {
  CHECK_IDS,
  CHECK_STATES,
  GARBAGE,
  allPassing,
  cantTellSession,
  check,
  checksWith,
  expectPrintable,
  finishedSession,
  foreignCheck,
  justFinishedSession,
  typicalCheck,
  uiState,
  watchingState,
  workingSession,
} from './fixtures';

const working = check('sessionsIdle', 'waiting', { total: 3, working: 2, cantTell: 0, ignored: 0, names: ['a', 'b'] });
const openTurn = check('turnsClosed', 'waiting', { names: ['a', 'b'], reasons: ['toolInFlight', 'thinking'] });
const quiet = check('quiet', 'waiting', { quietestSeconds: 18, name: 'docs', quietSeconds: 300 });
const here = check('userIdle', 'waiting', { idleSeconds: 4, userIdleSeconds: 600 });
const guarded = check('guard', 'waiting', { hits: ['ffmpeg'] });
const stopSet = check('stopFile', 'fail');
const recheck = check('confirmed', 'waiting', { k: 1, n: 3 });
const notArmed = check('armed', 'waiting');

function lanesOf(...unmet: Check[]) {
  return unmetLanes(watchingState({ checks: checksWith(...unmet) }));
}

describe('unmetLanes', () => {
  it('is empty when everything passes', () => {
    expect(unmetLanes(uiState())).toEqual([]);
  });

  it('keeps the fixed order Claude, You, This PC whatever order the checks arrive in', () => {
    const shuffled = [recheck, guarded, here, stopSet, quiet, working, notArmed];
    const lanes = unmetLanes(watchingState({ checks: shuffled }));
    expect(lanes.map((lane) => lane.lane)).toEqual(['claude', 'you', 'pc']);
    expect(lanes.map((lane) => lane.title)).toEqual(['Claude', 'You', 'This PC']);
  });

  it('never lists the armed check, in any state', () => {
    for (const state of CHECK_STATES) {
      const lanes = unmetLanes(uiState({ checks: checksWith(check('armed', state), working, here, guarded) }));
      const ids = lanes.flatMap((lane) => lane.unmet.map((unmet) => unmet.id));
      expect(ids).not.toContain('armed');
      expect(lanes.map((lane) => lane.lane)).toEqual(['claude', 'you', 'pc']);
    }
    expect(unmetLanes(uiState({ checks: checksWith(notArmed) }))).toEqual([]);
  });

  it('puts every unmet check of a lane into that lane, in evaluation order', () => {
    const [claude] = lanesOf(quiet, openTurn, working);
    expect(claude?.unmet.map((unmet) => unmet.id)).toEqual(['sessionsIdle', 'turnsClosed', 'quiet']);
  });

  it.each(CHECK_IDS.filter((id) => id !== 'armed'))('%s alone opens exactly one lane, in every unmet state', (id) => {
    for (const state of CHECK_STATES.filter((candidate) => candidate !== 'pass')) {
      const lanes = lanesOf(typicalCheck(id, state));
      expect(lanes).toHaveLength(1);
      expect(lanes[0]?.unmet.map((unmet) => unmet.id)).toEqual([id]);
      expect(lanes[0]?.state).toBe(state);
      expect(lanes[0]?.text).not.toBe('');
      expectPrintable(lanes);
    }
  });

  it('shows the Re-check lane only when it is the last thing left', () => {
    expect(lanesOf(recheck).map((lane) => lane.lane)).toEqual(['recheck']);
    expect(lanesOf(recheck, here).map((lane) => lane.lane)).toEqual(['you']);
    expect(lanesOf(recheck, working, guarded).map((lane) => lane.lane)).toEqual(['claude', 'pc']);
  });

  it('takes the worst state of a lane: Problem over Can\'t tell over Waiting', () => {
    const blind = check('scanner', 'cantTell', { reason: 'stale', errors: [], roots: 1 });
    expect(lanesOf(guarded)[0]?.state).toBe('waiting');
    expect(lanesOf(guarded, blind)[0]?.state).toBe('cantTell');
    expect(lanesOf(guarded, blind, stopSet)[0]?.state).toBe('fail');
  });

  it('counts a state it does not know as can\'t tell, never as passed', () => {
    const [lane] = unmetLanes(watchingState({ checks: [...allPassing(), foreignCheck('quiet', 'paused', {})] }));
    expect(lane?.state).toBe('cantTell');
    expect(lane?.unmet.map((unmet) => unmet.id)).toContain('quiet');
  });

  it('puts a check id it does not know into the This PC lane under its own name', () => {
    const lanes = unmetLanes(watchingState({ checks: [...allPassing(), foreignCheck('diskSpace', 'waiting', { freeGb: 3 })] }));
    expect(lanes.map((lane) => lane.lane)).toEqual(['pc']);
    expect(lanes[0]?.text).toBe('diskSpace');
  });
});

describe('unmetLanes: the one line per lane', () => {
  it('Claude: the working sessions speak before their consequences', () => {
    expect(lanesOf(quiet, openTurn, working)[0]?.text).toBe('2 of 3 still working');
  });

  it('Claude: a can\'t-tell check speaks before a waiting one', () => {
    const remote = check('remoteWindows', 'cantTell', { blocking: ['SSH: build-box'], ignored: [], covered: [] });
    const [claude] = lanesOf(working, remote);
    expect(claude?.text).toBe("can't see Claude sessions in SSH: build-box");
    expect(claude?.state).toBe('cantTell');
  });

  it('You: away so far of the time required', () => {
    const [you] = lanesOf(here);
    expect(you?.text).toBe('away 0:04 of 10:00');
    expect(you?.progress).toEqual({ value: 4, max: 600, valueText: 'Away 4 seconds of 10 minutes' });
    expect(you?.sub).toBeNull();
  });

  it('You: says so when it cannot tell', () => {
    const [you] = lanesOf(check('userIdle', 'cantTell', { idleSeconds: null, userIdleSeconds: 600 }));
    expect(you?.text).toBe("can't tell whether you're away");
    expect(you?.progress).toBeNull();
  });

  it('This PC: a Problem speaks before a wait', () => {
    expect(lanesOf(guarded, stopSet)[0]?.text).toBe('Emergency stop is set');
    expect(lanesOf(guarded)[0]?.text).toBe('ffmpeg is running (keep-on list)');
  });

  it('Re-check: agreed checks of the number required', () => {
    const [lane] = lanesOf(recheck);
    expect(lane?.text).toBe('1 of 3 in a row');
    expect(lane?.progress).toEqual({ value: 1, max: 3, valueText: 'Check 1 of 3 passed' });
  });

  it.each<[CheckId, string]>([
    ['stopFile', "can't tell whether Emergency stop is set"],
    ['scanner', "couldn't read the session list (2 problems)"],
    ['helper', "can't check this PC"],
    ['actionAllowed', "can't confirm hibernate is allowed"],
    ['remoteWindows', "can't see Claude sessions in SSH: build-box and Dev Container"],
    ['registry', "couldn't read the process list"],
    ['unclaimedTranscripts', "haven't checked yet"],
    ['hasSessions', "can't tell when the last session ended"],
    ['sessionsIdle', "2 of 3 still working · 1 can't tell"],
    ['turnsClosed', 'scratch: No transcript found'],
    ['quiet', "can't tell how long scratch has been quiet"],
    ['childProcesses', "can't tell whether a command started by a session is still running"],
    ['userIdle', "can't tell whether you're away"],
    ['guard', "couldn't read the process list"],
    ['confirmed', "can't tell"],
  ])('%s, when it cannot tell', (id, text) => {
    expect(lanesOf(typicalCheck(id, 'cantTell'))[0]?.text).toBe(text);
  });
});

describe('unmetLanes: meters', () => {
  it('a lone quiet check is a pure timer', () => {
    const [claude] = lanesOf(quiet);
    expect(claude?.text).toBe('quiet 0:18 of 5:00 (docs)');
    expect(claude?.progress).toEqual({ value: 18, max: 300, valueText: 'Quiet 18 seconds of 5 minutes' });
  });

  it('is still a pure timer when the only blockers already ended their turn', () => {
    const sessions = [justFinishedSession('docs'), finishedSession('infra')];
    const idle = check('sessionsIdle', 'waiting', { total: 2, working: 1, cantTell: 0, ignored: 0, names: ['docs'] });
    const [claude] = unmetLanes(watchingState({ sessions, checks: checksWith(idle, quiet) }));
    expect(claude?.text).toBe('quiet 0:18 of 5:00 (docs)');
    expect(claude?.progress?.max).toBe(300);
    expect(claude?.unmet.map((unmet) => unmet.id)).toEqual(['sessionsIdle', 'quiet']);
  });

  it('is not a timer while a session is working or cannot be read', () => {
    for (const blocker of [workingSession('web-ui'), cantTellSession('scratch')]) {
      const sessions = [blocker, justFinishedSession('docs')];
      const idle = check('sessionsIdle', 'waiting', { total: 2, working: 2, cantTell: 0, ignored: 0, names: [] });
      const [claude] = unmetLanes(watchingState({ sessions, checks: checksWith(idle, quiet) }));
      expect(claude?.progress).toBeNull();
      expect(claude?.text).not.toContain('quiet 0:18');
    }
  });

  it('shows the clock with the most time left when several run', () => {
    const transcript = check('unclaimedTranscripts', 'waiting', { count: 1, project: 'p', secondsAgo: 250, quietSeconds: 300 });
    const [claude] = lanesOf(transcript, quiet);
    expect(claude?.text).toBe('quiet 0:18 of 5:00 (docs)');
    expect(claude?.progress?.value).toBe(18);
  });

  it('keeps the meter inside its range', () => {
    const over = check('userIdle', 'waiting', { idleSeconds: 9000, userIdleSeconds: 600 });
    expect(lanesOf(over)[0]?.progress).toEqual({ value: 600, max: 600, valueText: 'Away 10 minutes of 10 minutes' });
    const under = check('userIdle', 'waiting', { idleSeconds: -3, userIdleSeconds: 600 });
    expect(lanesOf(under)[0]?.progress?.value).toBe(0);
  });

  it('offers no meter for values it cannot read', () => {
    for (const junk of GARBAGE) {
      const [lane] = lanesOf(check('quiet', 'waiting', { quietestSeconds: junk as number, name: 'docs', quietSeconds: 300 }));
      if (typeof junk === 'number' && Number.isFinite(junk)) continue;
      expect(lane?.progress).toBeNull();
      expectPrintable(lane);
    }
  });
});

describe('unmetLanes: the stuck line', () => {
  const idle = check('sessionsIdle', 'waiting', { total: 2, working: 2, cantTell: 0, ignored: 0, names: [] });

  it('names the blocking session that has been silent longest', () => {
    const sessions = [
      workingSession('web-ui', { silenceSeconds: 4320 }),
      workingSession('api-refactor', { silenceSeconds: 900 }),
      workingSession('busy', { silenceSeconds: 5 }),
    ];
    const [claude] = unmetLanes(watchingState({ sessions, checks: checksWith(idle) }));
    expect(claude?.sub).toBe('web-ui: nothing written for 1 h 12 min');
  });

  it('stays quiet for sessions that are plainly at work, finished, or not waited for', () => {
    const sessions = [
      workingSession('fresh', { silenceSeconds: 600 }),
      workingSession('delegating', { silenceSeconds: 4000, activeSubagents: 2 }),
      workingSession('parked', { silenceSeconds: 4000, ignored: true }),
      workingSession('unknown-age', { silenceSeconds: null }),
      finishedSession('infra', 90_000),
    ];
    const [claude] = unmetLanes(watchingState({ sessions, checks: checksWith(idle) }));
    expect(claude?.sub).toBeNull();
  });

  it('belongs to the Claude lane only', () => {
    const sessions = [workingSession('web-ui', { silenceSeconds: 4320 })];
    const lanes = unmetLanes(watchingState({ sessions, checks: checksWith(idle, here, guarded) }));
    expect(lanes.map((lane) => lane.sub)).toEqual(['web-ui: nothing written for 1 h 12 min', null, null]);
  });
});

describe('headline', () => {
  const headlineOf = (...unmet: Check[]) => headline(watchingState({ checks: checksWith(...unmet) }));

  it('0 lanes: nothing to say', () => {
    expect(headline(uiState())).toBe('');
    expect(headlineOf(notArmed)).toBe('');
  });

  it('1 lane', () => {
    expect(headlineOf(working)).toBe('Still on: waiting for Claude.');
    expect(headlineOf(here)).toBe('Still on: waiting for you to step away.');
    expect(headlineOf(guarded)).toBe('Still on: waiting for something on this PC.');
    expect(headlineOf(recheck)).toBe('Still on: waiting for a final re-check.');
  });

  it('2 lanes', () => {
    expect(headlineOf(working, here)).toBe('Still on: waiting for Claude, and for you to step away.');
    expect(headlineOf(here, guarded)).toBe('Still on: waiting for you to step away, and for something on this PC.');
  });

  it('3 lanes', () => {
    expect(headlineOf(guarded, here, working, recheck)).toBe(
      'Still on: waiting for Claude, for you to step away, and for something on this PC.',
    );
  });

  it('never leaks a raw value, whatever the checks hold', () => {
    for (const id of CHECK_IDS) {
      for (const state of CHECK_STATES) {
        expectPrintable(headline(watchingState({ checks: checksWith(typicalCheck(id, state)) })));
      }
    }
  });
});

describe('laneSetting', () => {
  it('opens the setting that tunes the lane', () => {
    expect(laneSetting('claude')).toBe('quietSeconds');
    expect(laneSetting('you')).toBe('userIdleSeconds');
    expect(laneSetting('pc')).toBe('guardProcesses');
    expect(laneSetting('recheck')).toBe('requiredPolls');
  });
});

describe('lanes and headline on a state that is not what the types promise', () => {
  const broken: Partial<Record<keyof UiState, unknown>>[] = [
    { checks: undefined },
    { checks: null },
    { checks: 'checks' },
    { checks: [null, undefined, 7, 'x', {}, { id: 'quiet' }, { id: 'quiet', state: 'waiting', data: null }] },
    { sessions: undefined },
    { sessions: [null, 7, {}] },
    { contract: undefined },
    { contract: null },
    { platform: undefined },
  ];

  it.each(broken)('%j', (overrides) => {
    const state = { ...watchingState({ checks: checksWith(working, here) }), ...overrides } as UiState;
    const lanes = unmetLanes(state);
    expectPrintable(lanes);
    expectPrintable(headline(state));
    expect(lanes.flatMap((lane) => lane.unmet.map((unmet) => unmet.id))).not.toContain('armed');
  });
});
