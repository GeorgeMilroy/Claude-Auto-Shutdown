// Runs inside the harness frame, before the dashboard bundle. It stands in for VS Code: it sets
// the theme variables and body classes the way VS Code does, defines acquireVsCodeApi(), and plays
// a small fake extension host that answers the dashboard's messages from the fixture catalogue.
//
// Query parameters: ?fixture=<id>&theme=<dark|light|hc-dark|hc-light>&surface=<sideBar|editor|panel>&motion=reduce

import type { Session } from '../src/core/types';
import type { HostToWebview, UiState, WebviewToHost } from '../src/shared/protocol';
import { isWebviewMessage } from '../src/shared/protocol';
import { fixtureById } from './fixtures';
import type { FixtureData } from './fixtures';
import { themeById } from './themes';
import type { ThemePreset } from './themes';

type Surface = keyof ThemePreset['surfaces'];

export interface FrameHarness {
  show(fixtureId: string): void;
  setTheme(themeId: string, surface: string): void;
  setReducedMotion(on: boolean): void;
  focusPlan(): void;
}

declare global {
  interface Window {
    harness?: FrameHarness;
    acquireVsCodeApi?: () => { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
  }
}

const params = new URLSearchParams(window.location.search);
const STATE_KEY = 'cas-harness-webview-state';
/** How long the fake host takes to answer, so loading states are visible for a moment. */
const HOST_DELAY_MS = 120;

let current: FixtureData = fixtureById(params.get('fixture')).build(Date.now());
let appliedVars: string[] = [];

function asSurface(value: string | null): Surface {
  return value === 'editor' || value === 'panel' ? value : 'sideBar';
}

function applyTheme(themeId: string | null, surface: string | null): void {
  const theme = themeById(themeId);
  const root = document.documentElement;
  for (const name of appliedVars) root.style.removeProperty(name);
  appliedVars = Object.keys(theme.vars);
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  // The webview itself is transparent; this is the workbench surface behind it.
  root.style.backgroundColor = theme.surfaces[asSurface(surface)];
  const body = document.body;
  body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light');
  body.classList.add(...theme.bodyClasses);
  body.dataset.vscodeThemeKind = theme.kind;
}

function toDashboard(message: HostToWebview): void {
  window.postMessage(message, window.location.origin);
}

function postState(): void {
  toDashboard({ type: 'state', state: current.state, view: current.view });
}

function logToHarness(message: unknown): void {
  window.parent.postMessage({ harnessLog: message }, window.location.origin);
}

// --- the fake extension host -------------------------------------------------------------------

function withState(change: (state: UiState) => UiState): void {
  if (current.state !== null) current = { ...current, state: change(current.state) };
}

function setIgnored(state: UiState, key: string, on: boolean): UiState {
  const sessions: Session[] = state.sessions.map((session) => ({
    ...session,
    ignored: session.ignoreKey === key ? on : session.ignored,
    children: session.children.map((child) => (child.ignoreKey === key ? { ...child, ignored: on } : child)),
  }));
  return {
    ...state,
    sessions,
    strays: state.strays?.map((stray) => (stray.ignoreKey === key ? { ...stray, ignored: on } : stray)) ?? null,
    remoteWindows: state.remoteWindows.map((remote) => (remote.ignoreKey === key ? { ...remote, ignored: on } : remote)),
  };
}

function stopWatching(state: UiState): UiState {
  return { ...state, phase: 'off', armed: false, armedAtMs: null, armedBy: null, countdown: null };
}

/** Roughly what the real host and leader would do. Nothing here touches the machine. */
function react(message: WebviewToHost): void {
  switch (message.type) {
    case 'ready':
    case 'refresh':
      withState((state) => ({ ...state, scan: { ...state.scan, lastCompletedAgoMs: state.scan.lastCompletedAgoMs === null ? null : 0 } }));
      break;
    case 'setAction':
      current = { ...current, view: { ...current.view, plan: { ...current.view.plan, action: message.action } } };
      break;
    case 'setTestMode':
      current = { ...current, view: { ...current.view, plan: { ...current.view.plan, testMode: message.testMode } } };
      break;
    case 'start':
      withState((state) => ({
        ...state,
        phase: 'watching',
        armed: true,
        armedAtMs: Date.now(),
        armedBy: 'user',
        contract: current.view.plan,
        lastResult: null,
      }));
      break;
    case 'stop':
      withState(stopWatching);
      break;
    case 'cancel':
      withState((state) => {
        const kind = state.countdown?.kind ?? 'real';
        const stopped = stopWatching(state);
        if (kind === 'preview') return stopped;
        return {
          ...stopped,
          lastResult: { kind: 'cancelled', atMs: Date.now(), reason: { id: 'user', via: 'button' }, stillWatching: false, countdownKind: kind },
        };
      });
      break;
    case 'preview':
      withState((state) => ({
        ...state,
        phase: 'countdown',
        countdown: { id: `preview-${Date.now()}`, kind: 'preview', action: current.view.plan.action, totalMs: 20_000, remainingMs: 19_000 },
      }));
      break;
    case 'dismissResult':
      withState((state) => ({ ...state, lastResult: null }));
      break;
    case 'ignore':
      withState((state) => setIgnored(state, message.key, message.on));
      break;
    case 'requestPreview': {
      const events = current.previews?.[message.key] ?? [];
      setTimeout(() => toDashboard({ type: 'preview', key: message.key, events, error: null }), HOST_DELAY_MS);
      return;
    }
    default:
      // Opening settings, the log, a file: nothing to simulate. The message is in the harness log.
      return;
  }
  setTimeout(postState, HOST_DELAY_MS);
}

function readStoredState(): unknown {
  try {
    const stored = window.sessionStorage.getItem(STATE_KEY);
    return stored === null ? undefined : JSON.parse(stored);
  } catch {
    return undefined;
  }
}

window.acquireVsCodeApi = () => ({
  postMessage(message: unknown): void {
    logToHarness(message);
    // The same shape check the real host applies to whatever comes out of the webview.
    if (isWebviewMessage(message)) react(message);
  },
  getState: readStoredState,
  setState(state: unknown): void {
    window.sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  },
});

window.harness = {
  show(fixtureId: string): void {
    current = fixtureById(fixtureId).build(Date.now());
    postState();
  },
  setTheme: applyTheme,
  setReducedMotion(on: boolean): void {
    document.body.classList.toggle('vscode-reduce-motion', on);
  },
  focusPlan(): void {
    toDashboard({ type: 'focusPlan' });
  },
};

applyTheme(params.get('theme'), params.get('surface'));
document.body.classList.toggle('vscode-reduce-motion', params.get('motion') === 'reduce');
