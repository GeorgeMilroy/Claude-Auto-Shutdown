import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contractDigest } from '../../src/shared/config';
import type { Command, CommandResult } from '../../src/shared/protocol';
import { armedState, CONTRACT, Rig, sleep, TestWindow, waitFor } from './harness';

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.dispose();
});

const never = (): Promise<CommandResult> => new Promise(() => undefined);

const ARM: Command = {
  name: 'arm',
  contract: CONTRACT,
  digest: contractDigest(CONTRACT),
  epoch: 'epoch-leader',
  realm: 'realm-a',
};

function track(answer: Promise<CommandResult>): { result: CommandResult | null } {
  const tracked: { result: CommandResult | null } = { result: null };
  void answer.then((result) => (tracked.result = result));
  return tracked;
}

describe('Stop and Cancel across a change of leader', () => {
  it('re-sends an unconfirmed Stop and Cancel to the new leader', async () => {
    const leader = await rig.join('leader');
    leader.respond = never;
    const sender = await rig.join('sender');
    const bystander = await rig.join('bystander');
    const stop = track(sender.coordinator.send({ name: 'disarm' }));
    const cancel = track(sender.coordinator.send({ name: 'cancel', via: 'statusBar' }));
    await waitFor('the first leader got both', () => leader.commands.length === 2);

    leader.crash();
    await waitFor('both are confirmed', () => stop.result !== null && cancel.result !== null);

    expect(stop.result).toEqual({ ok: true });
    expect(cancel.result).toEqual({ ok: true });
    const next = [sender, bystander].find((window) => window.role === 'leader') as TestWindow;
    expect(next.commands).toEqual([
      { command: { name: 'disarm' }, from: sender.hello },
      { command: { name: 'cancel', via: 'statusBar' }, from: sender.hello },
    ]);
    expect(sender.delivered).toBe(1);
    expect(sender.stuck).toEqual([]);
  });

  it('delivers a Stop pressed while there is no leader as soon as there is one', async () => {
    const silent = await rig.rawLeader();
    const window = rig.window('window').start();
    await silent.accepted(1);

    const stop = track(window.coordinator.send({ name: 'disarm' }));
    await sleep(50);
    expect(stop.result).toBeNull();
    expect(window.role).toBe('electing');

    silent.close();
    await waitFor('the Stop is confirmed', () => stop.result !== null);
    expect(stop.result).toEqual({ ok: true });
    expect(window.role).toBe('leader');
    expect(window.commands).toEqual([{ command: { name: 'disarm' }, from: window.hello }]);
  });

  it('never sends an arm again: a lost leader is a "no"', async () => {
    const leader = await rig.join('leader');
    leader.respond = never;
    const sender = await rig.join('sender');
    const bystander = await rig.join('bystander');
    const arm = track(sender.coordinator.send(ARM));
    const refresh = track(sender.coordinator.send({ name: 'refresh' }));
    await waitFor('the first leader got both', () => leader.commands.length === 2);

    leader.crash();
    await waitFor('both are answered', () => arm.result !== null && refresh.result !== null);

    expect(arm.result?.ok).toBe(false);
    expect(arm.result?.error).toMatch(/closed before it answered/);
    expect(refresh.result?.ok).toBe(false);
    await waitFor('the survivors settled', () =>
      [sender, bystander].every((window) => window.role === 'leader' || window.role === 'follower'),
    );
    await sleep(300);
    expect(sender.commands).toEqual([]);
    expect(bystander.commands).toEqual([]);
  });
});

describe('a Stop or Cancel that nobody confirms', () => {
  it('is reported stuck after 2 s, and delivered once the leader answers', async () => {
    const leader = await rig.join('leader');
    let confirm: (result: CommandResult) => void = () => undefined;
    leader.respond = () => new Promise((resolve) => (confirm = resolve));
    const follower = await rig.join('follower');

    const sentAt = performance.now();
    const cancel = track(follower.coordinator.send({ name: 'cancel', via: 'esc' }));
    await waitFor('the leader got the Cancel', () => leader.commands.length === 1);
    await sleep(1500);
    expect(follower.stuck).toEqual([]);

    await waitFor('the Cancel is reported stuck', () => follower.stuck.length === 1, 2000);
    expect(performance.now() - sentAt).toBeGreaterThan(1900);
    expect(follower.stuck).toEqual([{ name: 'cancel', via: 'esc' }]);
    expect(follower.delivered).toBe(0);
    expect(cancel.result).toBeNull();

    confirm({ ok: true });
    await waitFor('the Cancel is confirmed', () => cancel.result !== null);
    expect(cancel.result).toEqual({ ok: true });
    expect(follower.delivered).toBe(1);
    expect(follower.stuck).toHaveLength(1);
  });

  it('counts a refusal from the leader as stuck, and keeps trying with the next leader', async () => {
    const leader = await rig.join('leader');
    leader.respond = async () => ({ ok: false, error: 'Broken controller.' });
    const follower = await rig.join('follower');

    const answer = await follower.coordinator.send({ name: 'disarm' });

    expect(answer).toEqual({ ok: false, error: 'Broken controller.' });
    expect(follower.stuck).toEqual([{ name: 'disarm' }]);
    expect(follower.delivered).toBe(0);

    leader.crash();
    await waitFor('the follower leads and confirms its own Stop', () => follower.delivered === 1);
    expect(follower.commands).toEqual([{ command: { name: 'disarm' }, from: follower.hello }]);
    expect(follower.stuck).toHaveLength(1);
  });

  it('is reported stuck at once when its window closes, before dispose() returns', async () => {
    const leader = await rig.join('leader');
    leader.respond = never;
    const follower = await rig.join('follower');
    const stop = track(follower.coordinator.send({ name: 'disarm' }));
    await waitFor('the leader got the Stop', () => leader.commands.length === 1);

    const closing = follower.coordinator.dispose();

    expect(follower.stuck).toEqual([{ name: 'disarm' }]);
    expect(await closing).toEqual({ handedOver: false });
    expect(stop.result).toEqual({ ok: false, error: 'This window is closing.' });
    expect(follower.delivered).toBe(0);
  });

  it('is not reported when the leader confirms in time', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    leader.state = armedState();

    expect(await follower.coordinator.send({ name: 'disarm' })).toEqual({ ok: true });
    await sleep(2200);

    expect(follower.stuck).toEqual([]);
    expect(follower.delivered).toBe(1);
  });
});
