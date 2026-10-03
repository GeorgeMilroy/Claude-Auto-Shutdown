// The only two doors of the webview: builders for everything it posts to the extension host, and
// the parser for everything the host posts in. Nothing else constructs or trusts a message.

import { CONFIG_KEYS, POWER_ACTIONS } from '../shared/config';
import type { PowerAction } from '../shared/config';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { isRecord, text } from './guards';
import { sanitizeEvents, sanitizeState, sanitizeView } from './sanitize';

/** The leader accepts "don't wait for this" only for these kinds of key. */
const IGNORE_KEY_PREFIXES = ['session:', 'proc:', 'remote:'] as const;

export function isIgnoreKey(key: unknown): key is string {
  return typeof key === 'string' && IGNORE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

function isPowerAction(value: unknown): value is PowerAction {
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value);
}

/**
 * One builder per message the host understands. A builder that is handed something it can't vouch
 * for returns null, and null is never posted.
 */
export const toHost = {
  ready: (): WebviewToHost => ({ type: 'ready' }),
  start: (): WebviewToHost => ({ type: 'start' }),
  stop: (): WebviewToHost => ({ type: 'stop' }),
  cancel: (): WebviewToHost => ({ type: 'cancel' }),
  refresh: (): WebviewToHost => ({ type: 'refresh' }),
  preview: (): WebviewToHost => ({ type: 'preview' }),
  dismissResult: (): WebviewToHost => ({ type: 'dismissResult' }),
  showLog: (): WebviewToHost => ({ type: 'showLog' }),
  openLogFile: (): WebviewToHost => ({ type: 'openLogFile' }),
  revealStop: (): WebviewToHost => ({ type: 'revealStop' }),
  openWalkthrough: (): WebviewToHost => ({ type: 'openWalkthrough' }),
  lastRun: (): WebviewToHost => ({ type: 'lastRun' }),

  setAction(action: unknown): WebviewToHost | null {
    return isPowerAction(action) ? { type: 'setAction', action } : null;
  },

  setTestMode(testMode: unknown): WebviewToHost | null {
    return typeof testMode === 'boolean' ? { type: 'setTestMode', testMode } : null;
  },

  ignore(key: unknown, on: boolean): WebviewToHost | null {
    return isIgnoreKey(key) ? { type: 'ignore', key, on } : null;
  },

  /** `setting` is a settings id without the extension prefix; anything unknown opens all settings. */
  openSettings(setting?: string): WebviewToHost {
    return setting !== undefined && (CONFIG_KEYS as readonly string[]).includes(setting)
      ? { type: 'openSettings', setting }
      : { type: 'openSettings' };
  },

  /** Ask for the last events of a session's own transcript. */
  requestPreview(key: unknown): WebviewToHost | null {
    const sessionKey = text(key);
    return sessionKey === null ? null : { type: 'requestPreview', key: sessionKey };
  },

  openTranscript(path: unknown): WebviewToHost | null {
    const file = text(path);
    return file === null ? null : { type: 'openTranscript', path: file };
  },
};

/**
 * Messages that still do something when the controlling window runs another version of the
 * extension: the two that make things safer, and those the host answers by itself.
 */
const WORKS_WHEN_LIMITED: ReadonlySet<WebviewToHost['type']> = new Set<WebviewToHost['type']>([
  'ready',
  'stop',
  'cancel',
  'openSettings',
  'showLog',
  'openLogFile',
  'revealStop',
  'openWalkthrough',
  'lastRun',
  'requestPreview',
  'openTranscript',
]);

export function worksWhenLimited(message: WebviewToHost): boolean {
  return WORKS_WHEN_LIMITED.has(message.type);
}

/** null = not a message this webview understands; it is dropped. */
export function parseHostMessage(data: unknown): HostToWebview | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'state':
      return { type: 'state', state: sanitizeState(data.state), view: sanitizeView(data.view) };
    case 'preview': {
      const key = text(data.key);
      if (key === null) return null;
      return { type: 'preview', key, events: sanitizeEvents(data.events), error: text(data.error) };
    }
    case 'focusPlan':
      return { type: 'focusPlan' };
    default:
      return null;
  }
}
