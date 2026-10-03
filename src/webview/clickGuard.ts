// A button that STARTS watching must not be hit by a click that was aimed at whatever stood in its
// place a moment ago (the layout shifts whenever the phase changes). For a short while after every
// such change start buttons ignore clicks. Cancel and Stop watching are never guarded: an accident
// must always land on "this PC stays on".

export const CLICK_GUARD_MS = 1500;

/**
 * Milliseconds until start buttons accept clicks again; 0 = ready. A clock that can't be read, or
 * that reads earlier than the change, keeps the guard up.
 */
export function guardRemainingMs(changedAt: number, now: number): number {
  const elapsed = now - changedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return CLICK_GUARD_MS;
  return Math.max(0, CLICK_GUARD_MS - elapsed);
}

export function isGuarded(changedAt: number, now: number): boolean {
  return guardRemainingMs(changedAt, now) > 0;
}
