import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_LINE_BYTES } from '../../src/coordination/framing';
import { contractDigest } from '../../src/shared/config';
import type { Command, UiState } from '../../src/shared/protocol';
import { hugeState } from './bigState';
import { armedState, CONTRACT, makeState, provenHello, Rig, sleep, waitFor, welcomeProofFor } from './harness';

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.dispose();
});

describe('state', () => {
  it('welcomes a follower with the current state and the identity of the leader', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState({ epoch: 'epoch-leader', seq: 7 });
    const before = performance.now();

    const follower = await rig.join('follower');
    await waitFor('the follower has a state', () => follower.remote !== undefined);

    expect(follower.role).toBe('follower');
    expect(follower.remotes).toHaveLength(1);
    expect(follower.remote!.state).toEqual(leader.state);
    expect(follower.remote!.limited).toBe(false);
    expect(follower.remote!.leader).toEqual({
      windowId: leader.hello.windowId,
      label: 'leader',
      app: leader.hello.app,
      ext: leader.hello.ext,
      pid: leader.hello.pid,
      realm: leader.hello.realm,
    });
    expect(follower.remote!.receivedAtMono).toBeGreaterThanOrEqual(before);
    expect(follower.remote!.receivedAtMono).toBeLessThanOrEqual(performance.now());
  });

  it('pushes every published state to every follower, in order', async () => {
    const leader = await rig.join('leader');
    const followers = [await rig.join('a'), await rig.join('b'), await rig.join('c')];

    leader.coordinator.publish(makeState({ seq: 41 }));
    leader.coordinator.publish(armedState({ seq: 42 }));

    await waitFor('all followers show seq 42', () => followers.every((window) => window.remote?.state?.seq === 42));
    for (const follower of followers) {
      expect(follower.remotes.map((remote) => remote.state?.seq)).toEqual([1, 41, 42]);
      expect(follower.remote!.state).toEqual(armedState({ seq: 42 }));
    }
    expect(leader.remotes).toEqual([]);
  });

  it('ignores publish() from a window that is not the leader', async () => {
    const leader = await rig.join('leader');
    const a = await rig.join('a');
    const b = await rig.join('b');

    a.coordinator.publish(armedState({ seq: 99 }));
    leader.coordinator.publish(makeState({ seq: 2 }));

    await waitFor('b shows seq 2', () => b.remote?.state?.seq === 2);
    expect(b.remotes.map((remote) => remote.state?.seq)).toEqual([1, 2]);
  });

  it("shows nothing rather than the previous state when the leader's state can't be read", async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    await waitFor('the follower has a state', () => follower.remote?.state != null);

    leader.coordinator.publish({ ...makeState({ seq: 2 }), checks: null } as unknown as UiState);
    await waitFor('the follower dropped its state', () => follower.remote?.state === null);
    expect(follower.remote!.leader?.label).toBe('leader');
    expect(follower.role).toBe('follower');

    leader.coordinator.publish(makeState({ seq: 3 }));
    await waitFor('the follower shows seq 3', () => follower.remote?.state?.seq === 3);
  });

  it('trims a state larger than one message instead of leaving the followers with nothing', async () => {
    const leader = await rig.join('leader');
    leader.state = hugeState({ epoch: 'epoch-leader' });
    const follower = await rig.join('follower');
    await waitFor('the follower has the state', () => follower.remote?.state != null);

    const welcomed = follower.remote!.state!;
    expect(welcomed).toMatchObject({ phase: 'countdown', armed: true, countdown: leader.state.countdown });
    expect(welcomed.sessionsOmitted).toBeGreaterThan(0);
    expect(welcomed.sessions.length + welcomed.sessionsOmitted).toBe(300);

    leader.coordinator.publish(hugeState({ epoch: 'epoch-leader', seq: 2 }));
    await waitFor('the follower shows seq 2', () => follower.remote?.state?.seq === 2);
    expect(follower.role).toBe('follower');
    expect(follower.remotes.every((remote) => remote.state !== null)).toBe(true);
  });

  it('does not send a state that would not fit in one line, and says so once', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    await waitFor('the follower has a state', () => follower.remote?.state != null);
    const huge = makeState({ seq: 2, logFile: 'x'.repeat(MAX_LINE_BYTES) });

    leader.coordinator.publish(huge);
    leader.coordinator.publish(huge);
    leader.coordinator.publish(makeState({ seq: 3 }));

    await waitFor('the follower shows seq 3', () => follower.remote?.state?.seq === 3);
    expect(follower.remotes.map((remote) => remote.state?.seq)).toEqual([1, 3]);
    expect(follower.role).toBe('follower');
    expect(leader.logs.filter((line) => line.includes('too large'))).toHaveLength(1);
  });
});

describe('commands', () => {
  it("runs a follower's command in the leader's controller and returns its answer", async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    leader.respond = async (command) =>
      command.name === 'preview' ? { ok: false, error: 'Not while watching.' } : { ok: true };
    const arm: Command = {
      name: 'arm',
      contract: CONTRACT,
      digest: contractDigest(CONTRACT),
      epoch: 'epoch-leader',
      realm: 'realm-a',
    };

    expect(await follower.coordinator.send({ name: 'refresh' })).toEqual({ ok: true });
    expect(await follower.coordinator.send({ name: 'preview' })).toEqual({ ok: false, error: 'Not while watching.' });
    expect(await follower.coordinator.send(arm)).toEqual({ ok: true });
    expect(await follower.coordinator.send({ name: 'ignore', key: 'session:1', on: true })).toEqual({ ok: true });

    expect(leader.commands).toEqual([
      { command: { name: 'refresh' }, from: follower.hello },
      { command: { name: 'preview' }, from: follower.hello },
      { command: arm, from: follower.hello },
      { command: { name: 'ignore', key: 'session:1', on: true }, from: follower.hello },
    ]);
    expect(follower.commands).toEqual([]);
  });

  it("calls the leader's own handlers directly for a command sent from the leader's window", async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    leader.respond = async (command) => (command.name === 'disarm' ? { ok: true } : { ok: false, error: 'No.' });

    expect(await leader.coordinator.send({ name: 'refresh' })).toEqual({ ok: false, error: 'No.' });
    expect(await leader.coordinator.send({ name: 'disarm' })).toEqual({ ok: true });

    expect(leader.commands).toEqual([
      { command: { name: 'refresh' }, from: leader.hello },
      { command: { name: 'disarm' }, from: leader.hello },
    ]);
    expect(follower.commands).toEqual([]);
    expect(leader.delivered).toBe(1);
  });

  it('turns a controller that throws into a refusal instead of a broken connection', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    leader.respond = () => {
      throw new Error('boom');
    };

    const remote = await follower.coordinator.send({ name: 'refresh' });
    const local = await leader.coordinator.send({ name: 'refresh' });

    expect(remote.ok).toBe(false);
    expect(remote.error).toMatch(/hit an error/);
    expect(local.ok).toBe(false);
    expect(follower.role).toBe('follower');
    expect(leader.logs.some((line) => line.includes('boom'))).toBe(true);
  });

  it('runs a command once when it arrives twice with the same id, and answers both', async () => {
    const leader = await rig.join('leader');
    const client = await rig.rawClient('raw');

    client.send({ t: 'cmd', id: 'same-id', cmd: { name: 'disarm' } });
    client.send({ t: 'cmd', id: 'same-id', cmd: { name: 'disarm' } });
    client.send({ t: 'cmd', id: 'other-id', cmd: { name: 'disarm' } });

    await waitFor('three acks', () => client.of('ack').length === 3);
    expect(leader.commandNames()).toEqual(['disarm', 'disarm']);
    expect(client.of('ack')).toEqual([
      { t: 'ack', id: 'same-id', ok: true },
      { t: 'ack', id: 'same-id', ok: true },
      { t: 'ack', id: 'other-id', ok: true },
    ]);
  });

  it('answers a command it cannot read instead of running or ignoring it', async () => {
    const leader = await rig.join('leader');
    const client = await rig.rawClient('raw');

    client.send({ t: 'cmd', id: '1', cmd: { name: 'selfDestruct' } });
    client.send({ t: 'cmd', id: '2', cmd: { name: 'ignore', key: 5, on: 'yes' } });
    const halfAnArm = { name: 'arm', contract: { action: 'shutdown' }, digest: 'd', epoch: 'e', realm: 'r' };
    client.send({ t: 'cmd', id: '3', cmd: halfAnArm });
    client.send({ t: 'cmd', id: '4', cmd: 'disarm' });

    await waitFor('four acks', () => client.of('ack').length === 4);
    expect(client.of('ack').map((ack) => ack.ok)).toEqual([false, false, false, false]);
    expect(leader.commands).toEqual([]);
  });

  it('never lets a malformed cancel fail: it becomes a plain cancel', async () => {
    const leader = await rig.join('leader');
    const client = await rig.rawClient('raw');

    client.send({ t: 'cmd', id: '1', cmd: { name: 'cancel', via: 'telepathy', extra: [1, 2] } });
    client.send({ t: 'cmd', id: '2', cmd: { name: 'cancel' } });

    await waitFor('two acks', () => client.of('ack').length === 2);
    expect(client.of('ack').map((ack) => ack.ok)).toEqual([true, true]);
    expect(leader.commands.map(({ command }) => command)).toEqual([
      { name: 'cancel', via: 'command' },
      { name: 'cancel', via: 'command' },
    ]);
  });

  it('refuses everything but Cancel and Stop while this window has no leader connection', async () => {
    const lonely = rig.window('lonely');

    const answer = await lonely.coordinator.send({ name: 'refresh' });

    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/Not connected/);
  });
});

describe('peers', () => {
  it('lists followers with their hello, including the remote name', async () => {
    const leader = await rig.join('leader');
    const local = await rig.join('local');
    const remote = await rig.join('remote', { hello: { remote: 'SSH: build-box' } });

    await waitFor('two peers', () => leader.coordinator.peers().length === 2);

    expect(leader.coordinator.peers()).toEqual([
      { hello: local.hello, viewVisible: false },
      { hello: remote.hello, viewVisible: false },
    ]);
    expect(leader.coordinator.peers()[1]!.hello.remote).toBe('SSH: build-box');
    expect(leader.peerChanges).toBe(2);
    expect(local.coordinator.peers()).toEqual([]);
  });

  it("tracks each follower's dashboard visibility", async () => {
    const leader = await rig.join('leader');
    const a = await rig.join('a');
    const b = await rig.join('b');
    await waitFor('two peers', () => leader.coordinator.peers().length === 2);
    const visibility = (): boolean[] => leader.coordinator.peers().map((peer) => peer.viewVisible);

    b.coordinator.setViewVisible(true);
    await waitFor('b is visible', () => visibility()[1] === true);
    expect(visibility()).toEqual([false, true]);
    const changesAfterShow = leader.peerChanges;

    b.coordinator.setViewVisible(true);
    b.coordinator.setViewVisible(false);
    await waitFor('b is hidden', () => visibility()[1] === false);
    expect(leader.peerChanges).toBe(changesAfterShow + 1);
    expect(a.peerChanges).toBe(0);
  });

  it('reports a dashboard that was already visible before the window connected', async () => {
    const leader = await rig.join('leader');
    const early = rig.window('early');
    early.coordinator.setViewVisible(true);

    early.start();

    await waitFor('early is a visible peer', () => leader.coordinator.peers()[0]?.viewVisible === true);
  });

  it('forgets a follower when its window closes', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    follower.coordinator.setViewVisible(true);
    await waitFor('one visible peer', () => leader.coordinator.peers()[0]?.viewVisible === true);

    expect(await follower.coordinator.dispose()).toEqual({ handedOver: false });

    await waitFor('no peers', () => leader.coordinator.peers().length === 0);
    expect(leader.role).toBe('leader');
  });

  it('counts a window once when it connects a second time', async () => {
    const leader = await rig.join('leader');
    const first = await rig.rawClient('twin');
    const [twin] = leader.coordinator.peers();

    const second = await rig.rawConnection();
    second.send(provenHello(twin!.hello));

    await waitFor('the first connection is closed', () => first.closed);
    expect(leader.coordinator.peers()).toHaveLength(1);
    expect(second.closed).toBe(false);
  });
});

describe('a peer that breaks the protocol', () => {
  it('is cut off for a line that is not JSON, and nobody else notices', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    const rogue = await rig.rawClient('rogue');
    await waitFor('two peers', () => leader.coordinator.peers().length === 2);

    rogue.sendRaw('this is not json\n');

    await waitFor('the rogue is cut off', () => rogue.closed);
    await waitFor('one peer left', () => leader.coordinator.peers().length === 1);
    expect(leader.role).toBe('leader');
    expect(follower.role).toBe('follower');
    leader.coordinator.publish(makeState({ seq: 5 }));
    await waitFor('the follower still gets states', () => follower.remote?.state?.seq === 5);
    expect(await follower.coordinator.send({ name: 'refresh' })).toEqual({ ok: true });
  });

  it('is cut off for JSON that is not an object', async () => {
    await rig.join('leader');
    const rogue = await rig.rawClient('rogue');

    rogue.sendRaw('[1,2,3]\n');

    await waitFor('the rogue is cut off', () => rogue.closed);
  });

  it('is cut off for a line longer than 256 KB, and nobody else notices', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    const rogue = await rig.rawClient('rogue');

    rogue.sendRaw(Buffer.alloc(MAX_LINE_BYTES + 1024, 0x61));

    await waitFor('the rogue is cut off', () => rogue.closed);
    expect(leader.role).toBe('leader');
    expect(follower.role).toBe('follower');
    expect(await follower.coordinator.send({ name: 'refresh' })).toEqual({ ok: true });
  });

  it('is not processed any further once a line in the same packet was bad', async () => {
    const leader = await rig.join('leader');
    const rogue = await rig.rawClient('rogue');

    const refresh = (id: string): string => JSON.stringify({ t: 'cmd', id, cmd: { name: 'refresh' } });
    rogue.sendRaw(`${refresh('1')}\nnot json\n${refresh('2')}\n`);

    await waitFor('the rogue is cut off', () => rogue.closed);
    await sleep(50);
    expect(leader.commandNames()).toEqual(['refresh']);
  });

  it('is cut off when it never says hello', async () => {
    const leader = await rig.join('leader');
    const mute = await rig.rawConnection();
    const connectedAt = performance.now();

    await waitFor('the mute connection is closed', () => mute.closed, 4000);

    expect(performance.now() - connectedAt).toBeGreaterThan(1800);
    expect(mute.received).toEqual([]);
    expect(leader.coordinator.peers()).toEqual([]);
  });

  it('gets no answer to anything before its hello, and no welcome for a hello that cannot be read', async () => {
    const leader = await rig.join('leader');
    const client = await rig.rawConnection();

    const hello = { t: 'hello', v: 1, windowId: 'w', pid: 1, app: 'a', ext: 'e', realm: 'r', label: 'l' };
    client.send({ t: 'cmd', id: '1', cmd: { name: 'disarm' } });
    client.send(hello); // no `remote`
    client.send({ ...hello, pid: 'x', remote: null });
    await sleep(150);

    expect(client.received).toEqual([]);
    expect(leader.commands).toEqual([]);
    expect(leader.coordinator.peers()).toEqual([]);
    expect(client.closed).toBe(false);
  });

  it('keeps its connection when it sends a message type this version does not know', async () => {
    const leader = await rig.join('leader');
    const client = await rig.rawClient('newer');

    client.send({ t: 'somethingFromTheFuture', payload: 1 });
    client.send({ t: 'view', visible: 'yes' });
    client.send({ t: 'cmd', id: '1', cmd: { name: 'refresh' } });

    await waitFor('the command is answered', () => client.of('ack').length === 1);
    expect(client.closed).toBe(false);
    expect(leader.coordinator.peers()[0]!.viewVisible).toBe(false);
    expect(leader.logs.filter((line) => line.includes("can't use"))).toHaveLength(1);
  });

  it('as a leader: is dropped by the follower, which then looks for a new leader', async () => {
    const bad = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await bad.accepted(1);
    const connection = bad.latest;
    bad.welcome(connection, armedState());
    await waitFor('the follower shows the state', () => follower.remote?.state?.armed === true);

    connection.socket.write('garbage\n');

    await waitFor('the follower hung up', () => connection.closed);
    await waitFor('the follower shows nothing', () => follower.remote?.state === null);
    bad.close();
    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
  });
});

describe('version skew', () => {
  it('makes a follower of another version limited: state passes through, only Cancel and Stop are sent', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState({ epoch: 'epoch-leader' });
    const follower = await rig.join('newer', { version: 2 });
    await waitFor('the follower has a state', () => follower.remote !== undefined);

    expect(follower.role).toBe('follower');
    expect(follower.remote!.limited).toBe(true);
    expect(follower.remote!.state).toEqual(leader.state);
    expect(follower.remote!.leader?.label).toBe('leader');

    const refused = await follower.coordinator.send({ name: 'refresh' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/different versions/);
    expect(await follower.coordinator.send({ name: 'disarm' })).toEqual({ ok: true });
    expect(await follower.coordinator.send({ name: 'cancel', via: 'esc' })).toEqual({ ok: true });

    expect(leader.commands).toEqual([
      { command: { name: 'disarm' }, from: follower.hello },
      { command: { name: 'cancel', via: 'esc' }, from: follower.hello },
    ]);

    leader.coordinator.publish(armedState({ seq: 2 }));
    await waitFor('the limited follower gets states', () => follower.remote?.state?.seq === 2);
    expect(follower.remote!.limited).toBe(true);
  });

  it('as leader: accepts only Cancel and Stop from a window of another version', async () => {
    const leader = await rig.join('leader');
    const older = await rig.rawClient('older', 0);

    older.send({ t: 'cmd', id: '1', cmd: { name: 'refresh' } });
    older.send({ t: 'cmd', id: '2', cmd: { name: 'disarm' } });
    older.send({ t: 'cmd', id: '3', cmd: { name: 'cancel', via: 'button' } });

    await waitFor('three acks', () => older.of('ack').length === 3);
    expect(older.of('ack').map((ack) => ack.ok)).toEqual([false, true, true]);
    expect(String(older.of('ack')[0]!.error)).toMatch(/different versions/);
    expect(leader.commandNames()).toEqual(['disarm', 'cancel']);
    expect(older.of('welcome')[0]!.v).toBe(1);
  });

  it('passes a state from another version through only when it is an object with a phase', async () => {
    const other = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await other.accepted(1);
    const connection = other.latest;
    const foreignState = { phase: 'countdown', armed: true, countdown: { remainingMs: 5000 }, newField: [1] };

    other.welcome(connection, foreignState, 99);
    await waitFor('the follower is welcomed', () => follower.role === 'follower');

    expect(follower.remote).toMatchObject({ limited: true, state: foreignState });
    expect(follower.remote!.leader).toMatchObject({ app: 'Cursor', ext: '9.9.9' });

    other.send(connection, { t: 'state', state: { armed: true } });
    await waitFor('a state without a phase is not shown', () => follower.remote?.state === null);
    expect(follower.remote!.limited).toBe(true);

    other.send(connection, { t: 'state', state: { phase: 'off' } });
    await waitFor('a state with a phase is shown again', () => follower.remote?.state?.phase === 'off');
  });

  it('does not even send anything but Cancel and Stop to a leader of another version', async () => {
    const other = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await other.accepted(1);
    const connection = other.latest;
    other.welcome(connection, { phase: 'watching', armed: true }, 99);
    await waitFor('the follower is welcomed', () => follower.role === 'follower');

    const refused = await follower.coordinator.send({ name: 'refresh' });
    const stop = follower.coordinator.send({ name: 'disarm' });
    await waitFor('the Stop arrived', () => connection.received.some((message) => message.t === 'cmd'));
    const [sent] = connection.received.filter((message) => message.t === 'cmd');
    other.send(connection, { t: 'ack', id: sent!.id, ok: true });

    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/different versions/);
    expect(await stop).toEqual({ ok: true });
    expect(connection.received.filter((message) => message.t === 'cmd')).toEqual([
      { t: 'cmd', id: sent!.id, cmd: { name: 'disarm' } },
    ]);
  });

  it('is welcomed in limited mode even when nothing but the version can be read', async () => {
    const other = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await other.accepted(1);

    const proof = welcomeProofFor('e', other.nonceOf(other.latest));
    other.send(other.latest, { t: 'welcome', v: 99, epoch: 'e', proof, leader: 'who knows', state: 12 });
    await waitFor('the follower is welcomed', () => follower.role === 'follower');

    expect(follower.remote).toMatchObject({ limited: true, state: null, leader: null });
  });

  it('does not follow a same-version leader whose welcome cannot be read', async () => {
    const broken = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await broken.accepted(1);
    const connection = broken.latest;

    broken.welcome(connection, { phase: 'off' });

    await waitFor('the follower hung up', () => connection.closed);
    expect(follower.role).toBe('electing');
    expect(follower.remotes).toEqual([]);
  });
});
