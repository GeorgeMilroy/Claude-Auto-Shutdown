import { describe, expect, it } from 'vitest';
import type { CheckData, CheckId, CheckState } from '../../src/core/types';
import type { Config } from '../../src/shared/config';
import { describeCheck } from '../../src/shared/text';
import type { Lane } from '../../src/shared/text';
import {
  CHECK_DATA,
  CHECK_IDS,
  CHECK_STATES,
  GARBAGE,
  cantTellSession,
  check,
  context,
  contract,
  expectPrintable,
  finishedSession,
  foreignCheck,
  justFinishedSession,
  typicalCheck,
  workingSession,
} from './fixtures';

const LANES: Record<CheckId, Lane> = {
  armed: 'none',
  stopFile: 'pc',
  scanner: 'pc',
  helper: 'pc',
  actionAllowed: 'pc',
  remoteWindows: 'claude',
  registry: 'claude',
  unclaimedTranscripts: 'claude',
  hasSessions: 'claude',
  sessionsIdle: 'claude',
  turnsClosed: 'claude',
  quiet: 'claude',
  childProcesses: 'claude',
  userIdle: 'you',
  guard: 'pc',
  confirmed: 'recheck',
};

const LABELS: Record<CheckId, string> = {
  armed: 'Watching is on',
  stopFile: 'No Emergency stop',
  scanner: 'Can see Claude',
  helper: 'Can check this PC',
  actionAllowed: 'Shut down is available',
  remoteWindows: 'No unseen remote sessions',
  registry: 'Every Claude process accounted for',
  unclaimedTranscripts: 'No stray transcript activity',
  hasSessions: 'A session was seen',
  sessionsIdle: 'No session working',
  turnsClosed: 'Every turn ended',
  quiet: 'Quiet for 5 min',
  childProcesses: 'No command still running',
  userIdle: "You've been away 10 min",
  guard: 'Nothing on your keep-on list',
  confirmed: 'Stayed that way 3×',
};

const STATE_WORDS: Record<CheckState, string> = {
  pass: 'Pass',
  waiting: 'Waiting',
  cantTell: "Can't tell",
  fail: 'Problem',
};

const SETTINGS: Record<CheckId, keyof Config | null> = {
  armed: null,
  stopFile: null,
  scanner: null,
  helper: null,
  actionAllowed: 'action',
  remoteWindows: null,
  registry: null,
  unclaimedTranscripts: 'quietSeconds',
  hasSessions: 'allowWhenNoSessions',
  sessionsIdle: 'quietSeconds',
  turnsClosed: null,
  quiet: 'quietSeconds',
  childProcesses: 'waitForChildProcesses',
  userIdle: 'userIdleSeconds',
  guard: 'guardProcesses',
  confirmed: 'requiredPolls',
};

const EVERY_CHECK_AND_STATE = CHECK_IDS.flatMap((id) => CHECK_STATES.map((state) => [id, state] as const));

/** Data in which every key the check reads holds one junk value. */
function junkData(id: CheckId, junk: unknown): CheckData {
  const keys = new Set(CHECK_STATES.flatMap((state) => Object.keys(CHECK_DATA[id][state])));
  return Object.fromEntries([...keys].map((key) => [key, junk])) as CheckData;
}

describe('describeCheck: every check in every state', () => {
  it.each(EVERY_CHECK_AND_STATE)('%s / %s', (id, state) => {
    const text = describeCheck(typicalCheck(id, state), context());
    expect(text.lane).toBe(LANES[id]);
    expect(text.stateWord).toBe(STATE_WORDS[state]);
    expect(text.setting).toBe(SETTINGS[id]);
    expect(text.label).not.toBe('');
    expect(text.detail).not.toBe('');
    expectPrintable(text);
  });

  it.each(CHECK_IDS)('%s keeps its label in every state', (id) => {
    const labels = new Set(
      CHECK_STATES.map((state) => describeCheck(check(id, state, CHECK_DATA[id].pass), context()).label),
    );
    expect([...labels]).toEqual([LABELS[id]]);
  });

  it.each(EVERY_CHECK_AND_STATE)('%s / %s survives missing and junk data', (id, state) => {
    const variants: unknown[] = [{}, undefined, null, 'data', 7, ...GARBAGE.map((junk) => junkData(id, junk))];
    for (const data of variants) {
      const text = describeCheck(foreignCheck(id, state, data), context());
      expect(text.label).not.toBe('');
      expect(text.detail).not.toBe('');
      expect(text.lane).toBe(LANES[id]);
      expectPrintable(text);
    }
  });

  it.each(EVERY_CHECK_AND_STATE)('%s / %s survives a contract with no usable numbers', (id, state) => {
    for (const junk of GARBAGE) {
      const broken = contract({
        quietSeconds: junk as number,
        userIdleSeconds: junk as number,
        requiredPolls: junk as number,
        action: junk as 'shutdown',
      });
      expectPrintable(describeCheck(check(id, state), context({ contract: broken })));
    }
    expectPrintable(describeCheck(check(id, state), { contract: undefined, osName: undefined, sessions: undefined } as never));
  });

  it('never calls an unmet check a pass, whatever its state says', () => {
    for (const state of ['', 'PASS', 'ok', 'passed', 'unknown', undefined, null, 1]) {
      expect(describeCheck(foreignCheck('quiet', state as string), context()).stateWord).toBe("Can't tell");
    }
  });
});

describe('describeCheck: wording (ui-amendments section D)', () => {
  const detail = (id: CheckId, state: CheckState, data: CheckData = CHECK_DATA[id][state], ctx = context()) =>
    describeCheck(check(id, state, data), ctx).detail;

  it('armed', () => {
    expect(detail('armed', 'pass')).toBe('Yes');
    expect(detail('armed', 'waiting')).toBe('Not watching');
    expect(detail('armed', 'cantTell')).toBe("Can't tell whether watching is on");
  });

  it('stopFile', () => {
    expect(detail('stopFile', 'pass')).toBe('None set');
    expect(detail('stopFile', 'fail')).toBe('Emergency stop is set. Nothing happens until you delete the STOP file.');
    expect(detail('stopFile', 'cantTell')).toBe("Can't tell whether Emergency stop is set, so nothing happens.");
  });

  it('scanner', () => {
    expect(detail('scanner', 'pass')).toBe('Checked just now');
    expect(detail('scanner', 'cantTell', { reason: 'noScan', errors: [], roots: 0 })).toBe("Haven't checked yet");
    expect(detail('scanner', 'cantTell', { reason: 'stale', errors: [], roots: 1 })).toBe('The last check is too old to trust');
    expect(detail('scanner', 'cantTell', { reason: 'errors', errors: ['Could not read sessions/12.json (EACCES).'], roots: 1 })).toBe(
      'Could not read sessions/12.json (EACCES).',
    );
    expect(detail('scanner', 'cantTell', { reason: 'errors', errors: ['first problem', 'second', 'third'], roots: 1 })).toBe(
      'first problem (+2 more)',
    );
    expect(detail('scanner', 'cantTell', { reason: 'errors', errors: [], roots: 1 })).toBe(
      "Can't tell whether the session list is readable",
    );
  });

  it('helper', () => {
    expect(detail('helper', 'pass')).toBe('Helper running');
    expect(detail('helper', 'pass', { problem: "Idle time can't be measured", tier: 'limited' })).toBe(
      "Helper running. Idle time can't be measured.",
    );
    expect(detail('helper', 'fail', { problem: 'The Windows helper did not start', tier: 'unavailable' })).toBe(
      'The Windows helper did not start. Nothing will be shut down.',
    );
    expect(detail('helper', 'fail', { problem: 'VS Code runs inside Flatpak.', tier: 'unavailable' })).toBe(
      'VS Code runs inside Flatpak. Nothing will be shut down.',
    );
    expect(detail('helper', 'fail', { problem: null, tier: 'unavailable' })).toBe(
      "The helper didn't start. Nothing will be shut down.",
    );
    expect(detail('helper', 'cantTell', { problem: null, tier: 'full' })).toBe(
      "Couldn't read the process list. Nothing will be shut down.",
    );
  });

  it('actionAllowed', () => {
    expect(detail('actionAllowed', 'pass')).toBe('Allowed by Windows');
    expect(detail('actionAllowed', 'pass', { action: 'sleep', detail: '' }, context({ osName: 'Linux' }))).toBe('Allowed by Linux');
    expect(detail('actionAllowed', 'fail')).toBe('Hibernation is turned off on this PC');
    expect(detail('actionAllowed', 'fail', { action: 'hibernate', detail: '' })).toBe("Hibernate isn't available on this PC");
    expect(detail('actionAllowed', 'cantTell')).toBe("Can't confirm hibernate is allowed on this PC.");
    expect(detail('actionAllowed', 'cantTell', { action: 'shutdown', detail: 'busctl is not installed' })).toBe(
      "Can't confirm shut down is allowed on this PC. busctl is not installed.",
    );
  });

  it.each([
    ['shutdown', 'Shut down is available'],
    ['hibernate', 'Hibernate is available'],
    ['sleep', 'Sleep is available'],
    ['lock', 'Lock is available'],
    ['notify', 'Notification is available'],
  ])('actionAllowed label for %s', (action, label) => {
    expect(describeCheck(check('actionAllowed', 'pass', { action, detail: '' }), context()).label).toBe(label);
  });

  it('actionAllowed falls back to the contract action, and admits an action it does not know', () => {
    const lock = context({ contract: contract({ action: 'lock' }) });
    expect(describeCheck(check('actionAllowed', 'pass', {}), lock).label).toBe('Lock is available');
    expect(describeCheck(check('actionAllowed', 'pass', { action: 'restart' }), lock).label).toBe('Lock is available');
    const foreign = context({ contract: contract({ action: 'restart' as 'lock' }) });
    expect(describeCheck(check('actionAllowed', 'pass', {}), foreign).label).toBe('Unknown action is available');
    expect(detail('actionAllowed', 'pass', { action: 'notify', detail: '' })).toBe('Only a message. Nothing ever turns off.');
  });

  it('remoteWindows', () => {
    expect(detail('remoteWindows', 'pass')).toBe('Not waiting for: SSH: build-box · Covered: WSL: Ubuntu');
    expect(detail('remoteWindows', 'pass', { blocking: [], ignored: [], covered: ['WSL: Ubuntu'] })).toBe('Covered: WSL: Ubuntu');
    expect(detail('remoteWindows', 'pass', { blocking: [], ignored: [], covered: [] })).toBe('None');
    expect(detail('remoteWindows', 'cantTell', { blocking: ['SSH: build-box'], ignored: [], covered: [] })).toBe(
      "A VS Code window is connected to SSH: build-box. Claude sessions there can't be seen from here.",
    );
    expect(detail('remoteWindows', 'cantTell')).toBe(
      "VS Code windows are connected to SSH: build-box and Dev Container. Claude sessions there can't be seen from here.",
    );
    expect(detail('remoteWindows', 'cantTell', { blocking: [], ignored: [], covered: [] })).toBe(
      "Can't tell whether a VS Code window is connected to another machine, so I wait.",
    );
  });

  it('registry', () => {
    expect(detail('registry', 'pass')).toBe('All matched');
    expect(detail('registry', 'pass', { reason: '', pids: [], names: [], strays: 1 })).toBe(
      '1 extra process accounted for or not waited for',
    );
    expect(detail('registry', 'pass', { reason: '', pids: [], names: [], strays: 2 })).toBe(
      '2 extra processes accounted for or not waited for',
    );
    expect(detail('registry', 'cantTell', { reason: 'unaccounted', pids: [123], names: ['claude'], strays: 1 })).toBe(
      `A Claude process (PID 123) can't be matched to a session. Staying on until it exits, or until you choose "Don't wait for it".`,
    );
    expect(detail('registry', 'cantTell', { reason: 'unaccounted', pids: [123, 456], names: [], strays: 2 })).toBe(
      `2 Claude processes (PIDs 123 and 456) can't be matched to a session. Staying on until they exit, or until you choose "Don't wait for it" for each.`,
    );
    expect(detail('registry', 'cantTell', { reason: 'unaccounted', pids: [], names: [], strays: 1 })).toBe(
      `A Claude process can't be matched to a session. Staying on until it exits, or until you choose "Don't wait for it".`,
    );
    expect(detail('registry', 'cantTell', { reason: 'noProcessList', pids: [], names: [], strays: 0 })).toBe(
      "Couldn't read the process list",
    );
    expect(detail('registry', 'cantTell', {})).toBe("Haven't checked yet");
  });

  it('unclaimedTranscripts', () => {
    expect(detail('unclaimedTranscripts', 'pass')).toBe('None');
    expect(detail('unclaimedTranscripts', 'waiting', { count: 1, project: 'D--work-api', secondsAgo: 40, quietSeconds: 300 })).toBe(
      'A Claude transcript in D--work-api changed 40 s ago and no running session owns it. Waiting until it has been quiet 5 min.',
    );
    expect(detail('unclaimedTranscripts', 'waiting')).toBe(
      'A Claude transcript in D--work-api changed 40 s ago and no running session owns it (+1 more like it). Waiting until it has been quiet 5 min.',
    );
    expect(detail('unclaimedTranscripts', 'waiting', {})).toBe(
      'A Claude transcript changed recently and no running session owns it. Waiting until it has been quiet 5 min.',
    );
    expect(detail('unclaimedTranscripts', 'cantTell')).toBe("Haven't checked yet");
  });

  it('hasSessions', () => {
    expect(detail('hasSessions', 'pass')).toBe('Last one ended 15 min ago');
    expect(detail('hasSessions', 'pass', { sawAny: false, secondsSinceLast: null, quietSeconds: 300 })).toBe('Not required');
    expect(detail('hasSessions', 'waiting', { sawAny: false, secondsSinceLast: null, quietSeconds: 300 })).toBe(
      'No Claude session yet. I wait for one to appear and finish.',
    );
    expect(detail('hasSessions', 'waiting')).toBe('The last session ended 40 s ago; waiting 5 min.');
    expect(detail('hasSessions', 'cantTell')).toBe("Can't tell when the last session ended, so I wait.");
    expect(detail('hasSessions', 'waiting', { sawAny: true, secondsSinceLast: NaN, quietSeconds: 300 })).toBe(
      "Can't tell when the last session ended, so I wait.",
    );
    expect(detail('hasSessions', 'cantTell', { sawAny: null, secondsSinceLast: null, quietSeconds: 300 })).toBe(
      "Can't tell whether a Claude session was seen, so I wait.",
    );
  });

  it('sessionsIdle, from the check data when there is no session list', () => {
    expect(detail('sessionsIdle', 'pass', { total: 3, working: 0, cantTell: 0, ignored: 0, names: [] })).toBe('All 3 finished');
    expect(detail('sessionsIdle', 'pass', { total: 1, working: 0, cantTell: 0, ignored: 0, names: [] })).toBe(
      'The only session finished',
    );
    expect(detail('sessionsIdle', 'pass')).toBe('2 of 3 finished (1 not waited for)');
    expect(detail('sessionsIdle', 'pass', { total: 0, working: 0, cantTell: 0, ignored: 0, names: [] })).toBe('No session running');
    expect(detail('sessionsIdle', 'waiting')).toBe('2 of 3 still working');
    expect(detail('sessionsIdle', 'cantTell')).toBe("2 of 3 still working · 1 can't tell");
    expect(detail('sessionsIdle', 'cantTell', { total: 1, working: 0, cantTell: 1, ignored: 0, names: [] })).toBe(
      "Can't tell about 1 of 1",
    );
    expect(detail('sessionsIdle', 'cantTell', {})).toBe("Haven't checked yet");
  });

  it('sessionsIdle, split by status when the session list is there', () => {
    const sessions = [
      cantTellSession('scratch'),
      workingSession('api-refactor'),
      workingSession('web-ui'),
      justFinishedSession('docs'),
      finishedSession('infra'),
      workingSession('parked', { ignored: true }),
    ];
    expect(detail('sessionsIdle', 'cantTell', {}, context({ sessions }))).toBe(
      "2 of 6 still working · 1 just finished · 1 can't tell",
    );
    expect(detail('sessionsIdle', 'waiting', {}, context({ sessions: [justFinishedSession('docs'), finishedSession('infra')] }))).toBe(
      '1 of 2 just finished',
    );
    expect(detail('sessionsIdle', 'pass', {}, context({ sessions: [finishedSession('infra'), finishedSession('docs')] }))).toBe(
      'Both finished',
    );
    expect(
      detail('sessionsIdle', 'pass', {}, context({ sessions: [finishedSession('infra'), workingSession('parked', { ignored: true })] })),
    ).toBe('1 of 2 finished (1 not waited for)');
  });

  it('sessionsIdle counts the sessions that need an answer apart from the working ones', () => {
    const asking = (name: string) => workingSession(name, { turnReason: 'claudeWaiting', turnDetail: 'permission prompt' });
    expect(detail('sessionsIdle', 'waiting', {}, context({ sessions: [asking('web-ui')] }))).toBe('1 of 1 needs your answer');
    const sessions = [workingSession('api-refactor'), asking('web-ui'), asking('docs'), finishedSession('infra')];
    expect(detail('sessionsIdle', 'waiting', {}, context({ sessions }))).toBe('1 of 4 still working · 2 need your answer');
    expect(detail('sessionsIdle', 'waiting', {}, context({ sessions: [asking('web-ui'), justFinishedSession('docs')] }))).toBe(
      '1 of 2 needs your answer · 1 just finished',
    );
    // Its question let go (waitForAnswers off) but held by something else: plainly still working.
    const letGo = workingSession('loop', { turn: 'CLOSED', turnReason: 'claudeWaiting', why: { id: 'scheduledWakeup', inSeconds: 600 } });
    expect(detail('sessionsIdle', 'waiting', {}, context({ sessions: [letGo, justFinishedSession('docs')] }))).toBe(
      '1 of 2 still working · 1 just finished',
    );
    // Let go by the user: not counted at all.
    expect(detail('sessionsIdle', 'pass', {}, context({ sessions: [asking('web-ui'), finishedSession('infra')].map((s, i) => (i === 0 ? { ...s, ignored: true } : s)) }))).toBe(
      '1 of 2 finished (1 not waited for)',
    );
  });

  it('sessionsIdle keeps to the numbers of the check when the session list is a different one', () => {
    const sessions = [workingSession('api-refactor'), justFinishedSession('docs')];
    const counted = { total: 3, working: 2, cantTell: 1, ignored: 0, names: [] };
    expect(detail('sessionsIdle', 'cantTell', counted, context({ sessions }))).toBe("2 of 3 still working · 1 can't tell");
    const matching = { total: 2, working: 2, cantTell: 0, ignored: 0, names: [] };
    expect(detail('sessionsIdle', 'waiting', matching, context({ sessions }))).toBe('1 of 2 still working · 1 just finished');
  });

  it('turnsClosed', () => {
    expect(detail('turnsClosed', 'pass')).toBe('All ended');
    expect(detail('turnsClosed', 'waiting')).toBe('api-refactor: Running a tool (+1 more)');
    expect(detail('turnsClosed', 'cantTell')).toBe('scratch: No transcript found');
    expect(detail('turnsClosed', 'cantTell', { names: ['scratch'], reasons: [] })).toBe("scratch: Can't tell");
    expect(detail('turnsClosed', 'cantTell', { names: ['scratch'], reasons: ['somethingNew'] })).toBe('scratch: somethingNew');
    expect(detail('turnsClosed', 'cantTell', { names: [], reasons: [] })).toBe("Haven't checked yet");
  });

  it('quiet', () => {
    expect(detail('quiet', 'pass')).toBe('Quietest: 1 h 2 min (infra)');
    expect(detail('quiet', 'waiting')).toBe('Quiet 0:18 of 5:00 (docs)');
    expect(detail('quiet', 'cantTell')).toBe("Can't tell how long scratch has been quiet");
    expect(detail('quiet', 'cantTell', { quietestSeconds: null, name: '', quietSeconds: 300 })).toBe(
      "Can't tell how long the sessions have been quiet",
    );
    expect(describeCheck(check('quiet', 'waiting', { quietestSeconds: 18, name: 'docs', quietSeconds: 90 }), context()).label).toBe(
      'Quiet for 90 s',
    );
    const noLimit = context({ contract: contract({ quietSeconds: NaN, userIdleSeconds: NaN }) });
    expect(detail('quiet', 'cantTell', { quietestSeconds: 18, name: 'docs', quietSeconds: null }, noLimit)).toBe(
      "Quiet 18 s (docs), but can't tell how long is required",
    );
    expect(detail('userIdle', 'cantTell', { idleSeconds: 240, userIdleSeconds: null }, noLimit)).toBe(
      "Away 4 min, but can't tell how long is required",
    );
  });

  it('childProcesses', () => {
    expect(detail('childProcesses', 'pass')).toBe('None');
    expect(detail('childProcesses', 'waiting')).toBe('npm (PID 4321) started by web-ui (+1 more)');
    expect(detail('childProcesses', 'waiting', { items: ['npm (PID 4321) started by web-ui'] })).toBe(
      'npm (PID 4321) started by web-ui',
    );
    expect(detail('childProcesses', 'waiting', { items: [] })).toBe('A command started by a session is still running');
    expect(detail('childProcesses', 'cantTell')).toBe(
      "Can't tell whether a command started by a session is still running",
    );
  });

  it('userIdle', () => {
    expect(detail('userIdle', 'pass')).toBe('Away 25 min');
    expect(detail('userIdle', 'waiting')).toBe("You're here. Away 0:04 of 10:00");
    expect(detail('userIdle', 'cantTell')).toBe(
      'Can\'t tell whether you\'re away, so I wait. Turn off "Require me to be away" to skip this.',
    );
    // A wait with no readable idle time is a "can't tell", not "0:00 of 10:00".
    expect(detail('userIdle', 'waiting', { idleSeconds: NaN, userIdleSeconds: 600 })).toBe(
      'Can\'t tell whether you\'re away, so I wait. Turn off "Require me to be away" to skip this.',
    );
  });

  it('guard', () => {
    expect(detail('guard', 'pass')).toBe('None running');
    expect(detail('guard', 'waiting')).toBe('ffmpeg is running (keep-on list)');
    expect(detail('guard', 'waiting', { hits: ['ffmpeg', 'blender'] })).toBe('ffmpeg and blender are running (keep-on list)');
    expect(detail('guard', 'waiting', { hits: ['a', 'b', 'c', 'd', 'e'] })).toBe('a, b and 3 more are running (keep-on list)');
    expect(detail('guard', 'cantTell')).toBe("Couldn't read the process list");
  });

  it('confirmed', () => {
    expect(detail('confirmed', 'pass')).toBe('3 of 3');
    expect(detail('confirmed', 'waiting')).toBe('1 of 3');
    expect(detail('confirmed', 'waiting', { k: NaN, n: 3 })).toBe("Can't tell");
    expect(detail('confirmed', 'cantTell')).toBe("Can't tell");
    expect(describeCheck(check('confirmed', 'waiting', { k: 1, n: 5 }), context()).label).toBe('Stayed that way 5×');
  });

  it('uses the contract for a threshold the check did not report', () => {
    const rules = context({ contract: contract({ quietSeconds: 150, userIdleSeconds: 3600, requiredPolls: 4 }) });
    expect(describeCheck(check('quiet', 'pass', {}), rules).label).toBe('Quiet for 2 min 30 s');
    expect(describeCheck(check('userIdle', 'pass', {}), rules).label).toBe("You've been away 1 h");
    expect(describeCheck(check('confirmed', 'waiting', { k: 2 }), rules).detail).toBe('2 of 4');
  });
});

describe('describeCheck: a check id this version does not know', () => {
  it('prints the id verbatim in the This PC lane with its raw data', () => {
    const text = describeCheck(foreignCheck('diskSpace', 'waiting', { freeGb: 3, drives: ['C:'] }), context());
    expect(text).toEqual({
      lane: 'pc',
      label: 'diskSpace',
      detail: '{"freeGb":3,"drives":["C:"]}',
      stateWord: 'Waiting',
      setting: null,
    });
  });

  it('spells out unknown values instead of leaking them', () => {
    const text = describeCheck(foreignCheck('diskSpace', 'cantTell', { freeGb: NaN, drive: null, max: Infinity }), context());
    expect(text.detail).toBe('{"freeGb":"unknown","drive":"unknown","max":"unknown"}');
    expectPrintable(text);
  });

  it('is not fooled by names that live on Object.prototype', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const text = describeCheck(foreignCheck(id, 'pass'), context());
      expect(text.lane).toBe('pc');
      expect(text.label).toBe(id);
    }
  });

  it('copes with an id that is not even a string', () => {
    for (const id of [undefined, null, 7, {}]) {
      const text = describeCheck(foreignCheck(id as unknown as string, 'fail', undefined), context());
      expect(text.label).toBe('Unnamed check');
      expect(text.stateWord).toBe('Problem');
      expectPrintable(text);
    }
  });
});
