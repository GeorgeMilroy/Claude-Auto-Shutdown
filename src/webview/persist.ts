// What the dashboard remembers across reloads of the webview (vscode getState / setState): which
// rows the user opened or closed. Only explicit choices are stored; everything else follows the
// default for the row, which can change with the layout (wide = sessions open).

import { isRecord } from './guards';

export interface PersistedUi {
  /** Session key -> the user opened (true) or closed (false) the row. */
  sessions: Record<string, boolean>;
  /** Lane id -> opened / closed. */
  lanes: Record<string, boolean>;
  /** The "N checks OK" list is open. */
  checksOpen: boolean;
  /** The folded "N finished" group is open. */
  finishedOpen: boolean;
}

export const EMPTY_PERSISTED: PersistedUi = { sessions: {}, lanes: {}, checksOpen: false, finishedOpen: false };

function choices(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, open] of Object.entries(value)) {
    if (typeof open === 'boolean') out[key] = open;
  }
  return out;
}

/** Whatever getState() returns (nothing, or the state of an older version) becomes a usable value. */
export function parsePersisted(raw: unknown): PersistedUi {
  if (!isRecord(raw)) return EMPTY_PERSISTED;
  return {
    sessions: choices(raw.sessions),
    lanes: choices(raw.lanes),
    checksOpen: raw.checksOpen === true,
    finishedOpen: raw.finishedOpen === true,
  };
}

export function isOpen(choices: Record<string, boolean>, key: string, openByDefault: boolean): boolean {
  return Object.hasOwn(choices, key) ? choices[key] === true : openByDefault;
}

export function withChoice(choices: Record<string, boolean>, key: string, open: boolean): Record<string, boolean> {
  return { ...choices, [key]: open };
}

/** Forgets choices about rows that no longer exist, so the stored state cannot grow for ever. */
export function pruneChoices(choices: Record<string, boolean>, liveKeys: readonly string[]): Record<string, boolean> {
  const live = new Set(liveKeys);
  const kept = Object.entries(choices).filter(([key]) => live.has(key));
  return kept.length === Object.keys(choices).length ? choices : Object.fromEntries(kept);
}
