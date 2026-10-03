import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteState } from '../../src/coordination/coordinator';
import { FollowerLink } from '../../src/coordination/follower';
import { PROTOCOL_VERSION, type CommandResult, type HandoverPayload, type UiState } from '../../src/shared/protocol';
import { FakeSocket } from './fakeSocket';
import {
  armedState,
  CONTRACT,
  helloProofFor,
  makeHandover,
  makeHello,
  makeState,
  TEST_SECRET,
  welcomeProofFor,
} from './harness';

const LEADER = { windowId: 'window-leader', label: 'main', app: 'Cursor', ext: '0.1.0', pid: 77, realm: 'realm-a' };

const ME = makeHello('me');

interface Scene {
  socket: FakeSocket;
  link: FollowerLink;
  remotes: RemoteState[];
  events: string[];
  answers: { id: string; result: CommandResult }[];
  offers: HandoverPayload[];
  logs: string[];
  acceptHandover: boolean;
}

function connect(version = PROTOCOL_VERSION): Scene {
  const scene: Scene = {
    socket: new FakeSocket(),
    link: undefined as unknown as FollowerLink,
    remotes: [],
    events: [],
    answers: [],
    offers: [],
    logs: [],
    acceptHandover: true,
  };
  scene.link = new FollowerLink({
    socket: scene.socket.asSocket(),
    self: ME,
    protocolVersion: version,
    secret: TEST_SECRET,
    log: (message) => scene.logs.push(message),
    events: {
      welcomed: () => scene.events.push('welcomed'),
      remoteChanged: (remote) => scene.remotes.push(remote),
      handoverOffered: (payload) => {
        scene.offers.push(payload);
        return scene.acceptHandover;
      },
      leaderLeaving: (successor) => scene.events.push(`leaving:${successor}`),
      answered: (id, result) => scene.answers.push({ id, result }),
      closed: () => scene.events.push('closed'),
    },
  });
  return scene;
}

/** The nonce this window sent with its hello. */
function nonceOf(scene: Scene): string {
  return String(scene.socket.sentOf('hello')[0]!.nonce);
}

/** A welcome from a genuine leader: it answers the hello's nonce with the shared secret. */
function welcomeFor(scene: Scene, state: unknown, epoch: string, version = PROTOCOL_VERSION): Record<string, unknown> {
  return { t: 'welcome', v: version, epoch, leader: LEADER, state, proof: welcomeProofFor(epoch, nonceOf(scene)) };
}

function welcomed(state: UiState = makeState(), version = PROTOCOL_VERSION): Scene {
  const scene = connect(version);
  scene.socket.receive(welcomeFor(scene, state, state.epoch));
  return scene;
}

function withPoll(pollSeconds: number): UiState {
  return armedState({ contract: { ...CONTRACT, pollSeconds } });
}

function shown(scene: Scene): (UiState | null)[] {
  return scene.remotes.map((remote) => remote.state);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hello and welcome', () => {
  it('says hello first, with its version, identity, a fresh nonce and the proof for both', () => {
    const { socket } = connect();
    const [hello] = socket.sent();
    const nonce = String(hello!.nonce);

    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(hello).toEqual({ t: 'hello', v: PROTOCOL_VERSION, ...ME, nonce, proof: helloProofFor(ME.windowId, nonce) });
    expect(hello!.remote).toBeNull();
    expect(nonceOf(connect())).not.toBe(nonce);
  });

  it('becomes a follower on the welcome and shows its state', () => {
    const scene = welcomed(armedState());

    expect(scene.events).toEqual(['welcomed']);
    expect(scene.link.welcomed).toBe(true);
    expect(scene.link.limited).toBe(false);
    expect(scene.link.leaderWasArmed).toBe(true);
    expect(scene.remotes).toEqual([
      { state: armedState(), leader: LEADER, limited: false, receivedAtMono: expect.any(Number) },
    ]);
  });

  it('hangs up when no welcome arrives within 2 s', () => {
    const scene = connect();

    vi.advanceTimersByTime(1999);
    expect(scene.socket.destroyed).toBe(false);
    vi.advanceTimersByTime(1);

    expect(scene.socket.destroyed).toBe(true);
    expect(scene.events).toEqual(['closed']);
    expect(scene.link.welcomed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores everything before the welcome', () => {
    const scene = connect();

    scene.socket.receive({ t: 'state', state: armedState() });
    scene.socket.receive({ t: 'handover', payload: makeHandover() });
    scene.socket.receive({ t: 'leaving', successor: null });

    expect(scene.remotes).toEqual([]);
    expect(scene.offers).toEqual([]);
    expect(scene.events).toEqual([]);
    expect(scene.link.namedSuccessor).toBeUndefined();
  });

  it('keeps the first welcome when the leader sends another', () => {
    const scene = welcomed(makeState({ seq: 1 }));

    scene.socket.receive(welcomeFor(scene, makeState({ seq: 2 }), 'x', 99));

    expect(scene.events).toEqual(['welcomed']);
    expect(scene.link.limited).toBe(false);
    expect(shown(scene).map((state) => state?.seq)).toEqual([1]);
  });
});

describe('a leader that cannot prove it is genuine', () => {
  const STRANGER = 'd4'.repeat(32);
  const genuine = (scene: Scene): Record<string, unknown> => welcomeFor(scene, armedState(), 'e');

  type Welcome = (scene: Scene) => Record<string, unknown>;

  it.each<[string, Welcome]>([
    ['no proof', (scene) => ({ ...genuine(scene), proof: undefined })],
    ["a stranger's proof", (scene) => ({ ...genuine(scene), proof: welcomeProofFor('e', nonceOf(scene), STRANGER) })],
    ['a proof made for another hello', (scene) => ({ ...genuine(scene), proof: welcomeProofFor('e', 'f'.repeat(32)) })],
    ['a proof made for another epoch', (scene) => ({ ...genuine(scene), epoch: 'other' })],
    ['no epoch', (scene) => ({ ...genuine(scene), epoch: undefined })],
    ['another version and no proof', () => ({ t: 'welcome', v: 99, leader: LEADER, state: { phase: 'off' } })],
  ])('is not followed with %s, and nothing it sends is believed', (_case, welcome) => {
    const scene = connect();
    const after = [
      { t: 'state', state: armedState() },
      { t: 'handover', payload: makeHandover() },
      { t: 'ack', id: 'x', ok: true },
      { t: 'leaving', successor: ME.windowId },
    ];

    const packet = [welcome(scene), ...after].map((frame) => `${JSON.stringify(frame)}\n`).join('');
    scene.socket.emit('data', Buffer.from(packet));
    for (const frame of after) scene.socket.receive(frame);

    expect(scene.socket.destroyed).toBe(true);
    expect(scene.link.welcomed).toBe(false);
    expect(scene.link.distrusted).toMatch(/could not prove/);
    expect(scene.events).toEqual(['closed']);
    expect(scene.remotes).toEqual([]);
    expect(scene.offers).toEqual([]);
    expect(scene.answers).toEqual([]);
    expect(scene.socket.sentOf('handoverAck')).toEqual([]);
    expect(scene.link.namedSuccessor).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is followed with the proof for this very hello', () => {
    const scene = welcomed(armedState());

    expect(scene.link.welcomed).toBe(true);
    expect(scene.link.distrusted).toBeNull();
  });
});

describe('a leader that goes quiet', () => {
  it('is no longer shown after 15 s when it was watching with a 5 s poll', () => {
    const scene = welcomed(withPoll(5));

    vi.advanceTimersByTime(14_999);
    expect(shown(scene)).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(shown(scene)).toEqual([withPoll(5), null]);
    expect(scene.remotes[1]).toMatchObject({ leader: LEADER, limited: false });
    expect(scene.socket.destroyed).toBe(false);
    expect(scene.link.leaderWasArmed).toBe(true);
    expect(scene.logs.some((line) => line.includes('"main"') && line.includes('stopped sending updates'))).toBe(true);
  });

  it.each([
    [5, 15_000],
    [7, 21_000],
    [10, 30_000],
    [60, 30_000],
  ])('while watching with a %i s poll, waits %i ms', (pollSeconds, limitMs) => {
    const scene = welcomed(withPoll(pollSeconds));

    vi.advanceTimersByTime(limitMs - 1);
    expect(shown(scene)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shown(scene)[1]).toBeNull();
  });

  it('waits 30 s when it was not watching', () => {
    const scene = welcomed(makeState());

    vi.advanceTimersByTime(29_999);
    expect(shown(scene)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shown(scene)[1]).toBeNull();
  });

  it('waits the minimum of 15 s when it was watching and its poll interval cannot be read', () => {
    const scene = welcomed(armedState({ contract: { ...CONTRACT, pollSeconds: NaN } }));

    vi.advanceTimersByTime(15_000);

    expect(shown(scene)[1]).toBeNull();
  });

  it('counts any message as a sign of life, even one this version does not know', () => {
    const scene = welcomed(withPoll(5));

    vi.advanceTimersByTime(10_000);
    scene.socket.receive({ t: 'somethingNew' });
    vi.advanceTimersByTime(10_000);
    scene.socket.receive({ t: 'ack', id: 'unknown', ok: true });
    vi.advanceTimersByTime(14_999);
    expect(shown(scene)).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(shown(scene)[1]).toBeNull();
  });

  it('is shown again as soon as it sends a state, and says nothing twice', () => {
    const scene = welcomed(withPoll(5));

    vi.advanceTimersByTime(60_000);
    expect(shown(scene)).toEqual([withPoll(5), null]);

    scene.socket.receive({ t: 'state', state: makeState({ seq: 9 }) });
    expect(shown(scene)[2]).toEqual(makeState({ seq: 9 }));
    expect(scene.link.leaderWasArmed).toBe(false);
  });
});

describe('states', () => {
  it('stamps each state with the monotonic time it arrived', () => {
    const scene = welcomed();
    const first = scene.remotes[0]!.receivedAtMono;

    vi.advanceTimersByTime(1234);
    scene.socket.receive({ t: 'state', state: makeState({ seq: 2 }) });

    expect(scene.remotes[1]!.receivedAtMono - first).toBeCloseTo(1234, 0);
  });

  it("shows nothing when a state can't be read, once", () => {
    const scene = welcomed(armedState());

    scene.socket.receive({ t: 'state', state: { phase: 'watching' } });
    scene.socket.receive({ t: 'state', state: 'nonsense' });
    scene.socket.receive({ t: 'state' });

    expect(shown(scene)).toEqual([armedState(), null]);
    expect(scene.link.leaderWasArmed).toBe(true);
  });
});

describe('commands', () => {
  it('resolves a request with the ack that carries its id', async () => {
    const scene = welcomed();

    const answer = scene.link.request({ name: 'refresh' });
    const [sent] = scene.socket.sentOf('cmd');
    expect(sent).toEqual({ t: 'cmd', id: expect.any(String), cmd: { name: 'refresh' } });
    scene.socket.receive({ t: 'ack', id: sent!.id, ok: false, error: 'Busy.' });

    expect(await answer).toEqual({ ok: false, error: 'Busy.' });
    expect(scene.answers).toEqual([]);
  });

  it('gives up on a request after 20 s without an answer', async () => {
    const scene = welcomed();

    const answer = scene.link.request({ name: 'refresh' });
    vi.advanceTimersByTime(20_000);

    expect(await answer).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
    expect(scene.socket.sentOf('cmd')).toHaveLength(1);
  });

  it('fails every open request when the connection closes, and does not send them again', async () => {
    const scene = welcomed();
    const arm = scene.link.request({ name: 'preview' });
    const refresh = scene.link.request({ name: 'refresh' });

    scene.socket.destroy();

    expect(await arm).toMatchObject({ ok: false, error: expect.stringContaining('closed before it answered') });
    expect(await refresh).toMatchObject({ ok: false });
    expect(scene.events).toEqual(['welcomed', 'closed']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes on acks for commands it did not issue itself', () => {
    const scene = welcomed();

    scene.link.sendCommand('safe-1', { name: 'disarm' });
    scene.socket.receive({ t: 'ack', id: 'safe-1', ok: true });
    scene.socket.receive({ t: 'ack', id: 'safe-1', ok: 'yes' });

    expect(scene.socket.sentOf('cmd')).toEqual([{ t: 'cmd', id: 'safe-1', cmd: { name: 'disarm' } }]);
    expect(scene.answers).toEqual([{ id: 'safe-1', result: { ok: true } }]);
  });

  it('reports its dashboard visibility', () => {
    const scene = welcomed();

    scene.link.sendView(true);

    expect(scene.socket.sentOf('view')).toEqual([{ t: 'view', visible: true }]);
  });
});

describe('handover and goodbye', () => {
  it('answers an offer with what the window decided', () => {
    const scene = welcomed(armedState());

    scene.socket.receive({ t: 'handover', payload: makeHandover() });
    scene.acceptHandover = false;
    scene.socket.receive({ t: 'handover', payload: makeHandover() });

    expect(scene.offers).toEqual([makeHandover(), makeHandover()]);
    expect(scene.socket.sentOf('handoverAck')).toEqual([
      { t: 'handoverAck', ok: true },
      { t: 'handoverAck', ok: false },
    ]);
  });

  it('refuses an offer it cannot read without asking the window', () => {
    const scene = welcomed(armedState());

    scene.socket.receive({ t: 'handover', payload: { ...makeHandover(), armedAtMs: 'yesterday' } });
    scene.socket.receive({ t: 'handover' });

    expect(scene.offers).toEqual([]);
    expect(scene.socket.sentOf('handoverAck')).toEqual([
      { t: 'handoverAck', ok: false },
      { t: 'handoverAck', ok: false },
    ]);
  });

  it('refuses every offer from a leader of another version', () => {
    const scene = welcomed(armedState(), PROTOCOL_VERSION + 1);

    scene.socket.receive({ t: 'handover', payload: makeHandover() });

    expect(scene.link.limited).toBe(true);
    expect(scene.offers).toEqual([]);
    expect(scene.socket.sentOf('handoverAck')).toEqual([{ t: 'handoverAck', ok: false }]);
  });

  it('remembers who the leader named in its goodbye', () => {
    const named = welcomed();
    const nobody = welcomed();
    const silent = welcomed();

    named.socket.receive({ t: 'leaving', successor: 'window-next' });
    nobody.socket.receive({ t: 'leaving', successor: 42 });

    expect(named.link.namedSuccessor).toBe('window-next');
    expect(named.events).toEqual(['welcomed', 'leaving:window-next']);
    expect(nobody.link.namedSuccessor).toBeNull();
    expect(silent.link.namedSuccessor).toBeUndefined();
  });
});

describe('close()', () => {
  it('drops the connection, clears every timer and raises nothing more', async () => {
    const scene = welcomed(armedState());
    const open = scene.link.request({ name: 'refresh' });

    scene.link.close();
    scene.link.close();
    scene.socket.receive({ t: 'state', state: makeState({ seq: 5 }) });
    vi.advanceTimersByTime(60_000);

    expect(scene.socket.destroyed).toBe(true);
    expect(await open).toMatchObject({ ok: false });
    expect(scene.events).toEqual(['welcomed']);
    expect(shown(scene)).toEqual([armedState()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hangs up on a leader that breaks the framing', () => {
    const scene = welcomed();

    scene.socket.emit('data', Buffer.from('not json\n'));

    expect(scene.socket.destroyed).toBe(true);
    expect(scene.events).toEqual(['welcomed', 'closed']);
  });
});
