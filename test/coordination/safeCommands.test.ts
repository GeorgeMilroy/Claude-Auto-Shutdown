import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../src/coordination/emitter';
import { PendingSafeCommands } from '../../src/coordination/safeCommands';
import { between, TimerSet } from '../../src/coordination/timing';
import type { Command, CommandResult } from '../../src/shared/protocol';

const STOP: Command = { name: 'disarm' };
const CANCEL: Command = { name: 'cancel', via: 'esc' };

function tracker() {
  const stuck: Command[] = [];
  let delivered = 0;
  const commands = new PendingSafeCommands({
    stuck: (command) => stuck.push(command),
    delivered: () => (delivered += 1),
  });
  const add = (command: Command) => {
    const { pending, answer } = commands.add(command);
    const told: CommandResult[] = [];
    void answer.then((result) => told.push(result));
    return { id: pending.id, told };
  };
  return { commands, stuck, add, delivered: () => delivered };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingSafeCommands', () => {
  it('keeps a command pending, oldest first, until a leader says it is done', async () => {
    const { commands, add, delivered } = tracker();
    const stop = add(STOP);
    const cancel = add(CANCEL);

    expect(commands.pending()).toEqual([
      expect.objectContaining({ id: stop.id, command: STOP }),
      expect.objectContaining({ id: cancel.id, command: CANCEL }),
    ]);
    expect(stop.id).not.toBe(cancel.id);

    commands.answered(stop.id, { ok: true });
    await Promise.resolve();
    expect(stop.told).toEqual([{ ok: true }]);
    expect(commands.size).toBe(1);
    expect(delivered()).toBe(0);

    commands.answered(cancel.id, { ok: true });
    expect(commands.size).toBe(0);
    expect(delivered()).toBe(1);
  });

  it('reports a command stuck after 2 s without an answer, once', () => {
    const { commands, stuck, add } = tracker();
    add(CANCEL);

    vi.advanceTimersByTime(1999);
    expect(stuck).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stuck).toEqual([CANCEL]);

    vi.advanceTimersByTime(60_000);
    expect(stuck).toEqual([CANCEL]);
    expect(commands.size).toBe(1);
  });

  it('is delivered, and no longer reported, when the answer comes in time', () => {
    const { commands, stuck, add, delivered } = tracker();
    const stop = add(STOP);

    vi.advanceTimersByTime(1500);
    commands.answered(stop.id, { ok: true });
    vi.advanceTimersByTime(60_000);

    expect(stuck).toEqual([]);
    expect(delivered()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is delivered after it was reported stuck, when a later leader confirms it', async () => {
    const { commands, stuck, add, delivered } = tracker();
    const stop = add(STOP);

    vi.advanceTimersByTime(5000);
    commands.answered(stop.id, { ok: true });
    await Promise.resolve();

    expect(stuck).toEqual([STOP]);
    expect(delivered()).toBe(1);
    expect(stop.told).toEqual([{ ok: true }]);
  });

  it('treats a refusal as stuck at once, tells the caller, and keeps the command for the next leader', async () => {
    const { commands, stuck, add, delivered } = tracker();
    const stop = add(STOP);

    commands.answered(stop.id, { ok: false, error: 'Broken.' });
    await Promise.resolve();

    expect(stuck).toEqual([STOP]);
    expect(stop.told).toEqual([{ ok: false, error: 'Broken.' }]);
    expect(commands.pending()).toHaveLength(1);
    expect(delivered()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    commands.answered(stop.id, { ok: true });
    await Promise.resolve();
    expect(delivered()).toBe(1);
    expect(stop.told).toEqual([{ ok: false, error: 'Broken.' }]);
    expect(stuck).toEqual([STOP]);
  });

  it('ignores answers to commands it does not know', () => {
    const { commands, stuck, add, delivered } = tracker();
    const stop = add(STOP);
    commands.answered(stop.id, { ok: true });

    commands.answered(stop.id, { ok: true });
    commands.answered('somebody-else', { ok: false, error: 'x' });

    expect(delivered()).toBe(1);
    expect(stuck).toEqual([]);
  });

  it('on abandon reports what was not reported yet, fails every caller and leaves no timer', async () => {
    const { commands, stuck, add, delivered } = tracker();
    const early = add(STOP);
    vi.advanceTimersByTime(2000);
    const late = add(CANCEL);

    commands.abandon('This window is closing.');
    await Promise.resolve();

    expect(stuck).toEqual([STOP, CANCEL]);
    expect(early.told).toEqual([{ ok: false, error: 'This window is closing.' }]);
    expect(late.told).toEqual([{ ok: false, error: 'This window is closing.' }]);
    expect(commands.size).toBe(0);
    expect(delivered()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TimerSet', () => {
  it('runs, clears and forgets timers', () => {
    const timers = new TimerSet();
    const fired: string[] = [];

    timers.set(() => fired.push('a'), 100);
    const b = timers.set(() => fired.push('b'), 100);
    timers.clear(b);
    timers.clear(null);
    vi.advanceTimersByTime(100);

    expect(fired).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels everything on dispose and refuses new timers afterwards', () => {
    const timers = new TimerSet();
    const fired: string[] = [];
    timers.set(() => fired.push('a'), 100);
    timers.set(() => fired.push('b'), 200);

    timers.dispose();
    expect(timers.set(() => fired.push('late'), 10)).toBeNull();
    vi.advanceTimersByTime(1000);

    expect(fired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('picks jitter inside the range', () => {
    expect(between([20, 100], () => 0)).toBe(20);
    expect(between([20, 100], () => 0.5)).toBe(60);
    expect(between([500, 700], () => 0.999)).toBeCloseTo(699.8, 1);
  });
});

describe('Emitter', () => {
  it('calls every listener even when one throws, and reports the error', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter<number>((error) => errors.push(error));
    const seen: number[] = [];
    emitter.on(() => {
      throw new Error('bad listener');
    });
    emitter.on((value) => seen.push(value));

    emitter.emit(7);

    expect(seen).toEqual([7]);
    expect(errors).toHaveLength(1);
  });

  it('stops calling a listener that was disposed, even from inside another listener', () => {
    const emitter = new Emitter<number>(() => undefined);
    const seen: number[] = [];
    const second = emitter.on((value) => seen.push(value));
    emitter.on(() => second.dispose());

    emitter.emit(1);
    emitter.emit(2);

    expect(seen).toEqual([1]);
  });
});
