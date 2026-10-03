// The keep-on list: process names that keep this PC on while they run.
//
// People write these the natural way - `ffmpeg`, `ffmpeg.exe`, `ffmpeg*`, `.*mpeg\.exe` - so a
// pattern is tried as a substring, as a glob and as a regex. A regex alone is not enough:
// `ffmpeg*` is a valid one ("ffmpe" plus any number of g) that silently fails to mean what it says.

import type { ProcRow } from '../platform/types';

type NameMatcher = (processName: string) => boolean;

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** A pattern that is not a regex is simply not a regex match. */
function tryRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/**
 * The process list reports 'ffmpeg' where the user may have typed what Task Manager shows,
 * 'ffmpeg.exe': a pattern is tried against the name both ways.
 */
function nameForms(processName: string): [string, string] {
  const lower = processName.toLowerCase();
  const bare = lower.endsWith('.exe') ? lower.slice(0, -'.exe'.length) : lower;
  return [bare, `${bare}.exe`];
}

function compileGuardPattern(pattern: string): NameMatcher {
  const needle = typeof pattern === 'string' ? pattern.trim() : '';
  // An empty pattern would be a substring of every name.
  if (needle === '') return () => false;
  const lower = needle.toLowerCase();
  const glob = globToRegExp(lower);
  const regex = tryRegExp(needle);
  return (processName) =>
    typeof processName === 'string' &&
    nameForms(processName).some((form) => form.includes(lower) || glob.test(form) || regex?.test(form) === true);
}

/**
 * Keep-on list matching. Each pattern may be a substring, a glob or a regex, matched
 * case-insensitively against the name with and without '.exe'.
 */
export function guardPatternMatches(pattern: string, processName: string): boolean {
  return compileGuardPattern(pattern)(processName);
}

/**
 * Names of the running processes on the keep-on list, sorted. null when the process list could
 * not be read: "could not look" must not read as "none of them is running".
 */
export function guardHits(patterns: readonly string[], processes: readonly ProcRow[] | null): string[] | null {
  if (processes === null) return null;
  const matchers = patterns.map(compileGuardPattern);
  const hits = new Set<string>();
  for (const { name } of processes) {
    if (matchers.some((matches) => matches(name))) hits.add(name.toLowerCase());
  }
  return [...hits].sort();
}
