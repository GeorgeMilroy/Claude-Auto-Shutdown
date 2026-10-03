// Small pure helpers around a Verdict: which checks are unmet, why a countdown has to stop, and
// how to re-read a verdict without letting it count as another poll.

import type { Check, ScanResult, Verdict } from '../core/types';
import type { CancelReason } from '../shared/protocol';

/** Checks that are about what the Claude sessions are doing. */
const SESSION_CHECKS: ReadonlySet<string> = new Set(['sessionsIdle', 'turnsClosed', 'quiet', 'childProcesses']);

/** Everything that keeps this PC on right now. `confirmed` is the re-check counter, not a blocker. */
function unmetChecks(verdict: Verdict): Check[] {
  return verdict.checks.filter((check) => check.id !== 'confirmed' && check.state !== 'pass');
}

/** Identity of the SET of unmet checks; the activity log gets a line only when this changes. */
export function blockerKey(verdict: Verdict): string {
  return unmetChecks(verdict)
    .map((check) => check.id)
    .sort()
    .join(',');
}

export function defaultBlockerText(verdict: Verdict): string {
  return `Waiting for: ${unmetChecks(verdict)
    .map((check) => check.id)
    .join(', ')}`;
}

/**
 * The same evidence looked at again (a settings / peer change, a scan that started before the
 * rules changed) is not a new poll. `confirmed` is restated with the count the controller
 * already holds, so "3 checks in a row" can only ever be reached by three separate scans.
 */
export function withoutNewPoll(verdict: Verdict, stablePolls: number, requiredPolls: number): Verdict {
  const k = verdict.allClear === true ? stablePolls : 0;
  const ok = verdict.allClear === true && Number.isFinite(requiredPolls) && k >= requiredPolls;
  const checks = verdict.checks.map(
    (check): Check =>
      check.id === 'confirmed' ? { ...check, state: ok ? 'pass' : 'waiting', data: { ...check.data, k } } : check,
  );
  return { ...verdict, checks, ok, stablePolls: k };
}

/** Stand-in for a verdict that could not be computed: nothing passes. */
export function failedVerdict(requiredPolls: number, message: string): Verdict {
  return {
    checks: [
      { id: 'scanner', state: 'cantTell', data: { reason: 'noScan', errors: [message], roots: 0 } },
      { id: 'confirmed', state: 'waiting', data: { k: 0, n: requiredPolls } },
    ],
    allClear: false,
    ok: false,
    stablePolls: 0,
    requiredPolls,
  };
}

/** Why a running countdown must stop, given a verdict that is no longer all clear. */
export function cancelReasonFor(verdict: Verdict, scan: ScanResult | null, scanStale: boolean): CancelReason {
  const unmet = unmetChecks(verdict);
  const failing = (id: string): boolean => unmet.some((check) => check.id === id);

  if (failing('stopFile')) return { id: 'emergencyStop' };
  if (scanStale && failing('scanner')) return { id: 'scanStale' };
  // Without a scan every check that needs one is "can't tell"; the scan is the cause, not the user.
  if (scan === null) return { id: 'checkFailed', check: 'scanner' };
  if (failing('userIdle')) return { id: 'userCameBack' };
  if (unmet.some((check) => SESSION_CHECKS.has(check.id))) {
    const resumed = scan?.sessions.find((session) => session.working && !session.ignored);
    if (resumed !== undefined) return { id: 'sessionResumed', name: resumed.name };
  }
  return { id: 'checkFailed', check: unmet[0]?.id ?? 'scanner' };
}
