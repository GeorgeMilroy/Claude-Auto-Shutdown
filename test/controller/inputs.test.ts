import { describe, expect, it } from 'vitest';

import { isIgnoreKey } from '../../src/controller/ignores';
import { COOLDOWN_MS, parseCommand, parseHandover } from '../../src/controller/inputs';
import { parseCancelReason, parseLastResult } from '../../src/controller/records';
import { isDiscontinuity } from '../../src/controller/timeGuard';
import { cancelReasonFor, withoutNewPoll } from '../../src/controller/verdict';
import type { Check, Verdict } from '../../src/core/types';
import { DEFAULT_CONFIG, toArmContract } from '../../src/shared/config';
import type { LastResult } from '../../src/shared/protocol';
import { busyScan, clearScan } from './harness';

const contract = toArmContract(DEFAULT_CONFIG);

describe('parseCommand', () => {
  it('accepts every command of the protocol', () => {
    expect(parseCommand({ name: 'disarm' })).toEqual({ name: 'disarm' });
    expect(parseCommand({ name: 'refresh' })).toEqual({ name: 'refresh' });
    expect(parseCommand({ name: 'preview' })).toEqual({ name: 'preview' });
    expect(parseCommand({ name: 'dismissResult' })).toEqual({ name: 'dismissResult' });
    expect(parseCommand({ name: 'cancel', via: 'esc' })).toEqual({ name: 'cancel', via: 'esc' });
    expect(parseCommand({ name: 'ignore', key: 'proc:1:2', on: false })).toEqual({ name: 'ignore', key: 'proc:1:2', on: false });
    expect(parseCommand({ name: 'settingsChanged', realm: 'r', digest: 'd' })).toEqual({ name: 'settingsChanged', realm: 'r', digest: 'd' });
    expect(parseCommand({ name: 'arm', contract, digest: 'd', epoch: 'e', realm: 'r' })).toEqual({
      name: 'arm',
      contract,
      digest: 'd',
      epoch: 'e',
      realm: 'r',
    });
  });

  it('never refuses a cancel or a disarm over its shape', () => {
    expect(parseCommand({ name: 'cancel' })).toEqual({ name: 'cancel', via: 'command' });
    expect(parseCommand({ name: 'cancel', via: 42, extra: true })).toEqual({ name: 'cancel', via: 'command' });
    expect(parseCommand({ name: 'disarm', junk: [1, 2] })).toEqual({ name: 'disarm' });
  });

  it('refuses everything else that is not well formed', () => {
    for (const raw of [
      null,
      undefined,
      'cancel',
      42,
      [],
      {},
      { name: 'executeNow' },
      { name: 'arm', contract },
      { name: 'arm', contract, digest: 1, epoch: 'e', realm: 'r' },
      { name: 'ignore', key: 'proc:1:2' },
      { name: 'ignore', key: 7, on: true },
      { name: 'settingsChanged', realm: 'r' },
    ]) {
      expect(parseCommand(raw)).toBeNull();
    }
  });
});

describe('isIgnoreKey', () => {
  it('accepts only the three prefixes, with something after them', () => {
    expect(isIgnoreKey('session:0:1:abc:1:1:0')).toBe(true);
    expect(isIgnoreKey('proc:1:2')).toBe(true);
    expect(isIgnoreKey('remote:WSL: Ubuntu')).toBe(true);
    for (const bad of ['remote:', 'proc', 'x:1', '', 5, null, `session:${'a'.repeat(5000)}`]) {
      expect(isIgnoreKey(bad)).toBe(false);
    }
  });
});

describe('parseHandover', () => {
  const valid = {
    contract,
    contractRealm: 'realm',
    armedAtMs: 1_768_000_000_000,
    sawAnySession: true,
    sinceLastSessionMs: 5_000,
    cooldownRemainingMs: 12_000,
    ignores: ['proc:1:2'],
  };

  it('passes a valid payload through', () => {
    expect(parseHandover(valid)).toEqual(valid);
  });

  it('refuses a payload whose contract, realm or arm time cannot be trusted', () => {
    expect(parseHandover(null)).toBeNull();
    expect(parseHandover({ ...valid, contract: { ...contract, quietSeconds: 'soon' } })).toBeNull();
    expect(parseHandover({ ...valid, contract: { ...contract, countdownSeconds: 0 } })).toBeNull();
    expect(parseHandover({ ...valid, contractRealm: 7 })).toBeNull();
    expect(parseHandover({ ...valid, armedAtMs: Number.NaN })).toBeNull();
    expect(parseHandover({ ...valid, armedAtMs: '1768000000000' })).toBeNull();
  });

  it('falls back to the careful value for everything else', () => {
    const parsed = parseHandover({
      ...valid,
      sawAnySession: 'true',
      sinceLastSessionMs: -5,
      cooldownRemainingMs: 'none',
      ignores: ['proc:1:2', 'evil', 7, 'remote:SSH: box'],
    });
    expect(parsed).toMatchObject({
      sawAnySession: false,
      sinceLastSessionMs: null,
      cooldownRemainingMs: COOLDOWN_MS,
      ignores: ['proc:1:2', 'remote:SSH: box'],
    });
    expect(parseHandover({ ...valid, cooldownRemainingMs: 9_999_999 })?.cooldownRemainingMs).toBe(COOLDOWN_MS);
    expect(parseHandover({ ...valid, cooldownRemainingMs: -1 })?.cooldownRemainingMs).toBe(0);
    expect(parseHandover({ ...valid, ignores: 'proc:1:2' })?.ignores).toEqual([]);
  });
});

describe('parseLastResult', () => {
  const results: LastResult[] = [
    { kind: 'testPassed', atMs: 1, action: 'shutdown', armedAtMs: 0, lastSessionFinishedAtMs: null, allClearAtMs: 1, heldUpBy: { name: 'a', seconds: 3 } },
    { kind: 'done', atMs: 1, action: 'sleep', resumedAtMs: 9, confirmed: null },
    { kind: 'done', atMs: 1, action: 'shutdown', resumedAtMs: null, confirmed: false },
    { kind: 'failed', atMs: 1, action: 'hibernate', message: 'no' },
    { kind: 'cancelled', atMs: 1, reason: { id: 'user', via: 'osAlert' }, stillWatching: false, countdownKind: 'test' },
    { kind: 'cancelled', atMs: 1, reason: { id: 'sessionResumed', name: 'web' }, stillWatching: true, countdownKind: 'real' },
    { kind: 'stopped', atMs: 1, cause: 'timeJump', armedAtMs: null, wasReal: true },
  ];

  it('round-trips every kind of result', () => {
    for (const result of results) expect(parseLastResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('drops anything it does not fully understand', () => {
    for (const raw of [
      null,
      'done',
      {},
      { kind: 'done', atMs: 'yesterday', action: 'sleep' },
      { kind: 'done', atMs: 1, action: 'explode' },
      { kind: 'failed', atMs: 1, action: 'sleep' },
      { kind: 'cancelled', atMs: 1, reason: { id: 'aliens' }, stillWatching: true, countdownKind: 'real' },
      { kind: 'cancelled', atMs: 1, reason: { id: 'user', via: 'esc' }, stillWatching: true, countdownKind: 'fake' },
      { kind: 'stopped', atMs: 1, cause: 'bored', armedAtMs: 1, wasReal: true },
      { kind: 'mystery', atMs: 1 },
    ]) {
      expect(parseLastResult(raw)).toBeNull();
    }
  });

  it('reads optional fields strictly', () => {
    expect(parseLastResult({ kind: 'done', atMs: 1, action: 'lock', resumedAtMs: 'soon', confirmed: 'yes' })).toEqual({
      kind: 'done',
      atMs: 1,
      action: 'lock',
      resumedAtMs: null,
      confirmed: null,
    });
    expect(parseLastResult({ kind: 'stopped', atMs: 1, cause: 'windowClosed', armedAtMs: 'x', wasReal: 'true' })).toEqual({
      kind: 'stopped',
      atMs: 1,
      cause: 'windowClosed',
      armedAtMs: null,
      wasReal: false,
    });
    expect(parseCancelReason({ id: 'checkFailed' })).toBeNull();
    expect(parseCancelReason({ id: 'user' })).toEqual({ id: 'user', via: 'command' });
  });
});

describe('isDiscontinuity', () => {
  const at = (mono: number, wall: number) => ({ mono, wall });

  it('accepts ordinary ticks, a late tick and a little clock slew', () => {
    expect(isDiscontinuity(at(0, 1000), at(250, 1250))).toBe(false);
    expect(isDiscontinuity(at(0, 1000), at(1000, 2000))).toBe(false);
    expect(isDiscontinuity(at(0, 1000), at(5000, 6000))).toBe(false);
    expect(isDiscontinuity(at(0, 1000), at(1000, 4000))).toBe(false); // wall 2 s ahead: still agreed
    expect(isDiscontinuity(at(0, 1000), at(1000, 0))).toBe(false); // wall stepped back exactly 1 s
  });

  it('flags each of the four rules on its own', () => {
    expect(isDiscontinuity(at(0, 1000), at(5001, 6001))).toBe(true); // dMono > 5 s (and dWall)
    expect(isDiscontinuity(at(0, 1000), at(250, 6251))).toBe(true); // dWall > 5 s
    expect(isDiscontinuity(at(0, 1000), at(250, -1))).toBe(true); // dWall < -1 s
    expect(isDiscontinuity(at(0, 1000), at(250, 3251))).toBe(true); // |dWall - dMono| > 2 s
    expect(isDiscontinuity(at(0, 1000), at(4000, 1500))).toBe(true); // mono ran, wall did not
  });

  it('treats a clock that returns garbage as a discontinuity', () => {
    expect(isDiscontinuity(at(0, 1000), at(Number.NaN, 1250))).toBe(true);
    expect(isDiscontinuity(at(0, 1000), at(250, Number.POSITIVE_INFINITY))).toBe(true);
    expect(isDiscontinuity(at(1000, 1000), at(900, 1100))).toBe(true); // a "monotonic" clock going back
  });
});

describe('verdict helpers', () => {
  const check = (id: Check['id'], state: Check['state'], data: Check['data'] = {}): Check => ({ id, state, data });
  const verdict = (checks: Check[], k: number): Verdict => {
    const allClear = checks.every((entry) => entry.state === 'pass');
    return {
      checks: [...checks, check('confirmed', k >= 3 ? 'pass' : 'waiting', { k, n: 3 })],
      allClear,
      ok: allClear && k >= 3,
      stablePolls: k,
      requiredPolls: 3,
    };
  };

  it('withoutNewPoll restates the count the controller holds instead of counting again', () => {
    const counted = verdict([check('sessionsIdle', 'pass')], 3);
    const held = withoutNewPoll(counted, 2, 3);
    expect(held).toMatchObject({ allClear: true, ok: false, stablePolls: 2 });
    expect(held.checks.at(-1)).toEqual(check('confirmed', 'waiting', { k: 2, n: 3 }));

    expect(withoutNewPoll(counted, 3, 3)).toMatchObject({ ok: true, stablePolls: 3 });
    expect(withoutNewPoll(verdict([check('sessionsIdle', 'waiting')], 0), 3, 3)).toMatchObject({ ok: false, stablePolls: 0 });
    expect(withoutNewPoll(counted, 3, Number.NaN).ok).toBe(false);
  });

  it('cancelReasonFor picks the reason in a fixed order', () => {
    const everything = verdict(
      [check('stopFile', 'fail'), check('scanner', 'cantTell'), check('userIdle', 'waiting'), check('sessionsIdle', 'waiting')],
      0,
    );
    expect(cancelReasonFor(everything, busyScan('web'), true)).toEqual({ id: 'emergencyStop' });

    const stale = verdict([check('scanner', 'cantTell'), check('userIdle', 'waiting')], 0);
    expect(cancelReasonFor(stale, clearScan(), true)).toEqual({ id: 'scanStale' });
    expect(cancelReasonFor(stale, null, false)).toEqual({ id: 'checkFailed', check: 'scanner' });

    const userAndSession = verdict([check('userIdle', 'waiting'), check('sessionsIdle', 'waiting')], 0);
    expect(cancelReasonFor(userAndSession, busyScan('web'), false)).toEqual({ id: 'userCameBack' });

    const session = verdict([check('quiet', 'waiting')], 0);
    expect(cancelReasonFor(session, busyScan('web'), false)).toEqual({ id: 'sessionResumed', name: 'web' });
    // A session check failing without any working session (e.g. just finished, not quiet yet).
    expect(cancelReasonFor(session, clearScan(), false)).toEqual({ id: 'checkFailed', check: 'quiet' });

    const guard = verdict([check('guard', 'waiting')], 0);
    expect(cancelReasonFor(guard, busyScan('web'), false)).toEqual({ id: 'checkFailed', check: 'guard' });
  });
});
