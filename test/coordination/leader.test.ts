import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LINE_BYTES } from '../../src/coordination/framing';
import { LeaderSide } from '../../src/coordination/leader';
import { CONGESTED_BYTES } from '../../src/coordination/timing';
import { readState } from '../../src/coordination/wire';
import { PROTOCOL_VERSION, type Command, type CommandResult, type UiState } from '../../src/shared/protocol';
import { hugeState } from './bigState';
import { FakeServer, FakeSocket } from './fakeSocket';
import { armedState, makeHandover, makeHello, makeState, provenHello, TEST_SECRET, welcomeProofFor } from './harness';

const SELF = makeHello('leader');

interface Scene {
  server: FakeServer;
  leader: LeaderSide;
  commands: Command[];
  logs: string[];
  state: UiState;
  owned: boolean;
  peerChanges: number;
  endpointLost: number;
  /** Makes currentState() throw. */
  stateProblem: string | null;
  respond: (command: Command) => Promise<CommandResult>;
  join(label: string, version?: number): FakeSocket;
}

function lead(): Scene {
  const server = new FakeServer();
  const scene: Scene = {
    server,
    leader: undefined as unknown as LeaderSide,
    commands: [],
    logs: [],
    state: makeState({ epoch: 'epoch-leader' }),
    owned: true,
    peerChanges: 0,
    endpointLost: 0,
    stateProblem: null,
    respond: async () => ({ ok: true }),
    join(label, version = PROTOCOL_VERSION) {
      const socket = server.connect();
      socket.receive(provenHello(makeHello(label), version));
      return socket;
    },
  };
  scene.leader = new LeaderSide({
    server: server.asServer(),
    stillOwned: () => scene.owned,
    self: SELF,
    protocolVersion: PROTOCOL_VERSION,
    secret: TEST_SECRET,
    handlers: {
      handleCommand: (command) => {
        scene.commands.push(command);
        return scene.respond(command);
      },
      currentState: () => {
        if (scene.stateProblem !== null) throw new Error(scene.stateProblem);
        return scene.state;
      },
      beginHandover: () => makeHandover(),
    },
    log: (message) => scene.logs.push(message),
    onPeersChanged: () => (scene.peerChanges += 1),
    onEndpointLost: () => (scene.endpointLost += 1),
  });
  return scene;
}

function seqs(socket: FakeSocket): unknown[] {
  return socket.sentOf('state').map((message) => (message.state as UiState).seq);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('welcome', () => {
  it('sends nothing before the hello, then the welcome with its version, epoch, identity and state', () => {
    const scene = lead();
    const socket = scene.server.connect();
    expect(socket.written).toEqual([]);

    const hello = provenHello(makeHello('a'));
    socket.receive(hello);

    // The leader introduces itself with its hello, minus `remote`, and answers the hello's nonce.
    const { remote: _remote, ...identity } = SELF;
    const proof = welcomeProofFor('epoch-leader', String(hello.nonce));
    expect(socket.sent()).toEqual([
      { t: 'welcome', v: PROTOCOL_VERSION, epoch: 'epoch-leader', leader: identity, state: scene.state, proof },
    ]);
    expect(identity.label).toBe('leader');
    expect(scene.peerChanges).toBe(1);
  });

  it('hangs up on a connection that says no hello within 2 s', () => {
    const scene = lead();
    const socket = scene.server.connect();

    vi.advanceTimersByTime(1999);
    expect(socket.destroyed).toBe(false);
    vi.advanceTimersByTime(1);

    expect(socket.destroyed).toBe(true);
    expect(scene.peerChanges).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hangs up when the controller has no state to give', () => {
    const scene = lead();
    scene.state = undefined as unknown as UiState;

    const socket = scene.join('a');

    expect(socket.destroyed).toBe(true);
    expect(socket.written).toEqual([]);
    expect(scene.leader.peers()).toEqual([]);
  });

  it('hangs up on a window that claims to be the leader itself', () => {
    const scene = lead();
    const socket = scene.server.connect();

    socket.receive(provenHello(SELF));

    expect(socket.destroyed).toBe(true);
    expect(scene.leader.peers()).toEqual([]);
  });

  it('refuses new connections once it is closed', () => {
    const scene = lead();
    scene.leader.close();

    const socket = scene.server.connect();

    expect(socket.destroyed).toBe(true);
  });
});

describe('keeping followers informed', () => {
  it('sends the current state by itself when nothing was published for 10 s', () => {
    const scene = lead();
    const socket = scene.join('a');
    scene.state = makeState({ seq: 2 });

    vi.advanceTimersByTime(9999);
    expect(seqs(socket)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seqs(socket)).toEqual([2]);

    scene.state = makeState({ seq: 3 });
    vi.advanceTimersByTime(10_000);
    expect(seqs(socket)).toEqual([2, 3]);
  });

  it('restarts that clock with every publish', () => {
    const scene = lead();
    const socket = scene.join('a');

    vi.advanceTimersByTime(6000);
    scene.leader.publish(makeState({ seq: 10 }));
    vi.advanceTimersByTime(9999);
    expect(seqs(socket)).toEqual([10]);

    vi.advanceTimersByTime(1);
    expect(seqs(socket)).toEqual([10, 1]);
  });

  it('does not postpone it for the others when a window joins or leaves', () => {
    const scene = lead();
    const first = scene.join('first');
    const leaving = scene.join('leaving');

    vi.advanceTimersByTime(9000);
    scene.join('late');
    leaving.destroy();
    vi.advanceTimersByTime(1000);

    expect(seqs(first)).toEqual([1]);
  });

  it('keeps no timer at all while no follower is connected', () => {
    const scene = lead();
    expect(vi.getTimerCount()).toBe(0);

    const socket = scene.join('a');
    expect(vi.getTimerCount()).toBe(1);
    scene.leader.publish(makeState());
    expect(vi.getTimerCount()).toBe(1);

    socket.destroy();
    expect(vi.getTimerCount()).toBe(0);
    scene.leader.publish(makeState());
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.peerChanges).toBe(2);
  });

  it('keeps trying when the controller cannot produce a state', () => {
    const scene = lead();
    const socket = scene.join('a');

    scene.stateProblem = 'not ready';
    vi.advanceTimersByTime(10_000);
    expect(seqs(socket)).toEqual([]);
    expect(scene.logs.some((line) => line.includes('not ready'))).toBe(true);

    scene.stateProblem = null;
    vi.advanceTimersByTime(10_000);
    expect(seqs(socket)).toEqual([1]);
  });

  it('holds back all but the newest state for a follower that has stopped reading', () => {
    const scene = lead();
    const stalled = scene.join('stalled');
    const healthy = scene.join('healthy');

    stalled.writableLength = CONGESTED_BYTES + 1;
    scene.leader.publish(makeState({ seq: 2 }));
    scene.leader.publish(makeState({ seq: 3 }));
    scene.leader.publish(makeState({ seq: 4 }));
    expect(seqs(stalled)).toEqual([]);
    expect(seqs(healthy)).toEqual([2, 3, 4]);

    stalled.writableLength = 0;
    stalled.emit('drain');
    expect(seqs(stalled)).toEqual([4]);
    stalled.emit('drain');
    expect(seqs(stalled)).toEqual([4]);

    scene.leader.publish(makeState({ seq: 5 }));
    expect(seqs(stalled)).toEqual([4, 5]);
  });

  it('does not send a held-back state after a newer one went out directly', () => {
    const scene = lead();
    const follower = scene.join('a');

    follower.writableLength = CONGESTED_BYTES + 1;
    scene.leader.publish(makeState({ seq: 2 }));
    follower.writableLength = 0;
    scene.leader.publish(makeState({ seq: 3 }));
    follower.emit('drain');

    expect(seqs(follower)).toEqual([3]);
  });
});

describe("a window that cannot prove it is one of this user's windows", () => {
  it.each([
    ['no proof', (label: string) => ({ t: 'hello', v: PROTOCOL_VERSION, ...makeHello(label) })],
    ['a wrong proof', (label: string) => provenHello(makeHello(label), PROTOCOL_VERSION, 'c3'.repeat(32))],
  ])('is hung up on, once, with %s, and nothing it sends is run', async (_case, hello) => {
    const scene = lead();
    const socket = scene.server.connect();

    const disarm = { t: 'cmd', id: '1', cmd: { name: 'disarm' } };
    socket.emit('data', Buffer.from(`${JSON.stringify(hello('stranger'))}\n${JSON.stringify(disarm)}\n`));
    socket.receive({ t: 'cmd', id: '2', cmd: { name: 'refresh' } });
    socket.receive(provenHello(makeHello('stranger')));
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.destroyed).toBe(true);
    expect(socket.written).toEqual([]);
    expect(scene.commands).toEqual([]);
    expect(scene.leader.peers()).toEqual([]);
    expect(scene.peerChanges).toBe(0);
    expect(scene.logs.filter((line) => line.includes('could not prove'))).toHaveLength(1);
  });
});

describe('a state too large for one message', () => {
  it('still reaches every window, trimmed to fit: published, as a keepalive and in a welcome', () => {
    const scene = lead();
    const early = scene.join('early');
    const huge = hugeState({ seq: 2 });

    scene.leader.publish(huge);
    scene.leader.publish({ ...huge, seq: 3 });
    scene.state = { ...huge, seq: 4 };
    vi.advanceTimersByTime(10_000);
    const late = scene.join('late');

    expect(seqs(early)).toEqual([2, 3, 4]);
    expect(late.destroyed).toBe(false);
    const states = [...early.sentOf('state'), ...late.sentOf('welcome')].map((message) => message.state);
    expect(states).toHaveLength(4);
    for (const state of states) {
      const shown = readState(state, false);
      expect(shown).not.toBeNull();
      const { countdown, contract } = huge;
      expect(shown).toMatchObject({ phase: 'countdown', armed: true, countdown, contract });
      expect(shown!.sessions.length + shown!.sessionsOmitted).toBe(300);
    }
    for (const line of [...early.written, ...late.written]) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES + 1);
    }
    expect(scene.logs.filter((line) => line.includes('256 KB'))).toHaveLength(1);
  });

  it('says so again only after it has fitted in between', () => {
    const scene = lead();
    scene.join('a');

    scene.leader.publish(hugeState());
    scene.leader.publish(hugeState());
    scene.leader.publish(makeState());
    scene.leader.publish(hugeState());

    expect(scene.logs.filter((line) => line.includes('256 KB'))).toHaveLength(2);
  });
});

describe('the endpoint', () => {
  it('is owned while the server listens and the transport agrees', () => {
    const scene = lead();

    expect(scene.leader.ownsEndpoint()).toBe(true);
    expect(scene.endpointLost).toBe(0);
  });

  it('is reported lost, once, when the transport says it is no longer ours', async () => {
    const scene = lead();
    const socket = scene.join('a');
    scene.owned = false;

    expect(scene.leader.ownsEndpoint()).toBe(false);
    expect(scene.leader.ownsEndpoint()).toBe(false);
    scene.leader.publish(makeState({ seq: 2 }));
    await Promise.resolve();

    expect(scene.endpointLost).toBe(1);
    expect(seqs(socket)).toEqual([]);
  });

  it('is re-checked on every publish', async () => {
    const scene = lead();
    scene.leader.publish(makeState());
    expect(scene.endpointLost).toBe(0);

    scene.owned = false;
    scene.leader.publish(makeState());
    await Promise.resolve();

    expect(scene.endpointLost).toBe(1);
  });

  it('is reported lost when the server closes or fails underneath the leader', async () => {
    const closed = lead();
    closed.server.close();
    const failed = lead();
    failed.server.emit('error', new Error('EIO'));
    await Promise.resolve();

    expect(closed.endpointLost).toBe(1);
    expect(closed.leader.ownsEndpoint()).toBe(false);
    expect(failed.endpointLost).toBe(1);
    expect(failed.logs.some((line) => line.includes('EIO'))).toBe(true);
  });

  it('is not reported lost when the leader closes it itself', async () => {
    const scene = lead();
    const socket = scene.join('a');

    scene.leader.close();
    await Promise.resolve();

    expect(scene.endpointLost).toBe(0);
    expect(scene.server.listening).toBe(false);
    expect(socket.destroyed).toBe(true);
    expect(scene.leader.ownsEndpoint()).toBe(false);
    expect(scene.leader.peers()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('command bookkeeping', () => {
  it('remembers the last 64 commands, so an older id runs again', async () => {
    const scene = lead();
    const socket = scene.join('a');
    const send = (id: string): void => socket.receive({ t: 'cmd', id, cmd: { name: 'refresh' } });

    send('first');
    send('first');
    for (let n = 0; n < 63; n++) send(`filler-${n}`);
    send('first');
    expect(scene.commands).toHaveLength(64);

    send('one-more');
    send('first');
    expect(scene.commands).toHaveLength(66);

    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sentOf('ack')).toHaveLength(68);
  });

  it('keeps commands with the same id from different windows apart', () => {
    const scene = lead();
    const a = scene.join('a');
    const b = scene.join('b');

    a.receive({ t: 'cmd', id: 'same', cmd: { name: 'refresh' } });
    b.receive({ t: 'cmd', id: 'same', cmd: { name: 'refresh' } });

    expect(scene.commands).toHaveLength(2);
  });

  it('does not answer a window that hung up before the command finished', async () => {
    const scene = lead();
    let finish: (result: CommandResult) => void = () => undefined;
    scene.respond = () => new Promise((resolve) => (finish = resolve));
    const socket = scene.join('a');

    socket.receive({ t: 'cmd', id: '1', cmd: { name: 'refresh' } });
    socket.destroy();
    finish({ ok: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.sentOf('ack')).toEqual([]);
  });
});

describe('leaving', () => {
  it('gives up offering after 800 ms in total, however many followers stay silent', async () => {
    const scene = lead();
    scene.state = armedState();
    const sockets = ['a', 'b', 'c', 'd', 'e'].map((label) => scene.join(label));

    const leaving = scene.leader.leave();
    await vi.advanceTimersByTimeAsync(1000);

    expect(await leaving).toEqual({ handedOver: false });
    expect(sockets.map((socket) => socket.sentOf('handover').length)).toEqual([1, 1, 1, 0, 0]);
    for (const socket of sockets) {
      expect(socket.sentOf('leaving')).toEqual([{ t: 'leaving', successor: null }]);
      expect(socket.destroyed).toBe(true);
    }
    expect(scene.server.listening).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves to the next follower at once when the one it asked hangs up', async () => {
    const scene = lead();
    const first = scene.join('first');
    const second = scene.join('second');

    const leaving = scene.leader.leave();
    await vi.advanceTimersByTimeAsync(0);
    first.destroy();
    await vi.advanceTimersByTimeAsync(0);
    second.receive({ t: 'handoverAck', ok: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(await leaving).toEqual({ handedOver: true });
    expect(second.sentOf('leaving')).toHaveLength(1);
  });

  it('ignores a late or unasked "yes"', async () => {
    const scene = lead();
    const first = scene.join('first');
    const second = scene.join('second');

    const leaving = scene.leader.leave();
    second.receive({ t: 'handoverAck', ok: true });
    await vi.advanceTimersByTimeAsync(300);
    first.receive({ t: 'handoverAck', ok: true });
    await vi.advanceTimersByTimeAsync(1000);

    expect(await leaving).toEqual({ handedOver: false });
  });

  it('stops the keepalive and refuses its own commands once it has begun', async () => {
    const scene = lead();
    const socket = scene.join('a');

    const leaving = scene.leader.leave();
    const answer = await scene.leader.runLocal({ name: 'refresh' });
    await vi.advanceTimersByTimeAsync(20_000);
    await leaving;

    expect(answer).toEqual({ ok: false, error: 'This window is closing.' });
    expect(seqs(socket)).toEqual([]);
    expect(scene.commands).toEqual([]);
  });
});
