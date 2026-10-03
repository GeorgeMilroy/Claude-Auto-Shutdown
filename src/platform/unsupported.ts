// Backend for an operating system this extension has no support for. It can see nothing and do
// nothing: every answer is "unknown" or "not possible", and environmentProblem() refuses watching.

import type { PowerAction } from '../shared/config';
import { NOTIFY_CAPABILITY, NOTIFY_RESULT, failedAction, inertAlert } from './posixShared';
import type {
  ActionResult,
  Capability,
  CountdownAlert,
  ForeignRoot,
  HelperStatus,
  Platform,
  ProcDetail,
  SystemSnapshot,
} from './types';

export function unsupportedProblem(osPlatform: string): string {
  return `Claude Auto Shutdown doesn't support this operating system (${osPlatform}).`;
}

/** `osPlatform` is Node's process.platform value ('freebsd', 'sunos', ...). */
export function createUnsupportedPlatform(osPlatform: string): Platform {
  const problem = unsupportedProblem(osPlatform);
  return {
    id: 'unsupported',
    osName: osPlatform,
    procStartUnitsPerSecond: null,
    experimental: false,
    environmentProblem: (): string => problem,
    helperStatus: (): HelperStatus => ({ tier: 'unavailable', problem }),
    snapshot: (): Promise<SystemSnapshot> =>
      Promise.resolve({ takenAtMs: Date.now(), idleSeconds: null, processes: null, details: {}, problem }),
    probe: (): Promise<Record<number, ProcDetail>> => Promise.resolve({}),
    idleSeconds: (): Promise<number | null> => Promise.resolve(null),
    capability: (action: PowerAction): Promise<Capability> =>
      Promise.resolve(action === 'notify' ? NOTIFY_CAPABILITY : { ok: false, detail: problem }),
    execute: (action: PowerAction): Promise<ActionResult> =>
      Promise.resolve(action === 'notify' ? NOTIFY_RESULT : failedAction(problem)),
    keepAwake: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: problem }),
    startCountdownAlert: (): CountdownAlert => inertAlert(),
    foreignRoots: (): Promise<{ roots: ForeignRoot[]; problem: string | null }> => Promise.resolve({ roots: [], problem: null }),
    dispose: (): Promise<void> => Promise.resolve(),
  };
}
