// Questions the controller asks the code around it (the platform backend, the glue). Each one has
// a careful answer for when asking itself fails: a backend that throws must read as "can't see",
// never as "all fine".

import type { HelperStatus, Platform } from '../platform/types';
import { errorText } from './wording';

export function environmentProblemOf(platform: Pick<Platform, 'environmentProblem'>): string | null {
  try {
    const problem = platform.environmentProblem();
    return typeof problem === 'string' && problem !== '' ? problem : null;
  } catch (error) {
    return `The platform could not be checked: ${errorText(error)}`;
  }
}

export function helperStatusOf(platform: Pick<Platform, 'helperStatus'>): HelperStatus {
  try {
    const status = platform.helperStatus();
    if (status.tier === 'full' || status.tier === 'limited' || status.tier === 'unavailable') {
      return { tier: status.tier, problem: typeof status.problem === 'string' ? status.problem : null };
    }
  } catch {
    // an unknown tier is an unavailable helper
  }
  return { tier: 'unavailable', problem: "The helper that looks at this PC's programs didn't answer." };
}

/** A yes/no question whose answer only counts when it is exactly `true`. */
export function saysYes(question: () => boolean): boolean {
  try {
    return question() === true;
  } catch {
    return false;
  }
}

/** Stands in for the list when it cannot be read: it blocks like any remote window nobody ignored. */
export const UNKNOWN_REMOTE_WINDOWS = 'Remote windows (could not be listed)';

/** Distinct, non-empty names of the connected remote windows. */
export function remoteWindowNames(read: () => string[]): string[] {
  let names: unknown;
  try {
    names = read();
  } catch {
    names = null;
  }
  if (!Array.isArray(names)) return [UNKNOWN_REMOTE_WINDOWS];
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name !== ''))];
}
