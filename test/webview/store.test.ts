import { describe, expect, it } from 'vitest';
import { fixtureById } from '../../dev/fixtures';
import type { HostToWebview } from '../../src/shared/protocol';
import { isGuarded } from '../../src/webview/clickGuard';
import { remainingMs } from '../../src/webview/clock';
import { parseHostMessage } from '../../src/webview/messages';
import { applyHostMessage, initialSnapshot } from '../../src/webview/store';
import type { Snapshot } from '../../src/webview/store';
import { NOW } from './support';

/** A state message for a fixture, parsed the way the dashboard parses what the host posts. */
function stateMessage(id: string, change: (data: Record<string, unknown>) => void = () => undefined): HostToWebview {
  const data = fixtureById(id).build(NOW);
  const raw = JSON.parse(JSON.stringify({ type: 'state', state: data.state, view: data.view })) as Record<string, unknown>;
  change(raw);
  const parsed = parseHostMessage(raw);
  if (parsed === null) throw new Error('the fixture did not parse as a host message');
  return parsed;
}

function after(messages: [HostToWebview, number][], start = initialSnapshot(0)): Snapshot {
  return messages.reduce((snapshot, [message, now]) => applyHostMessage(snapshot, message, now), start);
}

function withRemaining(remaining: number): (data: Record<string, unknown>) => void {
  return (data) => {
    const state = data.state as { countdown: { remainingMs: number } };
    state.countdown.remainingMs = remaining;
  };
}

describe('the snapshot', () => {
  it('starts with no state, counting from the moment the page opened', () => {
    const snapshot = initialSnapshot(500);
    expect(snapshot).toMatchObject({ state: null, nullSince: 500, countdown: null, previews: {}, focusPlanRequests: 0 });
    expect(snapshot.view.role).toBe('electing');
  });

  it('stores the state and when it arrived', () => {
    const snapshot = after([[stateMessage('watching-real'), 1_200]]);
    expect(snapshot.state?.phase).toBe('watching');
    expect(snapshot.receivedAt).toBe(1_200);
    expect(snapshot.nullSince).toBeNull();
  });

  it('remembers since when there has been no state, and forgets when one arrives', () => {
    const lost = after([
      [stateMessage('watching-real'), 1_000],
      [stateMessage('lost-contact'), 5_000],
      [stateMessage('lost-contact'), 9_000],
    ]);
    expect(lost.state).toBeNull();
    expect(lost.nullSince).toBe(5_000);
    expect(applyHostMessage(lost, stateMessage('watching-real'), 9_500).nullSince).toBeNull();
  });
});

describe('the countdown anchor', () => {
  it('is set when a countdown arrives and counts on the local clock', () => {
    const snapshot = after([[stateMessage('countdown-real'), 10_000]]);
    expect(snapshot.countdown).not.toBeNull();
    if (snapshot.countdown === null) return;
    expect(remainingMs(snapshot.countdown, 10_000)).toBe(87_000);
    expect(remainingMs(snapshot.countdown, 20_000)).toBe(77_000);
  });

  it('follows the leader down and never back up while the same countdown keeps arriving', () => {
    const snapshot = after([
      [stateMessage('countdown-real', withRemaining(87_000)), 0],
      [stateMessage('countdown-real', withRemaining(86_800)), 500],
      [stateMessage('countdown-real', withRemaining(86_900)), 1_000],
    ]);
    if (snapshot.countdown === null) throw new Error('no anchor');
    // At 500 ms this window showed 86.5 s and took that; at 1000 ms it shows 86.0 s, and the
    // message that claims 86.9 s is not allowed to hand the difference back.
    expect(remainingMs(snapshot.countdown, 1_000)).toBe(86_000);
  });

  it('is dropped only when a state without a countdown arrives', () => {
    const counting = after([[stateMessage('countdown-real'), 0]]);
    expect(applyHostMessage(counting, { type: 'focusPlan' }, 100).countdown).not.toBeNull();
    expect(applyHostMessage(counting, { type: 'preview', key: 'k', events: [], error: null }, 100).countdown).not.toBeNull();
    expect(applyHostMessage(counting, stateMessage('result-cancelled'), 200).countdown).toBeNull();
    expect(applyHostMessage(counting, stateMessage('lost-contact'), 200).countdown).toBeNull();
  });
});

describe('the click guard', () => {
  it('is up when the page opens', () => {
    const snapshot = initialSnapshot(0);
    expect(isGuarded(snapshot.heroChangedAt, 100)).toBe(true);
  });

  it('restarts whenever the hero changes', () => {
    const snapshot = after([
      [stateMessage('watching-real'), 1_000],
      [stateMessage('off-sessions'), 60_000],
    ]);
    expect(snapshot.heroChangedAt).toBe(60_000);
    expect(isGuarded(snapshot.heroChangedAt, 60_100)).toBe(true);
    expect(isGuarded(snapshot.heroChangedAt, 61_500)).toBe(false);
  });

  it('restarts when a result card appears or goes away', () => {
    const snapshot = after([
      [stateMessage('off-sessions'), 1_000],
      [stateMessage('result-test-passed'), 30_000],
    ]);
    expect(snapshot.heroChangedAt).toBe(30_000);
    expect(applyHostMessage(snapshot, stateMessage('off-sessions'), 40_000).heroChangedAt).toBe(40_000);
  });

  it('does not restart while the same kind of state keeps arriving', () => {
    const snapshot = after([
      [stateMessage('off-sessions'), 1_000],
      [stateMessage('off-sessions'), 11_000],
      [stateMessage('off-real'), 21_000],
    ]);
    expect(snapshot.heroChangedAt).toBe(1_000);
  });

  it('does not restart for a preview or a focus request', () => {
    const snapshot = after([
      [stateMessage('off-sessions'), 1_000],
      [{ type: 'preview', key: 'k', events: [], error: null }, 5_000],
      [{ type: 'focusPlan' }, 6_000],
    ]);
    expect(snapshot.heroChangedAt).toBe(1_000);
  });
});

describe('previews and focus requests', () => {
  const key = '0:9120:api-refactor';

  it('keeps a preview by session key and replaces it when a newer one arrives', () => {
    const first: HostToWebview = { type: 'preview', key, events: [], error: 'Could not read it.' };
    const second: HostToWebview = {
      type: 'preview',
      key,
      events: [{ time: '02:11:04', who: 'you', sidechain: false, text: 'hi', kind: 'text' }],
      error: null,
    };
    const snapshot = after([
      [stateMessage('watching-real'), 0],
      [first, 10],
      [second, 20],
    ]);
    expect(snapshot.previews[key]).toEqual({ events: second.events, error: null });
  });

  it('drops the previews of sessions that are gone, and all of them with the state', () => {
    const withPreview = after([
      [stateMessage('watching-real'), 0],
      [{ type: 'preview', key, events: [], error: null }, 10],
    ]);
    expect(Object.keys(applyHostMessage(withPreview, stateMessage('watching-real'), 20).previews)).toEqual([key]);
    expect(applyHostMessage(withPreview, stateMessage('off-empty'), 20).previews).toEqual({});
    expect(applyHostMessage(withPreview, stateMessage('lost-contact'), 20).previews).toEqual({});
  });

  it('counts focus requests from the host', () => {
    const snapshot = after([
      [{ type: 'focusPlan' }, 0],
      [{ type: 'focusPlan' }, 10],
    ]);
    expect(snapshot.focusPlanRequests).toBe(2);
  });
});
