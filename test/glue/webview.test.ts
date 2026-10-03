// The webview boundary: the page's HTML, and everything a page can post to the host.

import { describe, expect, it, vi } from 'vitest';

import { CONFIG_KEYS, POWER_ACTIONS } from '../../src/shared/config';
import type { HostToWebview, UiState, ViewContext, WebviewToHost } from '../../src/shared/protocol';
import { DashboardSurface } from '../../src/ui/dashboardSurface';
import { contentSecurityPolicy, createNonce, dashboardHtml } from '../../src/ui/webviewHtml';
import { isListedTranscript, parseWebviewMessage, previewTarget } from '../../src/ui/webviewMessages';
import { contract, session, uiState } from './fixtures';

const TRANSCRIPT = 'C:\\fixture\\projects\\p\\abc.jsonl';
const SUBAGENT = 'C:\\fixture\\projects\\p\\abc\\subagents\\agent-a1.jsonl';

function stateWithSession(): UiState {
  return uiState({
    sessions: [
      session({
        key: 'row-1',
        transcriptPath: TRANSCRIPT,
        subagents: [{ name: 'agent-a1', path: SUBAGENT, mtimeMs: 1, turn: 'OPEN', active: true }],
      }),
      session({ key: 'row-2', sessionId: 'def', transcriptPath: null }),
    ],
  });
}

describe('dashboardHtml', () => {
  const page = {
    cspSource: 'https://file.vscode-cdn.example',
    scriptUri: 'https://file.vscode-cdn.example/dist/webview/main.js',
    styleUris: ['https://file.vscode-cdn.example/dist/webview/codicon.css', 'https://file.vscode-cdn.example/dist/webview/main.css'],
    nonce: 'Tm9uY2VOb25jZU5vbmNl',
  };

  it('allows nothing by default, and scripts only with the nonce', () => {
    const policy = contentSecurityPolicy(page.cspSource, page.nonce);
    const directives = Object.fromEntries(policy.split('; ').map((directive) => [directive.split(' ')[0], directive.split(' ').slice(1)]));
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['script-src']).toEqual([`'nonce-${page.nonce}'`]);
    expect(directives['style-src']).toEqual([page.cspSource]);
    expect(directives['font-src']).toEqual([page.cspSource]);
    expect(Object.keys(directives).sort()).toEqual(['default-src', 'font-src', 'script-src', 'style-src']);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|https?:\/\/(?!file\.vscode-cdn\.example)/);
  });

  it('carries the policy, one script tag with the nonce, and no inline script or style', () => {
    const html = dashboardHtml(page);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(page.cspSource, page.nonce)}"`);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[0]).toContain(`nonce="${page.nonce}"`);
    expect(scripts[0]?.[0]).toContain(`src="${page.scriptUri}"`);
    expect(scripts[0]?.[1]).toBe('');
    expect(html).not.toMatch(/<style|style=|onload=|onclick=|javascript:/i);
    expect(html).toContain('<div id="root"></div>');
    for (const uri of page.styleUris) expect(html).toContain(`<link rel="stylesheet" href="${uri}" />`);
  });

  it('escapes what it puts into attributes', () => {
    const html = dashboardHtml({ ...page, scriptUri: 'https://x/"><script>alert(1)</script>' });
    expect([...html.matchAll(/<script\b/g)]).toHaveLength(1);
  });

  it('makes a new, unguessable nonce for every page', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
  });
});

describe('parseWebviewMessage', () => {
  it.each(['ready', 'start', 'stop', 'cancel', 'refresh', 'preview', 'dismissResult', 'showLog', 'openLogFile', 'revealStop', 'openWalkthrough', 'lastRun'] as const)(
    'passes %s on with nothing but its type',
    (type) => {
      expect(parseWebviewMessage({ type, contract: { testMode: false }, via: 'esc', path: 'C:\\secret' })).toEqual({ type });
    },
  );

  it.each([null, undefined, 42, 'start', [], {}, { type: 7 }, { type: 'arm' }, { type: 'executeNow' }, { type: 'skipCountdown' }, { type: '__proto__' }])(
    'drops %j',
    (raw) => {
      expect(parseWebviewMessage(raw)).toBeNull();
    },
  );

  it('accepts only known actions for setAction', () => {
    for (const action of POWER_ACTIONS) expect(parseWebviewMessage({ type: 'setAction', action })).toEqual({ type: 'setAction', action });
    for (const action of ['reboot', '', null, undefined, 3, ['shutdown']]) {
      expect(parseWebviewMessage({ type: 'setAction', action })).toBeNull();
    }
  });

  it('accepts only a boolean for setTestMode: "false" must not switch the test run off', () => {
    expect(parseWebviewMessage({ type: 'setTestMode', testMode: true })).toEqual({ type: 'setTestMode', testMode: true });
    expect(parseWebviewMessage({ type: 'setTestMode', testMode: false })).toEqual({ type: 'setTestMode', testMode: false });
    for (const testMode of ['false', 0, null, undefined, {}]) expect(parseWebviewMessage({ type: 'setTestMode', testMode })).toBeNull();
  });

  it('accepts only the three kinds of "don\'t wait for this" key', () => {
    for (const key of ['session:0:9120:abc:10:2:0', 'proc:4321:133', 'remote:SSH: build-box']) {
      expect(parseWebviewMessage({ type: 'ignore', key, on: true })).toEqual({ type: 'ignore', key, on: true });
    }
    for (const key of ['', 'session:', 'all', 'check:quiet', 7, null, `proc:${'9'.repeat(2000)}`]) {
      expect(parseWebviewMessage({ type: 'ignore', key, on: true })).toBeNull();
    }
    expect(parseWebviewMessage({ type: 'ignore', key: 'proc:1:2', on: 'yes' })).toBeNull();
  });

  it('opens Settings at a known setting, or at none', () => {
    for (const setting of CONFIG_KEYS) expect(parseWebviewMessage({ type: 'openSettings', setting })).toEqual({ type: 'openSettings', setting });
    expect(parseWebviewMessage({ type: 'openSettings' })).toEqual({ type: 'openSettings' });
    expect(parseWebviewMessage({ type: 'openSettings', setting: 'security.workspace.trust.enabled' })).toEqual({ type: 'openSettings' });
    expect(parseWebviewMessage({ type: 'openSettings', setting: 12 })).toEqual({ type: 'openSettings' });
  });

  it('checks the fields of a preview request', () => {
    expect(parseWebviewMessage({ type: 'requestPreview', key: 'row-1' })).toEqual({ type: 'requestPreview', key: 'row-1' });
    expect(parseWebviewMessage({ type: 'requestPreview', key: 'row-1', path: TRANSCRIPT })).toEqual({ type: 'requestPreview', key: 'row-1', path: TRANSCRIPT });
    expect(parseWebviewMessage({ type: 'requestPreview' })).toBeNull();
    expect(parseWebviewMessage({ type: 'requestPreview', key: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'requestPreview', key: 'row-1', path: 9 })).toBeNull();
    expect(parseWebviewMessage({ type: 'requestPreview', key: 'row-1', path: 'x'.repeat(5000) })).toBeNull();
  });

  it('checks the path of openTranscript', () => {
    expect(parseWebviewMessage({ type: 'openTranscript', path: TRANSCRIPT })).toEqual({ type: 'openTranscript', path: TRANSCRIPT });
    for (const path of [undefined, null, '', 5, [TRANSCRIPT]]) expect(parseWebviewMessage({ type: 'openTranscript', path })).toBeNull();
  });
});

describe('transcript paths', () => {
  it('knows only the transcripts the current state lists', () => {
    const state = stateWithSession();
    expect(isListedTranscript(state, TRANSCRIPT)).toBe(true);
    expect(isListedTranscript(state, SUBAGENT)).toBe(true);
    expect(isListedTranscript(state, 'C:\\Users\\me\\.ssh\\id_ed25519')).toBe(false);
    expect(isListedTranscript(state, `${TRANSCRIPT}\\..\\..\\secret.txt`)).toBe(false);
    expect(isListedTranscript(state, TRANSCRIPT.toLowerCase())).toBe(false);
    expect(isListedTranscript(state, '')).toBe(false);
  });

  it('knows no path at all without a state', () => {
    expect(isListedTranscript(null, TRANSCRIPT)).toBe(false);
    expect(previewTarget(null, 'row-1', undefined)).toBeNull();
    expect(previewTarget(null, 'row-1', TRANSCRIPT)).toBeNull();
  });

  it('reads the own transcript of the session when no path is named', () => {
    const state = stateWithSession();
    expect(previewTarget(state, 'row-1', undefined)).toBe(TRANSCRIPT);
    expect(previewTarget(state, 'row-2', undefined)).toBeNull();
    expect(previewTarget(state, 'no-such-row', undefined)).toBeNull();
  });

  it('reads a named path only when the state lists it', () => {
    const state = stateWithSession();
    expect(previewTarget(state, 'row-1', SUBAGENT)).toBe(SUBAGENT);
    expect(previewTarget(state, 'row-1', 'C:\\Windows\\win.ini')).toBeNull();
    // A path that was listed a moment ago is refused once the state no longer lists it.
    expect(previewTarget(uiState(), 'row-1', TRANSCRIPT)).toBeNull();
  });

  it('copes with a state whose session list is not a list', () => {
    const broken = { ...uiState(), sessions: 'none' } as unknown as UiState;
    expect(isListedTranscript(broken, TRANSCRIPT)).toBe(false);
    const odd = { ...uiState(), sessions: [null, 7, { key: 'row-1', transcriptPath: 9, subagents: 'x' }] } as unknown as UiState;
    expect(previewTarget(odd, 'row-1', undefined)).toBeNull();
  });
});

describe('DashboardSurface', () => {
  const view: ViewContext = {
    role: 'leader',
    limited: false,
    plan: contract(),
    windowLabel: 'api-refactor',
    unsavedFiles: 0,
    pending: null,
    autoStopSet: false,
  };

  function build(visible = true) {
    const posted: HostToWebview[] = [];
    const received: WebviewToHost[] = [];
    const page = { visible, state: uiState() as UiState | null };
    const surface = new DashboardSurface(
      { post: (message) => posted.push(message), isVisible: () => page.visible },
      { content: () => ({ state: page.state, view }), message: (message) => received.push(message) },
    );
    return { surface, posted, received, page };
  }

  it('sends nothing before the page says it is ready', () => {
    const { surface, posted } = build();
    surface.sendState();
    surface.visibilityChanged();
    surface.post({ type: 'focusPlan' });
    expect(posted).toEqual([]);
  });

  it('answers "ready" with the current state', () => {
    const { surface, posted, page } = build();
    surface.receive({ type: 'ready' });
    expect(posted).toEqual([{ type: 'state', state: page.state, view }]);
  });

  it('sends the state again when the page becomes visible, and never to a hidden page', () => {
    const { surface, posted, page } = build();
    surface.receive({ type: 'ready' });
    page.visible = false;
    surface.visibilityChanged();
    surface.sendState();
    surface.post({ type: 'focusPlan' });
    expect(posted).toHaveLength(1);
    page.visible = true;
    surface.visibilityChanged();
    expect(posted).toHaveLength(2);
  });

  it('asks for the state at every send, so a page never gets an older one', () => {
    const { surface, posted, page } = build();
    surface.receive({ type: 'ready' });
    page.state = null;
    surface.sendState();
    expect(posted[1]).toEqual({ type: 'state', state: null, view });
  });

  it('checks every message from the page before anything acts on it', () => {
    const { surface, received } = build();
    for (const raw of [{ type: 'arm' }, 'stop', null, { type: 'setTestMode', testMode: 'false' }, { type: 'openTranscript' }]) surface.receive(raw);
    expect(received).toEqual([]);
    surface.receive({ type: 'cancel', extra: true });
    surface.receive({ type: 'setTestMode', testMode: false });
    expect(received).toEqual([{ type: 'cancel' }, { type: 'setTestMode', testMode: false }]);
  });

  it('acts on a Cancel from a page that never said "ready"', () => {
    const { surface, received } = build();
    surface.receive({ type: 'cancel' });
    expect(received).toEqual([{ type: 'cancel' }]);
  });

  it('hands the surface to the listener, so a reply goes to the page that asked', () => {
    const posted: HostToWebview[] = [];
    const listener = vi.fn((message: WebviewToHost, from: DashboardSurface) => {
      if (message.type === 'requestPreview') from.post({ type: 'preview', key: message.key, events: [], error: null });
    });
    const surface = new DashboardSurface(
      { post: (message) => posted.push(message), isVisible: () => true },
      { content: () => ({ state: null, view }), message: listener },
    );
    surface.receive({ type: 'ready' });
    surface.receive({ type: 'requestPreview', key: 'row-1' });
    expect(listener.mock.calls.map(([message]) => message.type)).toEqual(['ready', 'requestPreview']);
    expect(posted[1]).toEqual({ type: 'preview', key: 'row-1', events: [], error: null });
  });
});
