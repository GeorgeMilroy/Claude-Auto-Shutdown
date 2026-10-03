import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../../src/coordination/coordinator';
import { PipeClaimer, retry, type Claim, type EndpointClaimer } from '../../src/coordination/endpoint';
import { PROTOCOL_VERSION, type UiState } from '../../src/shared/protocol';
import { armedState, makeHello, Rig, sleep, TEST_SECRET, TestWindow, waitFor } from './harness';

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.dispose();
});

function settled(windows: TestWindow[]): boolean {
  return windows.every((window) => window.role === 'leader' || window.role === 'follower');
}

function leadersOf(windows: TestWindow[]): TestWindow[] {
  return windows.filter((window) => window.role === 'leader');
}

describe('election', () => {
  it('elects exactly one leader among six windows started together', async () => {
    const windows = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => rig.window(label));
    for (const window of windows) window.start();

    await waitFor('every window has a role', () => settled(windows));
    const [leader, ...others] = leadersOf(windows);

    expect(others).toEqual([]);
    expect(windows.filter((window) => window.role === 'follower')).toHaveLength(5);
    await waitFor('the leader knows its five followers', () => leader!.coordinator.peers().length === 5);
    expect(leader!.coordinator.stillOwnsEndpoint()).toBe(true);
    for (const follower of windows.filter((window) => window !== leader)) {
      expect(follower.coordinator.stillOwnsEndpoint()).toBe(false);
      expect(follower.coordinator.peers()).toEqual([]);
    }
  });

  it('starts as electing and reports the first leader without a handover', async () => {
    const window = rig.window('solo');
    expect(window.role).toBe('electing');

    window.start();
    await waitFor('solo leads', () => window.role === 'leader');

    expect(window.roles).toEqual([{ role: 'leader', handover: null, previousLeaderWasWatching: false }]);
  });

  it('refuses to start without leader handlers', () => {
    const bare = new Coordinator({
      endpoint: rig.endpoint,
      self: makeHello('unconfigured'),
      protocolVersion: PROTOCOL_VERSION,
      secret: TEST_SECRET,
      log: () => undefined,
    });

    expect(() => bare.start()).toThrow(/setLeaderHandlers/);
  });
});

describe('a leader that dies without a goodbye', () => {
  it('is replaced by exactly one survivor, which reports that watching was lost', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState({ epoch: 'epoch-leader' });
    const survivors = [await rig.join('a'), await rig.join('b'), await rig.join('c')];
    leader.state = armedState({ epoch: 'epoch-leader', seq: 2 });
    leader.coordinator.publish(leader.state);
    await waitFor('every follower shows the newest armed state', () =>
      survivors.every((window) => window.remote?.state?.seq === 2),
    );
    const seenBeforeCrash = survivors.map((window) => window.remotes.length);

    leader.crash();
    await waitFor('the survivors settled without the dead leader', () => {
      const [next] = leadersOf(survivors);
      return (
        settled(survivors) &&
        survivors.every((window) => window === next || window.remote?.state?.epoch === next?.state.epoch)
      );
    });

    const [next, ...extra] = leadersOf(survivors);
    expect(extra).toEqual([]);
    expect(next!.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: true });

    survivors.forEach((window, index) => {
      const afterCrash = window.remotes.slice(seenBeforeCrash[index]);
      // "Reconnecting" comes first, and the dead leader's state never comes back.
      expect(afterCrash[0]?.state).toBeNull();
      expect(afterCrash.filter((remote) => remote.state?.epoch === 'epoch-leader')).toEqual([]);
      expect(window.roles.map((change) => change.role)).toContain('electing');
    });
    for (const follower of survivors.filter((window) => window !== next)) {
      expect(follower.remote?.state).toEqual(next!.state);
      expect(follower.lastRole).toEqual({ role: 'follower', handover: null, previousLeaderWasWatching: false });
    }
  });

  it('does not report lost watching when the dead leader was not watching', async () => {
    const leader = await rig.join('leader');
    const survivor = await rig.join('survivor');
    await waitFor('the survivor shows the state', () => survivor.remote?.state?.armed === false);

    leader.crash();
    await waitFor('the survivor leads', () => survivor.role === 'leader');

    expect(survivor.lastRole).toEqual({ role: 'leader', handover: null, previousLeaderWasWatching: false });
  });

  it('still reports lost watching when the armed leader had gone quiet before it died', async () => {
    const leader = await rig.join('leader');
    leader.state = armedState({ epoch: 'epoch-leader' });
    const survivor = await rig.join('survivor');
    await waitFor('the survivor shows the armed state', () => survivor.remote?.state?.armed === true);
    const unreadable = { ...armedState(), sessions: 'not a list' } as unknown as UiState;
    leader.coordinator.publish(unreadable);
    await waitFor('the survivor stopped showing a state', () => survivor.remote?.state === null);

    leader.crash();
    await waitFor('the survivor leads', () => survivor.role === 'leader');

    expect(survivor.lastRole?.previousLeaderWasWatching).toBe(true);
  });
});

describe('a leader that loses its endpoint', () => {
  it('steps down at once and has to win a new election before it leads again', async () => {
    const window = await rig.join('solo');
    expect(window.coordinator.stillOwnsEndpoint()).toBe(true);

    window.loseEndpoint();
    expect(window.coordinator.stillOwnsEndpoint()).toBe(false);

    await waitFor('solo leads again', () => window.roles.length === 3 && window.role === 'leader');
    expect(window.roles.map((change) => change.role)).toEqual(['leader', 'electing', 'leader']);
    expect(window.coordinator.stillOwnsEndpoint()).toBe(true);
  });
});

describe('a window that cannot reach or become the leader', () => {
  /** Fails every round until `heal()`, then claims the endpoint for real. */
  class BlockedClaimer implements EndpointClaimer {
    attempts = 0;
    private real: EndpointClaimer | null = null;

    heal(endpoint: string): void {
      this.real = new PipeClaimer(endpoint);
    }

    attempt(signal: AbortSignal): Promise<Claim> {
      this.attempts += 1;
      return this.real ? this.real.attempt(signal) : Promise.resolve(retry('blocked by the test'));
    }
  }

  it('is isolated after ten failed rounds and refuses to arm', async () => {
    const claimer = new BlockedClaimer();
    const window = rig.window('cut-off', { claimer, random: () => 0 }).start();

    await waitFor('cut-off is isolated', () => window.role === 'isolated');

    expect(claimer.attempts).toBe(10);
    expect(window.roles).toEqual([{ role: 'isolated', handover: null, previousLeaderWasWatching: false }]);
    expect(window.coordinator.stillOwnsEndpoint()).toBe(false);
    const answer = await window.coordinator.send({ name: 'refresh' });
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/Not connected/);
  });

  it.runIf(process.platform === 'win32')('keeps trying every 5 s and recovers', async () => {
    const claimer = new BlockedClaimer();
    const window = rig.window('cut-off', { claimer, random: () => 0 }).start();
    await waitFor('cut-off is isolated', () => window.role === 'isolated');
    const attemptsWhenIsolated = claimer.attempts;

    await sleep(600);
    expect(claimer.attempts).toBe(attemptsWhenIsolated);

    claimer.heal(rig.endpoint);
    await waitFor('cut-off leads', () => window.role === 'leader', 7000);
    expect(window.roles.map((change) => change.role)).toEqual(['isolated', 'leader']);
  });

  it('gives up on a leader that never answers the hello and takes over once it is gone', async () => {
    const silent = await rig.rawLeader();
    const window = rig.window('newcomer').start();
    await silent.accepted(1);
    const first = silent.latest;
    const connectedAt = performance.now();

    await waitFor('the newcomer hangs up', () => first.closed, 4000);
    expect(performance.now() - connectedAt).toBeGreaterThan(1800);
    expect(window.role).toBe('electing');

    silent.close();
    await waitFor('the newcomer leads', () => window.role === 'leader');
    expect(window.remotes).toEqual([]);
  });
});
