import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TurnCache } from '../../src/core/transcript';
import { assistant, byteLength, createFixtureDir, jsonl, prompt, toolResult, type FixtureDir } from './fixtures';

// 'end_turn' and 'tool_use' are equally long, so these two transcripts have the same size: one can
// replace the other without the (size, mtime) key noticing - the only way to tell a cached answer
// from a fresh read.
const CLOSED_TEXT = jsonl([prompt('go'), assistant('end_turn')]);
const OPEN_TEXT = jsonl([prompt('go'), assistant('tool_use')]);

const T0 = 1_700_000_000;

/** Sets the write time to an exact second and returns what a scanner's stat would then see. */
function stamp(file: string, seconds: number): { size: number; mtimeMs: number } {
  fs.utimesSync(file, seconds, seconds);
  const { size, mtimeMs } = fs.statSync(file);
  return { size, mtimeMs };
}

let fx: FixtureDir;

beforeAll(() => {
  fx = createFixtureDir();
});

afterAll(() => {
  fx.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TurnCache', () => {
  it('fixture sanity: the two transcripts differ only in content', () => {
    expect(byteLength(CLOSED_TEXT)).toBe(byteLength(OPEN_TEXT));
  });

  it('returns what readTurn returns', async () => {
    const file = fx.write(CLOSED_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    expect(await new TurnCache().get(file, size, mtimeMs)).toEqual({
      state: 'CLOSED',
      reason: 'turnEnded',
      detail: null,
      scheduledWakeupSeconds: null,
    });
  });

  it('does not open the file again while size and mtime are unchanged', async () => {
    const file = fx.write(CLOSED_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    const open = vi.spyOn(fs.promises, 'open');
    const cache = new TurnCache();
    await cache.get(file, size, mtimeMs);
    await cache.get(file, size, mtimeMs);
    await cache.get(file, size, mtimeMs);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('answers from the cache, not from the file, on a hit', async () => {
    const file = fx.write(CLOSED_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    const cache = new TurnCache();
    expect((await cache.get(file, size, mtimeMs)).state).toBe('CLOSED');

    fs.writeFileSync(file, OPEN_TEXT);
    expect(stamp(file, T0)).toEqual({ size, mtimeMs });
    expect((await cache.get(file, size, mtimeMs)).state).toBe('CLOSED');
    expect((await new TurnCache().get(file, size, mtimeMs)).state).toBe('OPEN');
  });

  it('re-reads when the mtime changes', async () => {
    const file = fx.write(CLOSED_TEXT);
    const before = stamp(file, T0);
    const cache = new TurnCache();
    expect((await cache.get(file, before.size, before.mtimeMs)).state).toBe('CLOSED');

    fs.writeFileSync(file, OPEN_TEXT);
    const after = stamp(file, T0 + 10);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect((await cache.get(file, after.size, after.mtimeMs)).state).toBe('OPEN');
  });

  it('re-reads when the size changes, even within the same mtime', async () => {
    const file = fx.write(CLOSED_TEXT);
    const before = stamp(file, T0);
    const cache = new TurnCache();
    expect((await cache.get(file, before.size, before.mtimeMs)).state).toBe('CLOSED');

    fs.appendFileSync(file, jsonl([prompt('one more thing')]));
    const after = stamp(file, T0);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBeGreaterThan(before.size);
    expect(await cache.get(file, after.size, after.mtimeMs)).toMatchObject({ state: 'OPEN', reason: 'thinking' });
  });

  it('keeps only the newest key of a path', async () => {
    const file = fx.write(CLOSED_TEXT);
    const first = stamp(file, T0);
    const cache = new TurnCache();
    await cache.get(file, first.size, first.mtimeMs);
    const second = stamp(file, T0 + 10);
    await cache.get(file, second.size, second.mtimeMs);

    const open = vi.spyOn(fs.promises, 'open');
    await cache.get(file, second.size, second.mtimeMs);
    expect(open).toHaveBeenCalledTimes(0);
    await cache.get(file, first.size, first.mtimeMs);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps separate entries for separate paths', async () => {
    const closed = fx.write(CLOSED_TEXT);
    const open = fx.write(OPEN_TEXT);
    const a = stamp(closed, T0);
    const b = stamp(open, T0);
    const cache = new TurnCache();
    expect((await cache.get(closed, a.size, a.mtimeMs)).state).toBe('CLOSED');
    expect((await cache.get(open, b.size, b.mtimeMs)).state).toBe('OPEN');
    expect((await cache.get(closed, a.size, a.mtimeMs)).state).toBe('CLOSED');
  });

  it('prune() drops every path that is not kept', async () => {
    const kept = fx.write(CLOSED_TEXT);
    const dropped = fx.write(CLOSED_TEXT);
    const k = stamp(kept, T0);
    const d = stamp(dropped, T0);
    const cache = new TurnCache();
    await cache.get(kept, k.size, k.mtimeMs);
    await cache.get(dropped, d.size, d.mtimeMs);

    fs.writeFileSync(kept, OPEN_TEXT);
    fs.writeFileSync(dropped, OPEN_TEXT);
    stamp(kept, T0);
    stamp(dropped, T0);
    cache.prune(new Set([kept, path.join(fx.dir, 'unrelated.jsonl')]));

    expect((await cache.get(kept, k.size, k.mtimeMs)).state).toBe('CLOSED');
    expect((await cache.get(dropped, d.size, d.mtimeMs)).state).toBe('OPEN');
  });

  it('prune() with an empty set empties the cache', async () => {
    const file = fx.write(CLOSED_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    const cache = new TurnCache();
    await cache.get(file, size, mtimeMs);
    cache.prune(new Set());
    const open = vi.spyOn(fs.promises, 'open');
    await cache.get(file, size, mtimeMs);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed read: the file is tried again on the next poll', async () => {
    const file = path.join(fx.dir, 'appears-later.jsonl');
    const size = byteLength(CLOSED_TEXT);
    const mtimeMs = T0 * 1000;
    const cache = new TurnCache();
    expect(await cache.get(file, size, mtimeMs)).toMatchObject({ state: 'UNKNOWN', reason: 'noTranscript' });

    fs.writeFileSync(file, CLOSED_TEXT);
    expect(stamp(file, T0)).toEqual({ size, mtimeMs });
    expect((await cache.get(file, size, mtimeMs)).state).toBe('CLOSED');
  });

  it('never caches an unreadable file either', async () => {
    const cache = new TurnCache();
    const open = vi.spyOn(fs.promises, 'open');
    expect((await cache.get(fx.dir, 0, T0)).reason).toBe('cannotRead');
    expect((await cache.get(fx.dir, 0, T0)).reason).toBe('cannotRead');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not keep an answer read from a file that is no longer the size the caller saw', async () => {
    const file = fx.write(CLOSED_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    const staleSize = size - 10;
    const cache = new TurnCache();
    expect((await cache.get(file, staleSize, mtimeMs)).state).toBe('CLOSED');

    fs.writeFileSync(file, OPEN_TEXT);
    stamp(file, T0);
    expect((await cache.get(file, staleSize, mtimeMs)).state).toBe('OPEN');
  });

  it('never hits on a size or mtime that is not a number', async () => {
    const file = fx.write(CLOSED_TEXT);
    const cache = new TurnCache();
    const open = vi.spyOn(fs.promises, 'open');
    expect((await cache.get(file, NaN, NaN)).state).toBe('CLOSED');
    expect((await cache.get(file, NaN, NaN)).state).toBe('CLOSED');
    expect((await cache.get(file, undefined as unknown as number, undefined as unknown as number)).state).toBe('CLOSED');
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('shares one read between simultaneous requests for the same file', async () => {
    const file = fx.write(OPEN_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    const open = vi.spyOn(fs.promises, 'open');
    const cache = new TurnCache();
    const turns = await Promise.all([cache.get(file, size, mtimeMs), cache.get(file, size, mtimeMs)]);
    expect(turns.map((turn) => turn.state)).toEqual(['OPEN', 'OPEN']);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('hands every caller its own object, so a cached answer cannot be changed from outside', async () => {
    const file = fx.write(OPEN_TEXT);
    const { size, mtimeMs } = stamp(file, T0);
    const cache = new TurnCache();
    const first = await cache.get(file, size, mtimeMs);
    first.state = 'CLOSED';
    first.reason = 'turnEnded';
    const second = await cache.get(file, size, mtimeMs);
    expect(second).toMatchObject({ state: 'OPEN', reason: 'toolInFlight' });
    expect(second).not.toBe(first);
  });

  it('passes the window options to the read', async () => {
    const file = fx.write(jsonl([prompt('go'), assistant('end_turn'), toolResult('x'.repeat(600))]));
    const { size, mtimeMs } = stamp(file, T0);
    expect(await new TurnCache().get(file, size, mtimeMs, { initialBytes: 64, limitBytes: 64 })).toMatchObject({
      state: 'UNKNOWN',
      reason: 'noConversationRecord',
    });
    expect(await new TurnCache().get(file, size, mtimeMs)).toMatchObject({ state: 'OPEN', reason: 'readingToolResult' });
  });

  it('never rejects', async () => {
    const cache = new TurnCache();
    await expect(cache.get(path.join(fx.dir, 'bad\0name.jsonl'), 1, 1)).resolves.toMatchObject({ state: 'UNKNOWN' });
    await expect(cache.get('', 0, 0)).resolves.toMatchObject({ state: 'UNKNOWN', reason: 'noTranscript' });
  });
});
