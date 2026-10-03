import { describe, expect, it } from 'vitest';

import {
  isSafeCommand,
  leaderInfoOf,
  pollSecondsOf,
  readClientFrame,
  readCommand,
  readHandoverPayload,
  readLeaderInfo,
  readServerFrame,
  readState,
} from '../../src/coordination/wire';
import { contractDigest } from '../../src/shared/config';
import type { UiState } from '../../src/shared/protocol';
import { armedState, CONTRACT, makeHandover, makeHello, makeState } from './harness';

/** Values a broken or hostile peer might put where something else belongs. */
const JUNK: unknown[] = [undefined, null, NaN, Infinity, -1, 0, 1.5, '', 'text', true, [], {}, { length: 3 }];

describe('readClientFrame', () => {
  const hello = makeHello('w', { remote: 'WSL: Ubuntu' });

  it('reads a hello into the window it describes', () => {
    const nonce = '0123456789abcdef'.repeat(2);
    expect(readClientFrame({ t: 'hello', v: 1, ...hello, nonce, proof: 'p' })).toEqual({
      t: 'hello',
      v: 1,
      hello,
      nonce,
      proof: 'p',
    });
    expect(readClientFrame({ t: 'hello', v: 3, ...hello, remote: null, extra: 1 })).toEqual({
      t: 'hello',
      v: 3,
      hello: { ...hello, remote: null },
      nonce: null,
      proof: null,
    });
  });

  it('reads a hello whose nonce or proof is missing or junk as carrying none, for the leader to refuse', () => {
    for (const junk of [...JUNK, 'ABCDEF0123456789'.repeat(2), 'ab'.repeat(15), 'ab'.repeat(17), 'g'.repeat(32)]) {
      const frame = readClientFrame({ t: 'hello', v: 1, ...hello, nonce: junk, proof: junk });
      expect(frame).toMatchObject({ t: 'hello', hello, nonce: null });
      if (typeof junk !== 'string') expect(frame).toMatchObject({ proof: null });
    }
  });

  it.each(['v', 'windowId', 'pid', 'app', 'ext', 'realm', 'label', 'remote'])(
    'refuses a hello whose %s is missing',
    (field) => {
      const frame: Record<string, unknown> = { t: 'hello', v: 1, ...hello };
      delete frame[field];

      expect(readClientFrame(frame)).toBeNull();
    },
  );

  it('refuses a hello with junk where the identity belongs', () => {
    for (const junk of JUNK) {
      expect(readClientFrame({ t: 'hello', v: 1, ...hello, pid: junk })).toBeNull();
      if (junk !== 'text') expect(readClientFrame({ t: 'hello', v: 1, ...hello, windowId: junk })).toBeNull();
      if (typeof junk !== 'string') expect(readClientFrame({ t: 'hello', v: 1, ...hello, label: junk })).toBeNull();
      if (typeof junk !== 'number' || !Number.isFinite(junk)) {
        expect(readClientFrame({ t: 'hello', v: junk, ...hello })).toBeNull();
      }
    }
  });

  it('never mistakes an unreadable remote for a local window', () => {
    for (const junk of JUNK) {
      if (junk === null || typeof junk === 'string') continue;
      expect(readClientFrame({ t: 'hello', v: 1, ...hello, remote: junk })).toBeNull();
    }
  });

  it('cuts over-long display text instead of refusing the window', () => {
    const frame = readClientFrame({ t: 'hello', v: 1, ...hello, label: 'x'.repeat(5000) });

    expect(frame).toMatchObject({ t: 'hello', hello: { label: 'x'.repeat(256) } });
  });

  it('reads view, handoverAck and cmd, and nothing with the wrong types', () => {
    expect(readClientFrame({ t: 'view', visible: true })).toEqual({ t: 'view', visible: true });
    expect(readClientFrame({ t: 'view', visible: 1 })).toBeNull();
    expect(readClientFrame({ t: 'handoverAck', ok: false })).toEqual({ t: 'handoverAck', ok: false });
    expect(readClientFrame({ t: 'handoverAck', ok: 'true' })).toBeNull();
    const command = { t: 'cmd', id: 'a', cmd: { name: 'x' } };
    expect(readClientFrame(command)).toEqual(command);
    expect(readClientFrame({ t: 'cmd', id: 7, cmd: { name: 'disarm' } })).toBeNull();
    expect(readClientFrame({ t: 'cmd', id: 'x'.repeat(129), cmd: { name: 'disarm' } })).toBeNull();
  });

  it('does not know messages of another type', () => {
    expect(readClientFrame({ t: 'welcome', v: 1 })).toBeNull();
    expect(readClientFrame({ t: 'yield' })).toBeNull();
    expect(readClientFrame({})).toBeNull();
  });
});

describe('readCommand', () => {
  const arm = { name: 'arm', contract: CONTRACT, digest: contractDigest(CONTRACT), epoch: 'e1', realm: 'r1' };

  it('reads every command and keeps only its own fields', () => {
    expect(readCommand({ name: 'disarm', extra: 1 })).toEqual({ name: 'disarm' });
    expect(readCommand({ name: 'cancel', via: 'osAlert' })).toEqual({ name: 'cancel', via: 'osAlert' });
    expect(readCommand({ name: 'refresh' })).toEqual({ name: 'refresh' });
    expect(readCommand({ name: 'preview' })).toEqual({ name: 'preview' });
    expect(readCommand({ name: 'dismissResult' })).toEqual({ name: 'dismissResult' });
    const ignore = { name: 'ignore', key: 'proc:1:2', on: false };
    expect(readCommand({ ...ignore, extra: 1 })).toEqual(ignore);
    expect(readCommand({ name: 'settingsChanged', realm: 'r', digest: 'd' })).toEqual({
      name: 'settingsChanged',
      realm: 'r',
      digest: 'd',
    });
    expect(readCommand(arm)).toEqual(arm);
  });

  it('reads Cancel and Stop whatever else the message contains', () => {
    for (const junk of JUNK) {
      expect(readCommand({ name: 'cancel', via: junk })).toEqual({ name: 'cancel', via: 'command' });
      expect(readCommand({ name: 'disarm', via: junk, contract: junk })).toEqual({ name: 'disarm' });
    }
  });

  it('refuses an arm unless the contract passes validation untouched', () => {
    expect(readCommand({ ...arm, contract: { ...CONTRACT, quietSeconds: 1 } })).toBeNull();
    expect(readCommand({ ...arm, contract: { ...CONTRACT, action: 'explode' } })).toBeNull();
    expect(readCommand({ ...arm, contract: { ...CONTRACT, testMode: 'maybe' } })).toBeNull();
    const { pollSeconds: _dropped, ...incomplete } = CONTRACT;
    expect(readCommand({ ...arm, contract: incomplete })).toBeNull();
    for (const junk of JUNK) {
      expect(readCommand({ ...arm, contract: junk })).toBeNull();
      if (typeof junk !== 'string') {
        expect(readCommand({ ...arm, digest: junk })).toBeNull();
        expect(readCommand({ ...arm, epoch: junk })).toBeNull();
        expect(readCommand({ ...arm, realm: junk })).toBeNull();
      }
    }
  });

  it('refuses what is not a command', () => {
    for (const junk of JUNK) expect(readCommand(junk)).toBeNull();
    expect(readCommand({ name: 'executeNow' })).toBeNull();
    expect(readCommand({ name: 'ignore', key: 'k' })).toBeNull();
    expect(readCommand({ name: 'ignore', key: 'k'.repeat(2000), on: true })).toBeNull();
    expect(readCommand({ name: 'settingsChanged', realm: 'r' })).toBeNull();
  });

  it('knows which commands are safe to repeat', () => {
    expect(isSafeCommand({ name: 'disarm' })).toBe(true);
    expect(isSafeCommand({ name: 'cancel', via: 'esc' })).toBe(true);
    expect(isSafeCommand({ name: 'refresh' })).toBe(false);
    expect(isSafeCommand(readCommand(arm)!)).toBe(false);
  });
});

describe('readServerFrame', () => {
  it('reads an ack only when it says clearly whether the command was done', () => {
    expect(readServerFrame({ t: 'ack', id: 'a', ok: true, error: 'ignored' })).toEqual({
      t: 'ack',
      id: 'a',
      result: { ok: true },
    });
    expect(readServerFrame({ t: 'ack', id: 'a', ok: false, error: 'No.' })).toEqual({
      t: 'ack',
      id: 'a',
      result: { ok: false, error: 'No.' },
    });
    expect(readServerFrame({ t: 'ack', id: 'a', ok: false })).toEqual({
      t: 'ack',
      id: 'a',
      result: { ok: false, error: 'The window in control refused.' },
    });
    for (const junk of JUNK) {
      if (typeof junk === 'boolean') continue;
      expect(readServerFrame({ t: 'ack', id: 'a', ok: junk })).toBeNull();
    }
    expect(readServerFrame({ t: 'ack', ok: true })).toBeNull();
  });

  it('reads a goodbye as naming nobody unless the successor is a clear id', () => {
    expect(readServerFrame({ t: 'leaving', successor: 'w1' })).toEqual({ t: 'leaving', successor: 'w1' });
    for (const junk of JUNK) {
      if (junk === 'text') continue;
      expect(readServerFrame({ t: 'leaving', successor: junk })).toEqual({ t: 'leaving', successor: null });
    }
  });

  it('needs a version number in a welcome and leaves the rest for later', () => {
    const welcome = { t: 'welcome', v: 2, leader: 1, state: 2 };
    expect(readServerFrame({ ...welcome, epoch: 'e', proof: 'p' })).toEqual({ ...welcome, epoch: 'e', proof: 'p' });
    expect(readServerFrame(welcome)).toEqual({ ...welcome, epoch: null, proof: null });
    for (const junk of JUNK) {
      if (typeof junk === 'string') continue;
      const unproven = { ...welcome, epoch: null, proof: null };
      expect(readServerFrame({ ...welcome, epoch: junk, proof: junk })).toEqual(unproven);
    }
    expect(readServerFrame({ t: 'welcome', v: '1', leader: {}, state: {} })).toBeNull();
    expect(readServerFrame({ t: 'welcome', v: NaN })).toBeNull();
  });

  it('does not know messages of another type', () => {
    expect(readServerFrame({ t: 'hello' })).toBeNull();
    expect(readServerFrame({ t: 'ping' })).toBeNull();
    expect(readServerFrame({})).toBeNull();
  });
});

describe('readState', () => {
  it('accepts a complete state of this version', () => {
    const state = armedState();

    expect(readState(state, false)).toBe(state);
    const countdown = { id: 'c', kind: 'test', action: 'lock', totalMs: 9, remainingMs: 4 };
    expect(readState({ ...state, countdown }, false)).not.toBeNull();
  });

  it('accepts the two values that mean "unknown" by design', () => {
    expect(readState({ ...makeState(), strays: null, countdown: null }, false)).not.toBeNull();
  });

  it.each([
    'phase',
    'armed',
    'contract',
    'confirm',
    'scan',
    'platform',
    'stop',
    'leader',
    'checks',
    'sessions',
    'strays',
    'remoteWindows',
    'activity',
    'countdown',
  ])(
    'refuses a state of this version whose %s is missing or junk',
    (field) => {
      const missing: Record<string, unknown> = { ...makeState() };
      delete missing[field];
      expect(readState(missing, false)).toBeNull();
      for (const junk of ['text', 7, NaN]) expect(readState({ ...makeState(), [field]: junk }, false)).toBeNull();
    },
  );

  it('needs the count of sessions left out to be a whole number of at least 0', () => {
    expect(readState({ ...makeState(), sessionsOmitted: 12 }, false)).not.toBeNull();
    const missing: Record<string, unknown> = { ...makeState() };
    delete missing.sessionsOmitted;
    expect(readState(missing, false)).toBeNull();
    for (const junk of [...JUNK, 2.5, -3, Number.MAX_SAFE_INTEGER + 2]) {
      if (junk === 0) continue;
      expect(readState({ ...makeState(), sessionsOmitted: junk }, false)).toBeNull();
    }
    expect(readState({ phase: 'off' }, true)).not.toBeNull();
  });

  it('refuses a countdown without a finite remaining time', () => {
    for (const remainingMs of [undefined, null, NaN, Infinity, '5']) {
      expect(readState({ ...makeState(), countdown: { remainingMs } }, false)).toBeNull();
    }
  });

  it('from another version needs nothing but a phase', () => {
    expect(readState({ phase: 'somethingNew' }, true)).toEqual({ phase: 'somethingNew' });
    expect(readState({ phase: 'somethingNew' }, false)).toBeNull();
    expect(readState({ armed: true }, true)).toBeNull();
    expect(readState({ phase: 3 }, true)).toBeNull();
    for (const junk of JUNK) expect(readState(junk, true)).toBeNull();
  });

  it('finds the poll interval only when it is a usable number', () => {
    expect(pollSecondsOf(makeState())).toBe(CONTRACT.pollSeconds);
    for (const pollSeconds of [undefined, null, NaN, Infinity, 0, -5, '10']) {
      const state = { ...makeState(), contract: { ...CONTRACT, pollSeconds } } as unknown as UiState;
      expect(pollSecondsOf(state)).toBeNull();
    }
    expect(pollSecondsOf({ phase: 'off' } as unknown as UiState)).toBeNull();
  });
});

describe('readLeaderInfo', () => {
  it('reads the identity of a leader and nothing doubtful', () => {
    const hello = makeHello('leader', { remote: 'SSH: box' });
    const info = leaderInfoOf(hello);

    expect(info).toEqual({
      windowId: hello.windowId,
      label: 'leader',
      app: hello.app,
      ext: hello.ext,
      pid: hello.pid,
      realm: hello.realm,
    });
    expect(readLeaderInfo(info)).toEqual(info);
    expect(readLeaderInfo({ ...info, pid: '1' })).toBeNull();
    expect(readLeaderInfo({ ...info, windowId: '' })).toBeNull();
    for (const junk of JUNK) expect(readLeaderInfo(junk)).toBeNull();
  });
});

describe('readHandoverPayload', () => {
  it('reads a complete payload', () => {
    expect(readHandoverPayload(makeHandover())).toEqual(makeHandover());
    expect(readHandoverPayload(makeHandover({ sinceLastSessionMs: null, ignores: [] }))).toEqual(
      makeHandover({ sinceLastSessionMs: null, ignores: [] }),
    );
  });

  it.each([
    'contract',
    'contractRealm',
    'armedAtMs',
    'sawAnySession',
    'sinceLastSessionMs',
    'cooldownRemainingMs',
    'ignores',
  ])(
    'refuses a payload whose %s is missing or junk',
    (field) => {
      const missing: Record<string, unknown> = { ...makeHandover() };
      delete missing[field];
      expect(readHandoverPayload(missing)).toBeNull();
      for (const junk of [NaN, Infinity, -1, 'text', {}, [1]]) {
        if (field === 'contractRealm' && junk === 'text') continue;
        if (field === 'armedAtMs' && junk === -1) continue;
        expect(readHandoverPayload({ ...makeHandover(), [field]: junk })).toBeNull();
      }
    },
  );

  it('refuses a payload whose contract would have to be corrected', () => {
    expect(readHandoverPayload(makeHandover({ contract: { ...CONTRACT, countdownSeconds: 1 } }))).toBeNull();
    for (const junk of JUNK) expect(readHandoverPayload(junk)).toBeNull();
  });
});
