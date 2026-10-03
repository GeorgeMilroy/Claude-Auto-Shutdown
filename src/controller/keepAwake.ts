// "Don't go to sleep by yourself while Claude is still working": held exactly while watching.
// Best effort - an OS that refuses is reported, and watching goes on without it.

import type { Platform } from '../platform/types';

export type KeepAwakeState = 'held' | 'off' | 'unavailable';

export class KeepAwakeHold {
  private readonly platform: Pick<Platform, 'keepAwake'>;
  private readonly onSettled: (held: boolean) => void;
  private wanted = false;
  private current: KeepAwakeState = 'off';

  /** `onSettled` fires when a request to HOLD has been answered and is still wanted. */
  constructor(platform: Pick<Platform, 'keepAwake'>, onSettled: (held: boolean) => void) {
    this.platform = platform;
    this.onSettled = onSettled;
  }

  get state(): KeepAwakeState {
    return this.current;
  }

  /** Idempotent: the platform is only called when the wish actually changes. */
  want(wanted: boolean): void {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    if (!wanted) this.current = 'off';
    void this.apply(wanted);
  }

  /** Never rejects: neither a platform that throws nor a listener that throws gets past here. */
  private async apply(on: boolean): Promise<void> {
    let held = false;
    try {
      held = (await this.platform.keepAwake(on))?.ok === true;
    } catch {
      // refused = not held
    }
    if (!on || this.wanted !== on) return;
    this.current = held ? 'held' : 'unavailable';
    try {
      this.onSettled(held);
    } catch {
      // the state is set; telling others about it is best effort
    }
  }
}
