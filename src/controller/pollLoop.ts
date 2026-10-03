// The scan rhythm: one scan, wait, the next scan - self-rescheduling and never overlapping.
// It decides WHEN a scan runs; what a scan means is the controller's business.
//
// The loop reschedules itself in a `finally`, so a scan that throws cannot end it, and every scan
// (the loop's own and the final gate's) goes through one queue, so two scans never run at once.

export interface PollLoopTimers {
  mono(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PollLoopOptions {
  timers: PollLoopTimers;
  /** Should the loop keep going? Asked after every scan. */
  isActive(): boolean;
  /** Delay before the next scan; asked each time one is scheduled. */
  intervalMs(): number;
  /** Changes whenever the rules a scan runs under change. */
  generation(): number;
  /** One scan. A rejection is reported through onError; the loop goes on. */
  scan(): Promise<unknown>;
  onError(error: unknown): void;
}

function noop(): void {
  // deliberately empty
}

export class PollLoop {
  private readonly options: PollLoopOptions;
  private timer: unknown = null;
  private dueMono: number | null = null;
  private running = false;
  private runningGeneration = 0;
  private rescanRequested = false;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PollLoopOptions) {
    this.options = options;
  }

  /** Neither scanning nor waiting for its timer: nothing will happen unless somebody asks. */
  get idle(): boolean {
    return this.timer === null && !this.running;
  }

  /** ms until the next scheduled scan; null while one is running or none is scheduled. */
  nextScanInMs(): number | null {
    return this.dueMono === null ? null : Math.max(0, Math.ceil(this.dueMono - this.options.timers.mono()));
  }

  /** Scan now instead of at the next interval. Also runs one scan while the loop is inactive. */
  scanNow(): void {
    if (this.disposed) return;
    if (this.running) {
      // A scan that began under older rules is shown but cannot count: follow it with a current one.
      this.rescanRequested = this.rescanRequested || this.runningGeneration !== this.options.generation();
      return;
    }
    this.start();
  }

  /** The interval changed (a countdown began): apply it to the pending timer. */
  reschedule(): void {
    if (this.timer === null) return;
    this.clearTimer();
    this.scheduleNext();
  }

  /** Drop the pending timer. A scan in flight finishes; it reschedules only if still active. */
  pause(): void {
    this.clearTimer();
  }

  /** Runs a task that must not overlap with any scan, after whatever is in flight. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(noop, noop);
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private start(): void {
    this.cycle().catch((error: unknown) => this.options.onError(error));
  }

  private async cycle(): Promise<void> {
    this.clearTimer();
    if (this.disposed || this.running) return;
    this.running = true;
    this.runningGeneration = this.options.generation();
    try {
      await this.exclusive(() => this.options.scan());
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    const again = this.rescanRequested;
    this.rescanRequested = false;
    if (this.disposed || !this.options.isActive()) return;
    if (again) {
      this.start();
      return;
    }
    const delay = this.options.intervalMs();
    this.dueMono = this.options.timers.mono() + delay;
    this.timer = this.options.timers.setTimeout(() => this.start(), delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.options.timers.clearTimeout(this.timer);
    this.timer = null;
    this.dueMono = null;
  }
}
