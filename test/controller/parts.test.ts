// The controller's small collaborators, each on its own.

import { describe, expect, it } from 'vitest';

import { CAPABILITY_TTL_MS, CapabilityCache } from '../../src/controller/capabilities';
import {
  IgnoreList,
  PROC_IGNORE_GRACE_MS,
  REMOTE_RECONNECT_GRACE_MS,
  describeIgnoreKey,
} from '../../src/controller/ignores';
import { KeepAwakeHold } from '../../src/controller/keepAwake';
import { PollLoop } from '../../src/controller/pollLoop';
import {
  UNKNOWN_REMOTE_WINDOWS,
  environmentProblemOf,
  helperStatusOf,
  remoteWindowNames,
  saysYes,
} from '../../src/controller/surroundings';
import { Ticker } from '../../src/controller/timeGuard';
import type { Capability, HelperStatus } from '../../src/platform/types';
import type { PowerAction } from '../../src/shared/config';
import { FakeClock, deferred, drain, makeScan, makeSession } from './harness';

describe('PollLoop', () => {
  function setup(options: { active?: boolean } = {}) {
    const clock = new FakeClock();
    const world = { active: options.active ?? true, generation: 0, intervalMs: 10_000 };
    const scans: { finish(): void; fail(error: Error): void }[] = [];
    const errors: unknown[] = [];
    let running = 0;
    let maxRunning = 0;
    const loop = new PollLoop({
      timers: clock,
      isActive: () => world.active,
      intervalMs: () => world.intervalMs,
      generation: () => world.generation,
      scan: () => {
        const gate = deferred<void>();
        running++;
        maxRunning = Math.max(maxRunning, running);
        scans.push({ finish: () => gate.resolve(), fail: (error) => gate.reject(error) });
        return gate.promise.finally(() => {
          running--;
        });
      },
      onError: (error) => errors.push(error),
    });
    return { clock, world, scans, errors, loop, maxRunning: () => maxRunning };
  }

  it('scans, waits one interval after the scan FINISHED, and scans again', async () => {
    const t = setup();
    t.loop.scanNow();
    await drain();
    expect(t.scans).toHaveLength(1);
    expect(t.loop.nextScanInMs()).toBeNull(); // running

    await t.clock.advance(60_000); // a slow scan does not pile up more scans
    expect(t.scans).toHaveLength(1);

    t.scans[0]?.finish();
    await drain();
    expect(t.loop.nextScanInMs()).toBe(10_000);
    await t.clock.advance(9_999);
    expect(t.scans).toHaveLength(1);
    await t.clock.advance(1);
    expect(t.scans).toHaveLength(2);
  });

  it('never runs two scans at once, including exclusive tasks', async () => {
    const t = setup();
    const order: string[] = [];
    t.loop.scanNow();
    await drain();
    const exclusive = t.loop.exclusive(async () => {
      order.push('exclusive started');
    });
    t.loop.scanNow();
    t.loop.scanNow();
    await drain();
    expect(order).toEqual([]); // waits for the scan in flight
    expect(t.scans).toHaveLength(1);

    t.scans[0]?.finish();
    await exclusive;
    await drain();
    expect(order).toEqual(['exclusive started']);
    expect(t.maxRunning()).toBe(1);
  });

  it('scanNow during a scan follows up only when the rules changed meanwhile', async () => {
    const t = setup();
    t.loop.scanNow();
    await drain();
    t.loop.scanNow(); // same generation: the running scan is as good as a new one
    t.scans[0]?.finish();
    await drain();
    expect(t.scans).toHaveLength(1);

    await t.clock.advance(10_000);
    expect(t.scans).toHaveLength(2);
    t.world.generation++;
    t.loop.scanNow();
    t.scans[1]?.finish();
    await drain();
    expect(t.scans).toHaveLength(3); // at once, not an interval later
  });

  it('survives a scan that rejects', async () => {
    const t = setup();
    t.loop.scanNow();
    await drain();
    t.scans[0]?.fail(new Error('boom'));
    await drain();
    expect(t.errors).toHaveLength(1);
    await t.clock.advance(10_000);
    expect(t.scans).toHaveLength(2);
  });

  it('runs a single scan while inactive, pauses, reschedules and disposes', async () => {
    const t = setup({ active: false });
    t.loop.scanNow();
    await drain();
    t.scans[0]?.finish();
    await drain();
    expect(t.loop.idle).toBe(true);
    expect(t.clock.pending).toBe(0);

    t.world.active = true;
    t.loop.scanNow();
    await drain();
    t.scans[1]?.finish();
    await drain();
    expect(t.loop.idle).toBe(false);

    t.world.intervalMs = 2_000;
    t.loop.reschedule();
    expect(t.loop.nextScanInMs()).toBe(2_000);

    t.loop.pause();
    expect(t.loop.idle).toBe(true);
    t.loop.dispose();
    t.loop.scanNow();
    await t.clock.advance(60_000);
    expect(t.scans).toHaveLength(2);
  });
});

describe('Ticker', () => {
  function setup() {
    const clock = new FakeClock();
    const world: { interval: number | null } = { interval: 1000 };
    const events: string[] = [];
    const ticker = new Ticker({
      clock,
      intervalMs: () => world.interval,
      onTick: () => events.push('tick'),
      onJump: () => events.push('jump'),
      onError: () => events.push('error'),
    });
    return { clock, world, events, ticker };
  }

  it('ticks at the asked interval and stops when none is asked', async () => {
    const t = setup();
    t.ticker.sync();
    await t.clock.advance(3_000);
    expect(t.events).toEqual(['tick', 'tick', 'tick']);

    t.world.interval = null;
    t.ticker.sync();
    await t.clock.advance(10_000);
    expect(t.events).toHaveLength(3);
    expect(t.clock.pending).toBe(0);
  });

  it('reports a jump INSTEAD of a tick, and starts a fresh baseline after a pause', async () => {
    const t = setup();
    t.ticker.sync();
    t.clock.skip(60_000);
    await t.clock.advance(0);
    expect(t.events).toEqual(['jump']);

    t.world.interval = null;
    t.ticker.sync();
    t.clock.skip(3_600_000); // not ticking: nobody is counting on this time
    t.world.interval = 1000;
    t.ticker.sync();
    await t.clock.advance(1_000);
    expect(t.events).toEqual(['jump', 'tick']);
  });

  it('hasten applies a shorter interval at once', async () => {
    const t = setup();
    t.ticker.sync();
    await t.clock.advance(100);
    t.world.interval = 250;
    t.ticker.hasten();
    await t.clock.advance(250);
    expect(t.events).toEqual(['tick']);
  });

  it('jumped() can be asked between ticks and counts "never looked" as a jump', () => {
    const t = setup();
    expect(t.ticker.jumped()).toBe(true);
    expect(t.ticker.jumped()).toBe(false);
    t.clock.shiftWall(-5_000);
    expect(t.ticker.jumped()).toBe(true);
    expect(t.ticker.jumped()).toBe(false);
  });

  it('keeps ticking when a tick handler throws', async () => {
    const clock = new FakeClock();
    const events: string[] = [];
    const ticker = new Ticker({
      clock,
      intervalMs: () => 1000,
      onTick: () => {
        events.push('tick');
        throw new Error('boom');
      },
      onJump: () => undefined,
      onError: () => events.push('error'),
    });
    ticker.sync();
    await clock.advance(2_000);
    expect(events).toEqual(['tick', 'error', 'tick', 'error']);
    ticker.dispose();
    expect(clock.pending).toBe(0);
  });
});

describe('IgnoreList', () => {
  const sessionKey = makeSession().ignoreKey;

  it('keeps what a complete scan still lists and drops session keys it does not', () => {
    const list = new IgnoreList();
    list.add(sessionKey, 0);
    list.add('session:gone', 0);
    expect(list.pruneAgainst(makeScan(), 1000)).toBe(1);
    expect(list.keys()).toEqual([sessionKey]);
  });

  it('drops nothing when the scan could not see everything', () => {
    const list = new IgnoreList();
    list.add('session:gone', 0);
    list.add('proc:1:2', 0);
    expect(list.pruneAgainst(makeScan({ sessions: [], errors: ['a root timed out'] }), PROC_IGNORE_GRACE_MS * 2)).toBe(0);
    expect(list.pruneAgainst(makeScan({ sessions: [], strays: null }), PROC_IGNORE_GRACE_MS * 2)).toBe(0);
    expect(list.size).toBe(2);
  });

  it('gives a process key a grace period counted from when it was last listed', () => {
    const list = new IgnoreList();
    const key = 'proc:9:99';
    const stray = { pid: 9, name: 'claude', path: null, accounted: false, ignoreKey: key, ignored: true, children: [] };
    list.add(key, 0);
    list.pruneAgainst(makeScan({ strays: [stray] }), 600_000); // listed: the clock restarts
    list.pruneAgainst(makeScan(), 600_000 + PROC_IGNORE_GRACE_MS - 1);
    expect(list.has(key)).toBe(true);
    list.pruneAgainst(makeScan(), 600_000 + PROC_IGNORE_GRACE_MS);
    expect(list.has(key)).toBe(false);
  });

  it("keeps the key of a stray's busy child while the scan lists it, and names it in the log", () => {
    const list = new IgnoreList();
    const key = 'proc:7100:133800000000000000';
    const child = { pid: 7100, name: 'node', cpuPercent: 90, ioBytesPerSecond: 0, busy: true, ignoreKey: key, ignored: true };
    const stray = { pid: 7000, name: 'claude', path: null, accounted: false, ignoreKey: 'proc:7000:1', ignored: false, children: [child] };
    const scan = makeScan({ strays: [stray] });
    list.add(key, 0);
    list.pruneAgainst(scan, PROC_IGNORE_GRACE_MS * 3); // still listed: kept however long ago it was set
    expect(list.has(key)).toBe(true);
    expect(describeIgnoreKey(key, scan)).toBe('process node (PID 7100)');
  });

  it('drops a remote key when its window is gone - except right after a takeover', () => {
    const list = new IgnoreList();
    list.add('remote:WSL: Ubuntu', 0);
    list.pruneRemote(new Set(['remote:WSL: Ubuntu']), 10);
    expect(list.size).toBe(1);
    list.pruneRemote(new Set(), 20);
    expect(list.size).toBe(0);

    list.adopt(['remote:SSH: box', 'proc:1:2'], 1000);
    list.pruneRemote(new Set(), 1000 + REMOTE_RECONNECT_GRACE_MS - 1);
    expect(list.has('remote:SSH: box')).toBe(true);
    list.pruneRemote(new Set(), 1000 + REMOTE_RECONNECT_GRACE_MS);
    expect(list.keys()).toEqual(['proc:1:2']);
  });

  it('describes keys for the log without trusting their content', () => {
    const scan = makeScan();
    expect(describeIgnoreKey(sessionKey, scan)).toBe('session "web-ui" (until it writes again)');
    expect(describeIgnoreKey('session:unknown', scan)).toBe('a session');
    expect(describeIgnoreKey('proc:1:2', null)).toBe('a process');
    expect(describeIgnoreKey(`remote:${'x'.repeat(500)}`, null).length).toBeLessThan(120);
  });
});

describe('CapabilityCache', () => {
  function setup(answer: (action: PowerAction) => Promise<unknown> | unknown) {
    const clock = new FakeClock();
    const calls: PowerAction[] = [];
    const cache = new CapabilityCache(
      {
        capability: (action) => {
          calls.push(action);
          return Promise.resolve(answer(action)) as Promise<Capability>;
        },
      },
      () => clock.mono(),
    );
    return { clock, calls, cache };
  }

  it('answers from the cache for 5 minutes, then asks again', async () => {
    const t = setup(() => ({ ok: true, detail: 'Allowed' }));
    expect(t.cache.get('sleep')).toBeNull();
    expect(await t.cache.refresh(['sleep'], () => false)).toBe(true);
    expect(await t.cache.refresh(['sleep'], () => false)).toBe(false);
    t.clock.skip(CAPABILITY_TTL_MS - 1);
    expect(await t.cache.refresh(['sleep'], () => false)).toBe(false);
    t.clock.skip(1);
    expect(await t.cache.refresh(['sleep'], () => false)).toBe(true);
    expect(t.calls).toEqual(['sleep', 'sleep']);
    expect(t.cache.all()).toEqual({ sleep: { ok: true, detail: 'Allowed' } });
  });

  it('query() always asks, but only once at a time per action', async () => {
    const gate = deferred<Capability>();
    const t = setup(() => gate.promise);
    const first = t.cache.query('lock');
    const second = t.cache.query('lock');
    gate.resolve({ ok: false, detail: 'no' });
    expect(await first).toEqual({ ok: false, detail: 'no' });
    expect(await second).toEqual({ ok: false, detail: 'no' });
    expect(t.calls).toEqual(['lock']);
    await t.cache.query('lock');
    expect(t.calls).toEqual(['lock', 'lock']);
  });

  it('turns a failed or malformed answer into "can\'t tell"', async () => {
    const failing = setup(() => Promise.reject(new Error('helper died')));
    expect(await failing.cache.query('shutdown')).toEqual({ ok: null, detail: "Couldn't check: helper died" });

    for (const junk of [null, 'yes', { ok: 'true' }, { ok: 1, detail: 5 }]) {
      const t = setup(() => junk);
      expect((await t.cache.query('shutdown')).ok).toBeNull();
    }
  });

  it('stops asking when cancelled', async () => {
    const t = setup(() => ({ ok: true, detail: '' }));
    expect(await t.cache.refresh(['sleep', 'lock'], () => true)).toBe(false);
    expect(t.calls).toEqual([]);
  });
});

describe('KeepAwakeHold', () => {
  it('calls the platform only when the wish changes and reports the outcome', async () => {
    const calls: boolean[] = [];
    const settled: boolean[] = [];
    const hold = new KeepAwakeHold(
      {
        keepAwake: (on) => {
          calls.push(on);
          return Promise.resolve({ ok: true, detail: '' });
        },
      },
      (held) => settled.push(held),
    );
    hold.want(false);
    hold.want(true);
    hold.want(true);
    await drain();
    expect(calls).toEqual([true]);
    expect(hold.state).toBe('held');
    expect(settled).toEqual([true]);

    hold.want(false);
    expect(hold.state).toBe('off');
    await drain();
    expect(calls).toEqual([true, false]);
    expect(settled).toEqual([true]);
  });

  it('is "unavailable" when the OS refuses or throws, and ignores an answer that came too late', async () => {
    const refusing = new KeepAwakeHold({ keepAwake: () => Promise.reject(new Error('no')) }, () => undefined);
    refusing.want(true);
    await drain();
    expect(refusing.state).toBe('unavailable');

    const slow = deferred<{ ok: boolean; detail: string }>();
    const late = new KeepAwakeHold({ keepAwake: (on) => (on ? slow.promise : Promise.resolve({ ok: true, detail: '' })) }, () => undefined);
    late.want(true);
    late.want(false);
    slow.resolve({ ok: true, detail: '' });
    await drain();
    expect(late.state).toBe('off');
  });
});

describe('surroundings', () => {
  it('reads the platform carefully', () => {
    expect(environmentProblemOf({ environmentProblem: () => null })).toBeNull();
    expect(environmentProblemOf({ environmentProblem: () => 'Flatpak' })).toBe('Flatpak');
    expect(
      environmentProblemOf({
        environmentProblem: () => {
          throw new Error('x');
        },
      }),
    ).toMatch(/could not be checked/);

    const limited: HelperStatus = { tier: 'limited', problem: 'no idle time' };
    expect(helperStatusOf({ helperStatus: () => limited })).toEqual(limited);
    expect(helperStatusOf({ helperStatus: () => ({ tier: 'great' }) as unknown as HelperStatus }).tier).toBe('unavailable');
    expect(helperStatusOf({ helperStatus: () => undefined as unknown as HelperStatus }).tier).toBe('unavailable');
  });

  it('only an exact `true` is a yes', () => {
    expect(saysYes(() => true)).toBe(true);
    expect(saysYes(() => 'yes' as unknown as boolean)).toBe(false);
    expect(
      saysYes(() => {
        throw new Error('x');
      }),
    ).toBe(false);
  });

  it('a remote-window list that cannot be read becomes a window that blocks', () => {
    expect(remoteWindowNames(() => ['WSL: Ubuntu', '', 'WSL: Ubuntu', 7 as unknown as string])).toEqual(['WSL: Ubuntu']);
    expect(remoteWindowNames(() => [])).toEqual([]);
    expect(
      remoteWindowNames(() => {
        throw new Error('x');
      }),
    ).toEqual([UNKNOWN_REMOTE_WINDOWS]);
    expect(remoteWindowNames(() => 'WSL' as unknown as string[])).toEqual([UNKNOWN_REMOTE_WINDOWS]);
  });
});
