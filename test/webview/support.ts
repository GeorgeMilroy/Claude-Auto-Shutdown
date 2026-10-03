// Shared helpers for the webview tests. States come from the harness catalogue (dev/fixtures.ts),
// built at a fixed instant so every run sees the same data.

import { expect } from 'vitest';
import { fixtureById, FIXTURES } from '../../dev/fixtures';
import type { FixtureData } from '../../dev/fixtures';
import type { UiState, ViewContext } from '../../src/shared/protocol';
import type { UiAction } from '../../src/webview/actions';
import { sanitizeState, sanitizeView } from '../../src/webview/sanitize';

/** A fixed wall-clock instant: 15 January 2026, 02:14 local time. */
export const NOW = new Date(2026, 0, 15, 2, 14, 0).getTime();

export interface Scene {
  state: UiState | null;
  view: ViewContext;
}

/** A fixture as the dashboard sees it: through the same sanitizers a posted message goes through. */
export function scene(id: string): Scene {
  const data: FixtureData = fixtureById(id).build(NOW);
  expect(fixtureById(id).id).toBe(id);
  return { state: sanitizeState(data.state), view: sanitizeView(data.view) };
}

export function stateOf(id: string): UiState {
  const { state } = scene(id);
  if (state === null) throw new Error(`fixture ${id} has no state`);
  return state;
}

export function allScenes(): { id: string; scene: Scene }[] {
  return FIXTURES.map((fixture) => ({ id: fixture.id, scene: scene(fixture.id) }));
}

/** The message types an action posts; empty for an action that posts nothing. */
export function messageTypes(action: UiAction | undefined): string[] {
  return action !== undefined && action.do === 'send' ? action.messages.map((message) => message.type) : [];
}

/** Every string reachable inside a value (arrays and plain objects are walked). */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

const LEAKED_VALUE = /\b(NaN|undefined|null|Infinity)\b/;

/** Nothing a view-model would put on screen shows a raw unknown. */
export function expectPrintable(value: unknown): void {
  for (const text of stringsIn(value)) expect(text).not.toMatch(LEAKED_VALUE);
}
