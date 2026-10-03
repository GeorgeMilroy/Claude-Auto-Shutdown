// Detects that time did not pass the way a running countdown assumes: the PC slept and woke up,
// the extension host stalled, or somebody changed the clock.
//
// Two clocks are compared on purpose. A monotonic clock stops during suspend on Linux and macOS,
// so "the tick is late" is invisible to it; the wall clock sees the sleep but also steps on its
// own. Either one misbehaving, or the two disagreeing, means the evidence gathered so far
// ("quiet for 5 minutes", "you've been away 10 minutes") can no longer be trusted.

export interface TimeSample {
  /** Monotonic ms. */
  mono: number;
  /** Wall clock, epoch ms. */
  wall: number;
}

/** A tick that arrives later than this (on either clock) is a stall or a sleep. */
const MAX_TICK_GAP_MS = 5000;
/** The wall clock may step back by this much (NTP slew) before it counts as a clock change. */
const MAX_WALL_BACKSTEP_MS = 1000;
/** The two clocks may drift apart by this much between two ticks. */
const MAX_CLOCK_DISAGREEMENT_MS = 2000;

export function isDiscontinuity(previous: TimeSample, current: TimeSample): boolean {
  const dMono = current.mono - previous.mono;
  const dWall = current.wall - previous.wall;
  // A clock that returns garbage is a clock that cannot be trusted.
  if (!Number.isFinite(dMono) || !Number.isFinite(dWall)) return true;
  return (
    dMono > MAX_TICK_GAP_MS ||
    dMono < 0 ||
    dWall > MAX_TICK_GAP_MS ||
    dWall < -MAX_WALL_BACKSTEP_MS ||
    Math.abs(dWall - dMono) > MAX_CLOCK_DISAGREEMENT_MS
  );
}

export interface TickerOptions {
  clock: {
    now(): number;
    mono(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** Interval of the next tick; null = nothing needs ticking right now. */
  intervalMs(): number | null;
  /** Time passed normally since the previous tick. */
  onTick(mono: number): void;
  /** Time did NOT pass normally. Called INSTEAD of onTick. */
  onJump(): void;
  onError(error: unknown): void;
}

/**
 * The one tick timer. Every tick looks at the clocks FIRST and only then lets anything else
 * happen, so a deadline that passed while this PC slept is never acted on: the tick that would
 * notice the deadline notices the sleep instead.
 */
export class Ticker {
  private readonly options: TickerOptions;
  private timer: unknown = null;
  private last: TimeSample | null = null;
  private disposed = false;

  constructor(options: TickerOptions) {
    this.options = options;
  }

  /** Starts, keeps or stops the timer to match intervalMs(). */
  sync(): void {
    if (this.disposed) return;
    const interval = this.options.intervalMs();
    if (interval === null) {
      this.clearTimer();
      this.last = null;
      return;
    }
    // First tick after a pause: there is nothing to compare with yet, so start a baseline.
    if (this.last === null) this.last = this.sample();
    if (this.timer === null) this.timer = this.options.clock.setTimeout(() => this.fire(), interval);
  }

  /** The interval just got shorter (a countdown began): do not wait out the old one. */
  hasten(): void {
    this.clearTimer();
    this.sync();
  }

  /**
   * Did time jump since the previous look (a tick, or an earlier call of this)?
   * No previous look means nobody can vouch for the time in between, which counts as a jump.
   */
  jumped(): boolean {
    const now = this.sample();
    const jumped = this.last === null || isDiscontinuity(this.last, now);
    this.last = now;
    return jumped;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private fire(): void {
    this.timer = null;
    if (this.disposed) return;
    try {
      if (this.jumped()) this.options.onJump();
      else this.options.onTick(this.options.clock.mono());
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.sync();
    }
  }

  private sample(): TimeSample {
    return { mono: this.options.clock.mono(), wall: this.options.clock.now() };
  }

  private clearTimer(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
