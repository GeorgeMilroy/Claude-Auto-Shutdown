import { describe, expect, it } from 'vitest';
import { CLICK_GUARD_MS, guardRemainingMs, isGuarded } from '../../src/webview/clickGuard';
import { allowedDuringCountdown, sending } from '../../src/webview/actions';
import { toHost } from '../../src/webview/messages';

describe('the click guard on start buttons', () => {
  it('lasts 1.5 seconds', () => {
    expect(CLICK_GUARD_MS).toBe(1500);
  });

  it('is up from the moment the hero changes', () => {
    expect(isGuarded(10_000, 10_000)).toBe(true);
    expect(guardRemainingMs(10_000, 10_000)).toBe(1500);
  });

  it('is still up one millisecond before it ends, and down exactly at the end', () => {
    expect(isGuarded(10_000, 11_499)).toBe(true);
    expect(guardRemainingMs(10_000, 11_499)).toBe(1);
    expect(isGuarded(10_000, 11_500)).toBe(false);
    expect(guardRemainingMs(10_000, 11_500)).toBe(0);
    expect(isGuarded(10_000, 60_000)).toBe(false);
  });

  it('stays up when the clock cannot be trusted', () => {
    expect(isGuarded(10_000, NaN)).toBe(true);
    expect(isGuarded(NaN, 10_000)).toBe(true);
    expect(isGuarded(Infinity, 10_000)).toBe(true);
    // A clock that reads earlier than the change it is measured from.
    expect(isGuarded(10_000, 9_000)).toBe(true);
  });
});

describe('what may leave the dashboard during a countdown', () => {
  it('lets Cancel through', () => {
    const cancel = sending(toHost.cancel());
    expect(cancel).not.toBeNull();
    if (cancel !== null) expect(allowedDuringCountdown(cancel)).toBe(true);
  });

  it('holds back everything else', () => {
    const others = [
      sending(toHost.start()),
      sending(toHost.stop()),
      sending(toHost.refresh()),
      sending(toHost.preview()),
      sending(toHost.dismissResult()),
      sending(toHost.ignore('session:0:1:a', true)),
      sending(toHost.cancel(), toHost.start()),
    ];
    for (const action of others) {
      expect(action).not.toBeNull();
      if (action !== null) expect(allowedDuringCountdown(action)).toBe(false);
    }
    expect(allowedDuringCountdown({ do: 'focusPlan' })).toBe(false);
    expect(allowedDuringCountdown({ do: 'switchToReal' })).toBe(false);
  });
});
