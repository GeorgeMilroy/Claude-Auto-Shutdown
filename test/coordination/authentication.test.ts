// Another account on the same machine can work out the endpoint name. These tests play that
// stranger on both ends of the connection: it must never be welcomed as a window, never be
// followed as the leader, and never hand this user's window an armed state.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Claim, EndpointClaimer } from '../../src/coordination/endpoint';
import { contractDigest } from '../../src/shared/config';
import { PROTOCOL_VERSION } from '../../src/shared/protocol';
import {
  armedState,
  CONTRACT,
  CrashableClaimer,
  helloProofFor,
  makeHandover,
  makeHello,
  provenHello,
  Rig,
  sleep,
  waitFor,
  welcomeProofFor,
  type RawClient,
  type RawConnection,
  type RawLeader,
  type TestWindow,
} from './harness';

const STRANGER_SECRET = 'b2'.repeat(32);

const ARM = { name: 'arm', contract: CONTRACT, digest: contractDigest(CONTRACT), epoch: 'epoch-x', realm: 'realm-a' };

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.dispose();
});

describe('a window that connects to the leader', () => {
  async function stranger(hello: Record<string, unknown>): Promise<{ leader: TestWindow; client: RawClient }> {
    const leader = await rig.join('leader');
    const client = await rig.rawConnection();
    // The hello and an arm in one packet, then more commands once the hello has been judged.
    client.sendRaw(`${JSON.stringify(hello)}\n${JSON.stringify({ t: 'cmd', id: '1', cmd: ARM })}\n`);
    client.send({ t: 'cmd', id: '2', cmd: { name: 'disarm' } });
    await waitFor('the stranger is cut off', () => client.closed);
    await sleep(50);
    return { leader, client };
  }

  function expectRefused({ leader, client }: { leader: TestWindow; client: RawClient }): void {
    expect(client.received).toEqual([]);
    expect(leader.commands).toEqual([]);
    expect(leader.coordinator.peers()).toEqual([]);
    expect(leader.logs.filter((line) => line.includes('could not prove'))).toHaveLength(1);
  }

  it('is cut off when its hello carries no proof, and its arm never reaches the controller', async () => {
    expectRefused(await stranger({ t: 'hello', v: PROTOCOL_VERSION, ...makeHello('stranger') }));
  });

  it("is cut off when its proof was made with another user's secret", async () => {
    expectRefused(await stranger(provenHello(makeHello('stranger'), PROTOCOL_VERSION, STRANGER_SECRET)));
  });

  it("is cut off when it replays a genuine window's proof under another window id", async () => {
    const genuine = provenHello(makeHello('genuine'));
    const { windowId } = makeHello('stranger');

    expectRefused(await stranger({ ...genuine, windowId }));
  });

  it('is cut off when its nonce is not a fresh 32-hex challenge', async () => {
    const hello = makeHello('stranger');
    const nonce = 'not-a-nonce';

    expectRefused(await stranger({ t: 'hello', v: 1, ...hello, nonce, proof: helloProofFor(hello.windowId, nonce) }));
  });

  it("is welcomed, from any version, when it proves it knows this user's secret", async () => {
    const leader = await rig.join('leader');
    const client = await rig.rawConnection();
    const hello = provenHello(makeHello('genuine'), PROTOCOL_VERSION + 1);

    client.send(hello);
    await waitFor('the window is welcomed', () => client.of('welcome').length === 1);
    client.send({ t: 'cmd', id: '1', cmd: { name: 'disarm' } });
    await waitFor('its Stop is answered', () => client.of('ack').length === 1);

    const [welcome] = client.of('welcome');
    expect(welcome!.proof).toBe(welcomeProofFor(leader.state.epoch, String(hello.nonce)));
    expect(leader.commandNames()).toEqual(['disarm']);
  });
});

/** Claims the endpoint for real and counts the election rounds. */
class CountingClaimer implements EndpointClaimer {
  attempts = 0;
  private readonly inner: EndpointClaimer;

  constructor(endpoint: string) {
    this.inner = new CrashableClaimer(endpoint);
  }

  attempt(signal: AbortSignal): Promise<Claim> {
    this.attempts += 1;
    return this.inner.attempt(signal);
  }
}

describe('a window that finds the endpoint held by a stranger', () => {
  let claimer: CountingClaimer;

  async function strangerLeads(): Promise<{ fake: RawLeader; connection: RawConnection; window: TestWindow }> {
    const fake = await rig.rawLeader();
    claimer = new CountingClaimer(rig.endpoint);
    const window = rig.window('victim', { claimer }).start();
    await fake.accepted(1);
    return { fake, connection: fake.latest, window };
  }

  /** The attack from the review: welcome, offer a real watch, name the victim as successor, leave. */
  function attack(fake: RawLeader, connection: RawConnection, welcome: () => void): void {
    welcome();
    const payload = makeHandover({ contract: { ...CONTRACT, testMode: false, forceCloseApps: true } });
    fake.send(connection, { t: 'state', state: armedState() });
    fake.send(connection, { t: 'handover', payload });
    fake.send(connection, { t: 'ack', id: 'anything', ok: true });
  }

  async function expectNeverTrusted(window: TestWindow, connection: RawConnection): Promise<void> {
    await waitFor('the victim hung up', () => connection.closed);
    await waitFor('the victim is isolated', () => window.role === 'isolated');
    await sleep(50);
    expect(window.roles).toEqual([{ role: 'isolated', handover: null, previousLeaderWasWatching: false }]);
    expect(window.remotes).toEqual([]);
    expect(connection.received.filter((message) => message.t === 'handoverAck')).toEqual([]);
    // At once, after the first round: the name is taken, so there is no point in trying again soon.
    expect(claimer.attempts).toBe(1);
    const reason =
      'This window can neither reach a leader nor become one: the window holding the endpoint is not trusted';
    expect(window.logs.filter((line) => line.startsWith(reason) && line.includes('could not prove'))).toHaveLength(1);
    // Watching is off in this window: the reason must be visible at the default log level.
    expect(window.warnings.filter((line) => line.startsWith(reason))).toHaveLength(1);
  }

  it('does not follow it when its welcome carries no proof', async () => {
    const { fake, connection, window } = await strangerLeads();

    attack(fake, connection, () => fake.welcome(connection, armedState(), PROTOCOL_VERSION, null));

    await expectNeverTrusted(window, connection);
  });

  it("does not follow it when its proof was made with another user's secret", async () => {
    const { fake, connection, window } = await strangerLeads();

    const proof = { secret: STRANGER_SECRET };

    attack(fake, connection, () => fake.welcome(connection, armedState(), PROTOCOL_VERSION, proof));

    await expectNeverTrusted(window, connection);
  });

  it('does not follow it when it replays a proof made for another hello', async () => {
    const { fake, connection, window } = await strangerLeads();
    const replayed = welcomeProofFor('epoch-raw', 'f'.repeat(32));

    const welcome = { t: 'welcome', v: 1, epoch: 'epoch-raw', leader: {}, state: armedState(), proof: replayed };

    attack(fake, connection, () => fake.send(connection, welcome));

    await expectNeverTrusted(window, connection);
  });

  it('does not follow it from another version either', async () => {
    const { fake, connection, window } = await strangerLeads();

    attack(fake, connection, () => fake.welcome(connection, { phase: 'countdown' }, 99, null));

    await expectNeverTrusted(window, connection);
  });

  it('never takes the armed state it offered, and leads without it once the stranger is gone', async () => {
    const { fake, connection, window } = await strangerLeads();
    attack(fake, connection, () => fake.welcome(connection, armedState(), PROTOCOL_VERSION, null));
    fake.send(connection, { t: 'leaving', successor: window.hello.windowId });
    await expectNeverTrusted(window, connection);

    fake.close();

    const goneAt = performance.now();
    await waitFor('the victim leads', () => window.role === 'leader', 8000);
    expect(window.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: false });
    // The usual schedule of an isolated window: the next round 5 s after the first.
    expect(claimer.attempts).toBe(2);
    expect(performance.now() - goneAt).toBeGreaterThan(4000);
  });
});

describe('two windows', () => {
  it('coordinate when they share the secret', async () => {
    const leader = await rig.join('leader');
    const follower = await rig.join('follower');

    await waitFor('the follower shows the state', () => follower.remote?.state?.epoch === leader.state.epoch);
    expect(await follower.coordinator.send({ name: 'refresh' })).toEqual({ ok: true });
  });

  it('do not trust each other when their secrets differ: the second one is isolated', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState({ epoch: 'epoch-leader' });
    const other = rig.window('other', { secret: STRANGER_SECRET }).start();

    await waitFor('the other window is isolated', () => other.role === 'isolated');
    expect(other.remotes).toEqual([]);
    expect(leader.coordinator.peers()).toEqual([]);
    expect(leader.role).toBe('leader');
  });
});

describe('a window without a usable secret', () => {
  it.each([
    ['null', null],
    ['empty', ''],
    ['malformed', 'not-hex'.repeat(10)],
  ])('(%s) neither leads nor follows: it is isolated and says why', async (_name, secret) => {
    let attempts = 0;
    const claimer: EndpointClaimer = {
      attempt: () => {
        attempts += 1;
        return new Promise<Claim>(() => undefined);
      },
    };
    const window = rig.window('no-secret', { secret, claimer }).start();

    await sleep(100);

    expect(window.role).toBe('isolated');
    expect(window.roles).toEqual([{ role: 'isolated', handover: null, previousLeaderWasWatching: false }]);
    expect(attempts).toBe(0);
    expect(window.warnings).toEqual([
      "Can't read or create the secret file in the state folder, so this window can't coordinate.",
    ]);
    expect(window.coordinator.stillOwnsEndpoint()).toBe(false);
  });

  it('never leads, even when the endpoint is free', async () => {
    const window = rig.window('no-secret', { secret: null }).start();
    await sleep(300);

    expect(window.role).toBe('isolated');
    const other = await rig.join('other');
    expect(other.role).toBe('leader');
  });
});
