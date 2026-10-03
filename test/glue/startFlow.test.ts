// Starting to watch: when the confirmation is asked, what its buttons mean, and what exactly is
// sent to the leader. The dialog is a fake that answers like a person would.

import { describe, expect, it } from 'vitest';

import { contractDigest } from '../../src/shared/config';
import type { ArmContract } from '../../src/shared/config';
import type { Command, CommandResult, UiState } from '../../src/shared/protocol';
import type { RealModalText } from '../../src/shared/text';
import type { WindowSnapshot } from '../../src/ui/snapshot';
import { LEADER_PLAN_WAIT_MS, StartFlow, modalAnswer, modalButtons } from '../../src/ui/startFlow';
import type { RealRunAnswer } from '../../src/ui/startFlow';
import { REALM, contract, snapshot, uiState, watching } from './fixtures';

const REAL_PLAN = contract({ testMode: false, action: 'shutdown' });
const TEST_PLAN = contract({ testMode: true, action: 'shutdown' });

interface Scene {
  flow: StartFlow;
  sent: Command[];
  events: string[];
  modals: RealModalText[];
  /** What the fake person presses; a function can change the world while the dialog is open. */
  answer: RealRunAnswer | (() => RealRunAnswer);
  current: WindowSnapshot;
  plan: ArmContract;
  reply: CommandResult;
  waited: number;
}

function scene(plan: ArmContract, state: UiState | null = uiState({ contract: plan }), unsaved = 0): Scene {
  const stage: Scene = {
    sent: [],
    events: [],
    modals: [],
    answer: 'keepOn',
    current: snapshot(state),
    plan,
    reply: { ok: true },
    waited: 0,
    flow: undefined as unknown as StartFlow,
  };
  stage.flow = new StartFlow({
    session: {
      get current() {
        return stage.current;
      },
      send: (command) => {
        stage.sent.push(command);
        stage.events.push('send');
        return Promise.resolve(stage.reply);
      },
    },
    settings: {
      get plan() {
        return stage.plan;
      },
      get digest() {
        return contractDigest(stage.plan);
      },
    },
    realm: REALM,
    confirmRealRun: (text) => {
      stage.modals.push(text);
      stage.events.push('confirm');
      return Promise.resolve(typeof stage.answer === 'function' ? stage.answer() : stage.answer);
    },
    saveAll: () => {
      stage.events.push('saveAll');
      return Promise.resolve();
    },
    unsavedFiles: () => unsaved,
    delay: (ms) => {
      stage.waited += ms;
      return Promise.resolve();
    },
  });
  return stage;
}

function armOf(plan: ArmContract, epoch = 'epoch-1'): Command {
  return { name: 'arm', contract: plan, digest: contractDigest(plan), epoch, realm: REALM };
}

describe('the confirmation dialog', () => {
  const text: RealModalText = {
    title: 'Shut down this PC when Claude finishes?',
    detail: 'rules',
    confirm: 'Shut down when finished',
    confirmAfterSave: 'Save all and shut down when finished',
    cancel: 'Keep this PC on',
  };

  it('puts "Keep this PC on" first, so that Enter presses it', () => {
    expect(modalButtons(text)).toEqual(['Keep this PC on', 'Shut down when finished', 'Save all and shut down when finished']);
    expect(modalButtons({ ...text, confirmAfterSave: null })).toEqual(['Keep this PC on', 'Shut down when finished']);
  });

  it('starts only on one of the two "when finished" buttons', () => {
    expect(modalAnswer(text, 'Shut down when finished')).toBe('start');
    expect(modalAnswer(text, 'Save all and shut down when finished')).toBe('saveAllFirst');
  });

  it.each([undefined, 'Keep this PC on', 'Cancel', '', 'shut down when finished', 'null'])('keeps this PC on for %j', (picked) => {
    expect(modalAnswer(text, picked)).toBe('keepOn');
    expect(modalAnswer({ ...text, confirmAfterSave: null }, picked)).toBe('keepOn');
  });

  it('does not offer "save all" as an answer when the dialog has no such button', () => {
    expect(modalAnswer({ ...text, confirmAfterSave: null }, 'Save all and shut down when finished')).toBe('keepOn');
  });
});

describe('StartFlow', () => {
  it('starts a test run at once, with the plan on screen and the epoch of the leader that showed it', async () => {
    const stage = scene(TEST_PLAN);
    await expect(stage.flow.start()).resolves.toEqual({ ok: true });
    expect(stage.sent).toEqual([armOf(TEST_PLAN)]);
    expect(stage.modals).toEqual([]);
  });

  it('starts "just notify me" at once, also when test run is off', async () => {
    const plan = contract({ testMode: false, action: 'notify' });
    const stage = scene(plan);
    await stage.flow.start();
    expect(stage.sent).toEqual([armOf(plan)]);
    expect(stage.modals).toEqual([]);
  });

  it('asks before a real run, and sends nothing when the person keeps this PC on', async () => {
    const stage = scene(REAL_PLAN);
    stage.answer = 'keepOn';
    await expect(stage.flow.start()).resolves.toEqual({ ok: false });
    expect(stage.modals).toHaveLength(1);
    expect(stage.sent).toEqual([]);
  });

  it('sends nothing for an answer it does not know', async () => {
    const stage = scene(REAL_PLAN);
    stage.answer = 'whatever' as RealRunAnswer;
    await stage.flow.start();
    expect(stage.sent).toEqual([]);
  });

  it('starts a real run after an explicit yes', async () => {
    const stage = scene(REAL_PLAN);
    stage.answer = 'start';
    await expect(stage.flow.start()).resolves.toEqual({ ok: true });
    expect(stage.events).toEqual(['confirm', 'send']);
    expect(stage.sent).toEqual([armOf(REAL_PLAN)]);
  });

  it('saves everything first when asked to, and only then starts', async () => {
    const stage = scene(REAL_PLAN, undefined, 2);
    stage.answer = 'saveAllFirst';
    await stage.flow.start();
    expect(stage.events).toEqual(['confirm', 'saveAll', 'send']);
  });

  it('describes in the dialog the plan it is about to send, the unsaved files and the unseen remote windows', async () => {
    const plan = contract({ testMode: false, action: 'hibernate', quietSeconds: 120 });
    const state = uiState({
      remoteWindows: [{ name: 'SSH: build-box', ignoreKey: 'remote:SSH: build-box', ignored: false, covered: false }],
    });
    const stage = scene(plan, state, 3);
    await stage.flow.start();
    const [modal] = stage.modals;
    expect(modal?.title).toContain('Hibernate');
    expect(modal?.detail).toContain('2 min');
    expect(modal?.detail).toContain('SSH: build-box');
    expect(modal?.confirmAfterSave).not.toBeNull();
    expect(modal?.cancel).toBe('Keep this PC on');
  });

  it('refuses when the settings changed while the dialog was open, instead of starting with either plan', async () => {
    const stage = scene(REAL_PLAN);
    stage.answer = () => {
      stage.plan = contract({ testMode: false, action: 'shutdown', quietSeconds: 30 });
      return 'start';
    };
    const result = await stage.flow.start();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('settings changed');
    expect(stage.sent).toEqual([]);
  });

  it('sends the epoch the person was looking at, so a leader that changed meanwhile refuses', async () => {
    const stage = scene(REAL_PLAN);
    stage.answer = () => {
      stage.current = snapshot(uiState({ contract: REAL_PLAN, epoch: 'epoch-2' }));
      return 'start';
    };
    await stage.flow.start();
    expect(stage.sent).toEqual([armOf(REAL_PLAN, 'epoch-1')]);
  });

  it("passes the leader's refusal on", async () => {
    const stage = scene(TEST_PLAN);
    stage.reply = { ok: false, error: 'Emergency stop is set.' };
    await expect(stage.flow.start()).resolves.toEqual({ ok: false, error: 'Emergency stop is set.' });
  });

  it.each([
    ['isolated', snapshot(null, { role: 'isolated' })],
    ['not connected', snapshot(null, { role: 'electing' })],
    ['already watching', snapshot(watching())],
    ['another version in control', snapshot(uiState(), { role: 'follower', limited: true })],
  ])('sends nothing and says why when %s', async (_name, current) => {
    const stage = scene(REAL_PLAN);
    stage.current = current;
    stage.answer = 'start';
    const result = await stage.flow.start();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(stage.sent).toEqual([]);
    expect(stage.modals).toEqual([]);
  });

  it('opens one dialog at a time', async () => {
    const stage = scene(REAL_PLAN);
    let press: (answer: RealRunAnswer) => void = () => undefined;
    const flow = new StartFlow({
      session: { current: stage.current, send: () => Promise.resolve({ ok: true }) },
      settings: { plan: REAL_PLAN, digest: contractDigest(REAL_PLAN) },
      realm: REALM,
      confirmRealRun: () => new Promise<RealRunAnswer>((resolve) => (press = resolve)),
      saveAll: () => Promise.resolve(),
      unsavedFiles: () => 0,
    });
    const first = flow.start();
    await expect(flow.start()).resolves.toMatchObject({ ok: false, error: 'Watching is already being started.' });
    press('keepOn');
    await expect(first).resolves.toEqual({ ok: false });
    // The flow is free again afterwards.
    const again = flow.start();
    press('start');
    await expect(again).resolves.toEqual({ ok: true });
  });

  it('waits for a leader with the same settings to show the plan before sending', async () => {
    const plan = contract({ testMode: true, quietSeconds: 60 });
    const stage = scene(plan, uiState());
    let polls = 0;
    const flow = new StartFlow({
      session: {
        get current() {
          return stage.current;
        },
        send: (command) => {
          stage.sent.push(command);
          return Promise.resolve({ ok: true });
        },
      },
      settings: { plan, digest: contractDigest(plan) },
      realm: REALM,
      confirmRealRun: () => Promise.resolve('keepOn'),
      saveAll: () => Promise.resolve(),
      unsavedFiles: () => 0,
      delay: () => {
        polls += 1;
        if (polls === 3) stage.current = snapshot(uiState({ contract: plan }));
        return Promise.resolve();
      },
    });
    await flow.start();
    expect(polls).toBe(3);
    expect(stage.sent).toEqual([armOf(plan)]);
  });

  it('does not wait for ever: after a few seconds it sends, and the leader answers for itself', async () => {
    const plan = contract({ testMode: true, quietSeconds: 60 });
    const stage = scene(plan, uiState());
    await stage.flow.start();
    expect(stage.waited).toBe(LEADER_PLAN_WAIT_MS);
    expect(stage.sent).toHaveLength(1);
  });

  it("does not wait for another editor's leader, whose settings are its own", async () => {
    const plan = contract({ testMode: true, quietSeconds: 60 });
    const stage = scene(plan, uiState({ contractRealm: 'another-editor' }));
    await stage.flow.start();
    expect(stage.waited).toBe(0);
    expect(stage.sent).toHaveLength(1);
  });
});
