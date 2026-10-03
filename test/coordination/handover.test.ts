import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { armedState, makeHandover, makeState, Rig, sleep, waitFor, type TestWindow } from './harness';

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.dispose();
});

describe('a watching leader that closes gracefully', () => {
  it('hands its armed state to the oldest follower, which becomes the next leader with it', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState({ epoch: 'epoch-leader' });
    leader.handover = makeHandover();
    const oldest = await rig.join('oldest');
    const younger = await rig.join('younger');
    await waitFor('both followers show the armed state', () =>
      [oldest, younger].every((window) => window.remote?.state?.armed === true),
    );
    const startedAt = performance.now();

    const result = await leader.coordinator.dispose();

    expect(result).toEqual({ handedOver: true });
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(leader.handoverCalls).toBe(1);

    await waitFor('the oldest follower leads', () => oldest.role === 'leader');
    expect(oldest.lastRole).toEqual({ role: 'leader', handover: makeHandover(), previousLeaderWasWatching: false });

    await waitFor('the younger follower follows the new leader', () => younger.remote?.state?.epoch === 'epoch-oldest');
    expect(younger.role).toBe('follower');
    expect(younger.roles.map((change) => change.role)).toEqual(['follower', 'electing', 'follower']);
    // Between the two leaders it showed nothing, never the old leader's state.
    const shown = younger.remotes.map((remote) => remote.state?.epoch ?? null);
    expect(shown).toEqual(['epoch-leader', null, 'epoch-oldest']);
  });

  it('gives the named successor a head start over every other window', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();
    const successor = await rig.join('successor');
    const others = [await rig.join('b'), await rig.join('c'), await rig.join('d')];

    await leader.coordinator.dispose();
    const closedAt = performance.now();
    await waitFor('the others follow again', () => others.every((window) => window.roles.length === 3));

    expect(successor.role).toBe('leader');
    expect(successor.lastRole?.handover).toEqual(makeHandover());
    expect(others.map((window) => window.role)).toEqual(['follower', 'follower', 'follower']);
    expect(performance.now() - closedAt).toBeGreaterThan(450);
  });

  it('reports no handover when there is no other window', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();

    expect(await leader.coordinator.dispose()).toEqual({ handedOver: false });

    expect(leader.handoverCalls).toBe(1);
    expect(leader.logs.some((line) => line.startsWith('armed-dropped'))).toBe(true);
  });

  it('reports no handover when it was not watching, and its successor starts off', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');
    await waitFor('the follower shows the state', () => follower.remote?.state?.armed === false);

    expect(await leader.coordinator.dispose()).toEqual({ handedOver: false });

    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: false });
    expect(leader.logs.some((line) => line.startsWith('armed-dropped'))).toBe(false);
  });

  it('tells its successor loudly when nobody could take the armed state', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();
    // Another protocol version is never offered the armed state.
    const other = await rig.join('other-version', { version: 2 });
    await waitFor('the follower shows the armed state', () => other.remote?.state?.armed === true);

    expect(await leader.coordinator.dispose()).toEqual({ handedOver: false });

    await waitFor('the other window leads', () => other.role === 'leader');
    expect(other.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
  });

  it('skips a follower that has an unconfirmed Stop and hands over to the next one', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();
    leader.respond = () => new Promise(() => undefined); // this leader never confirms anything
    const stopping = await rig.join('stopping');
    const next = await rig.join('next');
    const stop = stopping.coordinator.send({ name: 'disarm' });
    await waitFor('the leader got the Stop', () => leader.commandNames().includes('disarm'));

    expect(await leader.coordinator.dispose()).toEqual({ handedOver: true });

    await waitFor('the next window leads', () => next.role === 'leader');
    expect(next.lastRole?.handover).toEqual(makeHandover());
    // The Stop follows the armed state to its new owner.
    expect(await stop).toEqual({ ok: true });
    expect(next.commands).toEqual([{ command: { name: 'disarm' }, from: stopping.hello }]);
  });

  it('answers its own commands with a refusal once it is closing', async () => {
    const leader = await rig.join('leader');
    await rig.join('follower');

    const closing = leader.coordinator.dispose();
    expect(leader.coordinator.stillOwnsEndpoint()).toBe(false);
    const answer = await leader.coordinator.send({ name: 'refresh' });
    const stop = await leader.coordinator.send({ name: 'disarm' });

    expect(answer).toEqual({ ok: false, error: 'This window is closing.' });
    expect(stop).toEqual({ ok: false, error: 'This window is closing.' });
    // The Stop could not be honoured, so it is reported: the caller sets Emergency stop.
    expect(leader.stuck).toEqual([{ name: 'disarm' }]);
    expect(leader.commands).toEqual([]);
    expect(await closing).toEqual({ handedOver: false });
    expect(await leader.coordinator.dispose()).toEqual({ handedOver: false });
  });

  it('stops running and answering commands the moment the handover begins', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();
    const client = await rig.rawClient('raw');
    client.send({ t: 'cmd', id: 'before', cmd: { name: 'refresh' } });
    await waitFor('the first command is answered', () => client.of('ack').length === 1);

    const closing = leader.coordinator.dispose();
    await waitFor('the handover is offered', () => client.of('handover').length === 1);
    client.send({ t: 'cmd', id: 'during-1', cmd: { name: 'disarm' } });
    client.send({ t: 'cmd', id: 'during-2', cmd: { name: 'refresh' } });
    await sleep(100);
    client.send({ t: 'handoverAck', ok: true });

    expect(await closing).toEqual({ handedOver: true });
    await waitFor('the leader hung up', () => client.closed);
    expect(leader.commandNames()).toEqual(['refresh']);
    expect(client.of('ack').map((ack) => ack.id)).toEqual(['before']);
    expect(client.of('leaving')).toHaveLength(1);
    expect(client.of('handover')[0]!.payload).toEqual(makeHandover());
  });

  it('moves on after 300 ms when a follower does not answer the offer', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();
    const silent = await rig.rawClient('silent');
    const willing = await rig.join('willing');
    const startedAt = performance.now();

    expect(await leader.coordinator.dispose()).toEqual({ handedOver: true });

    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThan(280);
    expect(elapsed).toBeLessThan(1000);
    await waitFor('the leader hung up on the silent window', () => silent.closed);
    expect(silent.of('leaving')).toEqual([{ t: 'leaving', successor: willing.hello.windowId }]);
    await waitFor('the willing window leads', () => willing.role === 'leader');
    expect(willing.lastRole?.handover).toEqual(makeHandover());
  });

  it('takes a refusal for an answer and names nobody', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState();
    leader.handover = makeHandover();
    const client = await rig.rawClient('raw');

    const closing = leader.coordinator.dispose();
    await waitFor('the handover is offered', () => client.of('handover').length === 1);
    client.send({ t: 'handoverAck', ok: false });

    expect(await closing).toEqual({ handedOver: false });
    await waitFor('the leader hung up', () => client.closed);
    expect(client.of('leaving')).toEqual([{ t: 'leaving', successor: null }]);
  });
});

describe('a follower that accepted a handover', () => {
  async function followerHoldingHandover() {
    const closing = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await closing.accepted(1);
    const connection = closing.latest;
    closing.welcome(connection, armedState({ epoch: 'epoch-closing' }));
    await waitFor('the follower is welcomed', () => follower.role === 'follower');
    closing.send(connection, { t: 'handover', payload: makeHandover() });
    await waitFor('the follower answered the offer', () => connection.received.some((m) => m.t === 'handoverAck'));
    expect(connection.received.filter((m) => m.t === 'handoverAck')).toEqual([{ t: 'handoverAck', ok: true }]);
    return { closing, connection, follower };
  }

  it('uses it when it wins the next election', async () => {
    const { closing, connection, follower } = await followerHoldingHandover();

    closing.send(connection, { t: 'leaving', successor: follower.hello.windowId });
    closing.close();

    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(follower.lastRole).toEqual({ role: 'leader', handover: makeHandover(), previousLeaderWasWatching: false });
  });

  it('discards it when another window wins the election, and never brings it back', async () => {
    const { closing, connection, follower } = await followerHoldingHandover();

    // The old leader's connection drops, but the endpoint is held by somebody else by the time the
    // follower gets there: it is welcomed by a "new" leader that is not watching.
    connection.socket.destroy();
    await closing.accepted(2);
    const winner = closing.latest;
    closing.welcome(winner, makeState({ epoch: 'epoch-winner' }));
    await waitFor('the follower follows the winner', () => follower.remote?.state?.epoch === 'epoch-winner');
    expect(follower.roles.map((change) => change.role)).toEqual(['follower', 'electing', 'follower']);
    expect(follower.logs.some((line) => line.includes('another window became the leader'))).toBe(true);

    closing.close();
    await waitFor('the follower leads', () => follower.role === 'leader');

    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: false });
  });

  it('discards it when the leader names another successor, and lets that one go first', async () => {
    const { closing, connection, follower } = await followerHoldingHandover();

    closing.send(connection, { t: 'leaving', successor: 'window-somebody-else' });
    await sleep(30);
    closing.close();
    const closedAt = performance.now();

    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(performance.now() - closedAt).toBeGreaterThan(450);
    // The armed state is gone - and that is said loudly, because the last leader was watching.
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
  });

  it('discards it when the leader says goodbye without naming anybody', async () => {
    const { closing, connection, follower } = await followerHoldingHandover();

    closing.send(connection, { t: 'leaving', successor: null });
    await sleep(30);
    closing.close();

    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
  });

  it('discards it after 3 s when the old leader still has not let go', async () => {
    const { closing, follower } = await followerHoldingHandover();

    await sleep(3100);
    closing.close();

    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
    expect(follower.logs.some((line) => line.includes('did not release control in time'))).toBe(true);
  });

  it('drops it when the user presses Stop in that window before it leads, and runs the Stop itself', async () => {
    const { closing, connection, follower } = await followerHoldingHandover();

    const stop = follower.coordinator.send({ name: 'disarm' });
    await waitFor('the Stop was sent to the closing leader', () => connection.received.some((m) => m.t === 'cmd'));
    closing.send(connection, { t: 'leaving', successor: follower.hello.windowId });
    closing.close();

    await waitFor('the follower leads', () => follower.role === 'leader');
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
    expect(await stop).toEqual({ ok: true });
    expect(follower.commands).toEqual([{ command: { name: 'disarm' }, from: follower.hello }]);
  });
});

describe('a follower that is offered a handover', () => {
  async function offer(payload: unknown, prepare: (follower: TestWindow) => void = () => undefined) {
    const closing = await rig.rawLeader();
    const follower = rig.window('follower').start();
    await closing.accepted(1);
    const connection = closing.latest;
    closing.welcome(connection, armedState());
    await waitFor('the follower is welcomed', () => follower.role === 'follower');
    prepare(follower);
    closing.send(connection, { t: 'handover', payload });
    await waitFor('the follower answered the offer', () => connection.received.some((m) => m.t === 'handoverAck'));
    const [answer] = connection.received.filter((m) => m.t === 'handoverAck');
    closing.send(connection, { t: 'leaving', successor: follower.hello.windowId });
    closing.close();
    await waitFor('the follower leads', () => follower.role === 'leader');
    return { answer, follower };
  }

  it('refuses a payload it cannot fully read, and then starts off', async () => {
    const { answer, follower } = await offer({ ...makeHandover(), contract: { action: 'shutdown' } });

    expect(answer).toEqual({ t: 'handoverAck', ok: false });
    expect(follower.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });
  });

  it('refuses while a Stop from this window is unconfirmed', async () => {
    const { answer, follower } = await offer(makeHandover(), (window) => {
      void window.coordinator.send({ name: 'disarm' });
    });

    expect(answer).toEqual({ t: 'handoverAck', ok: false });
    expect(follower.lastRole?.handover).toBeNull();
    expect(follower.commandNames()).toEqual(['disarm']);
  });
});
