// The door between the dashboard webview and the extension host. A webview is a browser page:
// whatever it posts is untrusted input. A message is first recognised by its type
// (isWebviewMessage) and then rebuilt field by field, so nothing but checked values of the
// expected types travels further. A message that does not check out is dropped.

import { CONFIG_KEYS, POWER_ACTIONS } from '../shared/config';
import type { Config, PowerAction } from '../shared/config';
import { isWebviewMessage } from '../shared/protocol';
import type { UiState, WebviewToHost } from '../shared/protocol';
import { isRecord } from './snapshot';

/** The kinds of "don't wait for this" key the leader accepts. */
const IGNORE_KEY_PREFIXES = ['session:', 'proc:', 'remote:'];
const MAX_KEY_CHARS = 1024;
const MAX_PATH_CHARS = 4096;

function boundedText(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value !== '' && value.length <= maxChars ? value : null;
}

function isPowerAction(value: unknown): value is PowerAction {
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value);
}

function isIgnoreKey(value: unknown): value is string {
  const key = boundedText(value, MAX_KEY_CHARS);
  return key !== null && IGNORE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

export function isSettingKey(value: unknown): value is keyof Config {
  return typeof value === 'string' && (CONFIG_KEYS as readonly string[]).includes(value);
}

/** The message with every field checked, or null when it is not one this host acts on. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | null {
  if (!isWebviewMessage(raw)) return null;
  const source = raw as unknown as Record<string, unknown>;
  switch (raw.type) {
    case 'ready':
    case 'start':
    case 'stop':
    case 'cancel':
    case 'refresh':
    case 'preview':
    case 'dismissResult':
    case 'showLog':
    case 'openLogFile':
    case 'revealStop':
    case 'openWalkthrough':
    case 'lastRun':
      return { type: raw.type };
    case 'setAction':
      return isPowerAction(source.action) ? { type: 'setAction', action: source.action } : null;
    case 'setTestMode':
      return typeof source.testMode === 'boolean' ? { type: 'setTestMode', testMode: source.testMode } : null;
    case 'ignore':
      return isIgnoreKey(source.key) && typeof source.on === 'boolean'
        ? { type: 'ignore', key: source.key, on: source.on }
        : null;
    case 'openSettings':
      // An unknown setting id still opens Settings - just not at a place of the sender's choosing.
      return isSettingKey(source.setting) ? { type: 'openSettings', setting: source.setting } : { type: 'openSettings' };
    case 'requestPreview': {
      const key = boundedText(source.key, MAX_KEY_CHARS);
      if (key === null) return null;
      if (source.path === undefined) return { type: 'requestPreview', key };
      const path = boundedText(source.path, MAX_PATH_CHARS);
      return path === null ? null : { type: 'requestPreview', key, path };
    }
    case 'openTranscript': {
      const path = boundedText(source.path, MAX_PATH_CHARS);
      return path === null ? null : { type: 'openTranscript', path };
    }
    default:
      return null;
  }
}

function sessionsOf(state: UiState | null): Record<string, unknown>[] {
  const sessions: unknown = state?.sessions;
  return Array.isArray(sessions) ? sessions.filter(isRecord) : [];
}

function transcriptsOf(session: Record<string, unknown>): string[] {
  const subagents: unknown[] = Array.isArray(session.subagents) ? session.subagents : [];
  return [session.transcriptPath, ...subagents.map((subagent) => (isRecord(subagent) ? subagent.path : null))].filter(
    (path): path is string => typeof path === 'string' && path !== '',
  );
}

/**
 * Whether `path` is a transcript (or subagent transcript) of a session in the state this window
 * shows right now. The webview may only ever name files the leader has just listed: the host
 * reads and reveals nothing else on its behalf.
 */
export function isListedTranscript(state: UiState | null, path: string): boolean {
  return sessionsOf(state).some((session) => transcriptsOf(session).includes(path));
}

/**
 * The file a preview request may read: the named path when the state lists it, else (no path
 * given) the own transcript of the session with that key. null = nothing to read.
 */
export function previewTarget(state: UiState | null, key: string, path: string | undefined): string | null {
  if (path !== undefined) return isListedTranscript(state, path) ? path : null;
  const session = sessionsOf(state).find((candidate) => candidate.key === key);
  const own = session?.transcriptPath;
  return typeof own === 'string' && own !== '' ? own : null;
}
