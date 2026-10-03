// Every duration of the coordination protocol in one place, plus the timer bookkeeping that makes
// "dispose leaves nothing behind" a property of the code instead of a habit.

export type Range = readonly [minMs: number, maxMs: number];

/** Election (notes section 2). */
export const CONNECT_TIMEOUT_MS = 1000;
export const WELCOME_TIMEOUT_MS = 2000;
export const RETRY_JITTER_MS: Range = [20, 100];
export const TAKEOVER_GUARD_WAIT_MS: Range = [50, 150];
export const TAKEOVER_GUARD_STALE_MS = 10_000;
export const ISOLATED_AFTER_ROUNDS = 10;
export const ISOLATED_RETRY_MS = 5000;

/** Re-election after the leader connection closed (notes section 6). */
export const REELECT_JITTER_MS: Range = [0, 50];
export const REELECT_BEHIND_SUCCESSOR_MS: Range = [500, 700];

/** Leader side. */
export const HELLO_TIMEOUT_MS = 2000;
export const KEEPALIVE_MS = 10_000;
export const RECENT_COMMANDS = 64;
/** A follower whose socket holds more than this gets only the newest state once it drains. */
export const CONGESTED_BYTES = 1024 * 1024;

/** Graceful exit (notes section 7): the whole goodbye has to fit in about one second. */
export const HANDOVER_OFFER_MS = 300;
export const HANDOVER_BUDGET_MS = 800;
export const LEAVING_FLUSH_MS = 100;
export const HANDOVER_VALID_MS = 3000;

/** Follower side. */
export const SAFE_COMMAND_STUCK_MS = 2000;
export const COMMAND_ANSWER_TIMEOUT_MS = 20_000;
export const SILENCE_LIMIT_MS = 30_000;
export const ARMED_SILENCE_FLOOR_MS = 15_000;

export function between(range: Range, random: () => number): number {
  return range[0] + random() * (range[1] - range[0]);
}

export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Timers owned by one object. `dispose()` cancels all of them and refuses new ones, so an event
 * that arrives after its owner was torn down cannot leave a timer running.
 */
export class TimerSet {
  private readonly pending = new Set<TimerHandle>();
  private disposed = false;

  set(callback: () => void, ms: number): TimerHandle | null {
    if (this.disposed) return null;
    const handle = setTimeout(() => {
      this.pending.delete(handle);
      callback();
    }, ms);
    this.pending.add(handle);
    return handle;
  }

  clear(handle: TimerHandle | null): void {
    if (handle === null) return;
    clearTimeout(handle);
    this.pending.delete(handle);
  }

  dispose(): void {
    this.disposed = true;
    for (const handle of this.pending) clearTimeout(handle);
    this.pending.clear();
  }
}
