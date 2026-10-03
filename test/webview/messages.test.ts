import { describe, expect, it } from 'vitest';
import { isWebviewMessage } from '../../src/shared/protocol';
import type { WebviewToHost } from '../../src/shared/protocol';
import { control, present, sending, worksHere } from '../../src/webview/actions';
import { isIgnoreKey, parseHostMessage, toHost, worksWhenLimited } from '../../src/webview/messages';
import { sanitizeView } from '../../src/webview/sanitize';
import { stateOf } from './support';

describe('messages to the host', () => {
  it('builds each plain message in the shape the protocol names', () => {
    const plain: [WebviewToHost | null, WebviewToHost['type']][] = [
      [toHost.ready(), 'ready'],
      [toHost.start(), 'start'],
      [toHost.stop(), 'stop'],
      [toHost.cancel(), 'cancel'],
      [toHost.refresh(), 'refresh'],
      [toHost.preview(), 'preview'],
      [toHost.dismissResult(), 'dismissResult'],
      [toHost.showLog(), 'showLog'],
      [toHost.openLogFile(), 'openLogFile'],
      [toHost.revealStop(), 'revealStop'],
      [toHost.openWalkthrough(), 'openWalkthrough'],
      [toHost.lastRun(), 'lastRun'],
    ];
    for (const [message, type] of plain) expect(message).toEqual({ type });
  });

  it('builds only messages the host recognises', () => {
    const built = [
      toHost.ready(),
      toHost.setAction('sleep'),
      toHost.setTestMode(false),
      toHost.ignore('proc:1:2', true),
      toHost.openSettings('quietSeconds'),
      toHost.openSettings(),
      toHost.requestPreview('0:1:a'),
      toHost.openTranscript('C:\\fixture\\a.jsonl'),
    ];
    for (const message of built) expect(isWebviewMessage(message)).toBe(true);
  });

  it('carries the chosen action and mode', () => {
    expect(toHost.setAction('hibernate')).toEqual({ type: 'setAction', action: 'hibernate' });
    expect(toHost.setTestMode(true)).toEqual({ type: 'setTestMode', testMode: true });
    expect(toHost.setTestMode(false)).toEqual({ type: 'setTestMode', testMode: false });
  });

  it('refuses to build a setAction for anything that is not one of the five actions', () => {
    for (const bad of ['reboot', '', 'SHUTDOWN', undefined, null, 3, {}]) expect(toHost.setAction(bad)).toBeNull();
  });

  it('refuses to build a setTestMode from anything but a boolean', () => {
    for (const bad of ['false', 0, 1, null, undefined]) expect(toHost.setTestMode(bad)).toBeNull();
  });

  it('builds "don\'t wait" only for the kinds of key the leader accepts', () => {
    expect(toHost.ignore('session:0:9120:abc:1:2:0', true)).toEqual({ type: 'ignore', key: 'session:0:9120:abc:1:2:0', on: true });
    expect(toHost.ignore('proc:4321:1338', false)).toEqual({ type: 'ignore', key: 'proc:4321:1338', on: false });
    expect(toHost.ignore('remote:SSH: build-box', true)).toEqual({ type: 'ignore', key: 'remote:SSH: build-box', on: true });
    for (const bad of ['', 'session:', 'proc:', 'remote:', 'window:1', 'SESSION:1', ' session:1', undefined, null, 42, {}]) {
      expect(isIgnoreKey(bad)).toBe(false);
      expect(toHost.ignore(bad, true)).toBeNull();
    }
  });

  it('opens one setting by id, and all settings for an id it does not know', () => {
    expect(toHost.openSettings('userIdleSeconds')).toEqual({ type: 'openSettings', setting: 'userIdleSeconds' });
    expect(toHost.openSettings()).toEqual({ type: 'openSettings' });
    expect(toHost.openSettings('__proto__')).toEqual({ type: 'openSettings' });
    expect(toHost.openSettings('workbench.colorTheme')).toEqual({ type: 'openSettings' });
  });

  it('asks for a preview or a transcript only with something to name', () => {
    expect(toHost.requestPreview('0:9120:abc')).toEqual({ type: 'requestPreview', key: '0:9120:abc' });
    expect(toHost.openTranscript('C:\\fixture\\a.jsonl')).toEqual({ type: 'openTranscript', path: 'C:\\fixture\\a.jsonl' });
    for (const bad of ['', '   ', null, undefined, 7]) {
      expect(toHost.requestPreview(bad)).toBeNull();
      expect(toHost.openTranscript(bad)).toBeNull();
    }
  });
});

describe('actions built from messages', () => {
  it('is an action only when every message could be built', () => {
    expect(sending(toHost.stop())).toEqual({ do: 'send', messages: [{ type: 'stop' }] });
    expect(sending(toHost.ignore('remote:a', true), toHost.ignore('remote:b', true))?.do).toBe('send');
    expect(sending(toHost.ignore('remote:a', true), toHost.ignore('garbage', true))).toBeNull();
    expect(sending()).toBeNull();
    expect(control('Stop', null)).toBeNull();
    expect(present([null, 1, null, 2])).toEqual([1, 2]);
  });

  it('from a limited window, only Cancel, Stop and what the host answers by itself still work', () => {
    const works: WebviewToHost[] = [
      toHost.stop(),
      toHost.cancel(),
      toHost.showLog(),
      toHost.openLogFile(),
      toHost.revealStop(),
      toHost.openSettings(),
      toHost.openWalkthrough(),
      toHost.lastRun(),
      { type: 'requestPreview', key: 'a' },
      { type: 'openTranscript', path: 'a' },
    ];
    const dead: WebviewToHost[] = [
      toHost.start(),
      toHost.refresh(),
      toHost.preview(),
      toHost.dismissResult(),
      { type: 'setAction', action: 'sleep' },
      { type: 'setTestMode', testMode: false },
      { type: 'ignore', key: 'proc:1:1', on: true },
    ];
    for (const message of works) expect(worksWhenLimited(message), message.type).toBe(true);
    for (const message of dead) expect(worksWhenLimited(message), message.type).toBe(false);

    const limited = sanitizeView({ limited: true });
    const ordinary = sanitizeView({ limited: false });
    expect(worksHere({ do: 'send', messages: [toHost.stop()] }, limited)).toBe(true);
    expect(worksHere({ do: 'send', messages: [toHost.stop(), toHost.start()] }, limited)).toBe(false);
    expect(worksHere({ do: 'focusPlan' }, limited)).toBe(false);
    expect(worksHere({ do: 'switchToReal' }, limited)).toBe(false);
    expect(worksHere({ do: 'focusPlan' }, ordinary)).toBe(true);
    expect(worksHere({ do: 'send', messages: [toHost.start()] }, ordinary)).toBe(true);
  });
});

describe('messages from the host', () => {
  it('accepts a state message and keeps a null state null', () => {
    const state = stateOf('watching-real');
    const parsed = parseHostMessage({ type: 'state', state, view: { role: 'leader' } });
    expect(parsed?.type).toBe('state');
    if (parsed?.type !== 'state') return;
    expect(parsed.state?.phase).toBe('watching');
    expect(parsed.view.role).toBe('leader');
    const lost = parseHostMessage({ type: 'state', state: null, view: { role: 'follower' } });
    expect(lost).toMatchObject({ type: 'state', state: null });
  });

  it('turns a state without a phase into "no state" instead of rendering a guess', () => {
    for (const bad of [{}, { phase: 7 }, 'watching', 42, [], undefined]) {
      expect(parseHostMessage({ type: 'state', state: bad, view: {} })).toMatchObject({ type: 'state', state: null });
    }
  });

  it('accepts a preview, cleaning its events', () => {
    const parsed = parseHostMessage({
      type: 'preview',
      key: '0:1:a',
      events: [{ time: '02:11:04', who: 'claude', sidechain: false, text: 'Bash: npm test', kind: 'tool' }, 'junk', { who: 'robot', text: 5 }],
      error: null,
    });
    expect(parsed).toEqual({
      type: 'preview',
      key: '0:1:a',
      events: [
        { time: '02:11:04', who: 'claude', sidechain: false, text: 'Bash: npm test', kind: 'tool' },
        { time: '', who: 'other', sidechain: false, text: '', kind: 'other' },
      ],
      error: null,
    });
  });

  it('keeps a preview error, and drops a preview without a key', () => {
    expect(parseHostMessage({ type: 'preview', key: 'a', events: 'none', error: "Couldn't read the transcript." })).toEqual({
      type: 'preview',
      key: 'a',
      events: [],
      error: "Couldn't read the transcript.",
    });
    expect(parseHostMessage({ type: 'preview', events: [] })).toBeNull();
  });

  it('accepts focusPlan', () => {
    expect(parseHostMessage({ type: 'focusPlan', extra: 1 })).toEqual({ type: 'focusPlan' });
  });

  it('drops everything else', () => {
    for (const junk of [null, undefined, 'state', 7, [], {}, { type: 'reboot' }, { type: 5 }, { harnessLog: { type: 'start' } }]) {
      expect(parseHostMessage(junk)).toBeNull();
    }
  });
});
