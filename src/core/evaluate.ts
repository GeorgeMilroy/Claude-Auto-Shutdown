// The decision engine: a pure function from "what we saw" to a list of named checks.
// The action is allowed only when EVERY check passes, N polls in a row.
//
// Not knowing is never permission. JavaScript coerces silently (`NaN < 300` is false, "false" is
// truthy, `3 >= null` is true), so nothing here trusts the declared types: every value goes
// through the as*() readers below, which turn anything missing or ill-typed into null, and a
// check that needs a value it could not read is 'cantTell'. Flags are compared with ===.
//
// Check data - the contract with shared/text.ts. An unknown value is null.
//   armed                 {}
//   stopFile              {}
//   scanner               {reason: 'noScan' | 'stale' | 'errors' | null, errors: string[], roots: number | null}
//   helper                {problem: string | null, tier: HelperTier | null}
//   actionAllowed         {action: PowerAction | null, detail: string | null}
//   remoteWindows         {blocking: string[], ignored: string[], covered: string[]}
//                           each window is listed once; a covered window counts as covered even if ignored
//   registry              {reason: 'noProcessList' | 'unaccounted' | null, pids: number[], names: string[],
//                          strays: number | null}
//                           pids / names: unregistered processes that are neither waived nor stood in
//                           for by a transcript still waited for; strays: every unregistered one
//   unclaimedTranscripts  {count: number | null, project: string | null, secondsAgo: number | null,
//                          quietSeconds: number | null}   project / secondsAgo describe the newest one
//   hasSessions           {sawAny: boolean | null, secondsSinceLast: number | null, quietSeconds: number | null}
//   sessionsIdle          {total: number | null, working: number | null, cantTell: number | null,
//                          ignored: number | null, names: string[]}
//                           working + cantTell = the sessions this PC is waiting for; names lists them
//   turnsClosed           {names: string[], reasons: string[]}   parallel; reasons are TurnReason ids
//   quiet                 {quietestSeconds: number | null, name: string, quietSeconds: number | null}
//                           name: the quietest session, or the one whose silence is unknown
//   childProcesses        {items: string[]}   each "<name> (PID n) started by <session>", or for a
//                           stray's child "<name> (PID n) started by an unmatched Claude process (PID m)"
//   userIdle              {idleSeconds: number | null, userIdleSeconds: number | null}
//   guard                 {hits: string[]}
//   confirmed             {k: number, n: number | null}

import type { Capability, HelperTier } from '../platform/types';
import { INT_BOUNDS, POWER_ACTIONS } from '../shared/config';
import type { ArmContract, PowerAction } from '../shared/config';
import type { RemoteWindow } from '../shared/protocol';
import type { Check, CheckData, CheckId, CheckState, ScanResult, TurnState, Verdict } from './types';

export interface EvaluateInput {
  /** Latest completed scan; null = none yet (everything that needs it is 'cantTell'). */
  scan: ScanResult | null;
  /** The latest scan is too old to trust, or the engine stopped answering. */
  scanStale: boolean;
  contract: ArmContract;
  armed: boolean;
  /** Emergency stop is set (an unreadable state dir counts as set). */
  stopPresent: boolean;
  /** Preflight for contract.action; null = not checked yet. */
  capability: Capability | null;
  /** Platform.environmentProblem() */
  environmentProblem: string | null;
  helperTier: HelperTier;
  remoteWindows: readonly RemoteWindow[];
  /** Consecutive all-clear polls BEFORE this evaluation. */
  stablePolls: number;
  /** A session has been seen since this leader started (or was handed over). */
  sawAnySession: boolean;
  /** Seconds since a session was last seen; null = never. */
  secondsSinceLastSession: number | null;
}

/**
 * Pure. Never throws. Any missing / NaN / ill-typed value makes its check 'cantTell', never
 * 'pass'. Returns the checks in a fixed order with `confirmed` last.
 */
export function evaluate(input: EvaluateInput): Verdict {
  try {
    return runChecks(input);
  } catch (error) {
    // The readers make this unreachable for plain data. If it is reached anyway, the bug is ours,
    // and it must end in "this PC stays on" rather than in whatever the caller does with a throw.
    return blockedVerdict(error);
  }
}

// --- readers: the one boundary where untyped values become typed ones --------------------------

type Raw = Record<string, unknown>;

const UNNAMED = '?';
const HELPER_TIERS: readonly HelperTier[] = ['full', 'limited', 'unavailable'];
const UNREADABLE_SCAN = 'The last check returned a result that cannot be read.';
const UNREADABLE_ERROR = 'A problem was reported without a readable description.';

function asRecord(value: unknown): Raw | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

/** A dense copy: a hole becomes an undefined entry, which reads as unreadable instead of vanishing. */
function asList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? Array.from(value) : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A limit below the settings' own floor can only come from a contract that skipped validation.
 * Comparing against it would turn "quiet for 5 minutes" into "quiet for -1 seconds", so it is
 * unknown instead.
 */
function asLimit(value: unknown, floor: number): number | null {
  const limit = asFinite(value);
  return limit !== null && limit >= floor ? limit : null;
}

/** The parts of the arm contract the checks depend on. null = unreadable. */
interface Rules {
  action: PowerAction | null;
  quietSeconds: number | null;
  userIdleSeconds: number | null;
  requiredPolls: number | null;
  requireUserIdle: boolean | null;
  allowWhenNoSessions: boolean | null;
  waitForChildProcesses: boolean | null;
  /** Number of keep-on patterns. */
  guardPatterns: number | null;
}

function readRules(contract: unknown): Rules {
  const raw = asRecord(contract) ?? {};
  return {
    action: POWER_ACTIONS.find((known) => known === raw.action) ?? null,
    quietSeconds: asLimit(raw.quietSeconds, INT_BOUNDS.quietSeconds[0]),
    userIdleSeconds: asLimit(raw.userIdleSeconds, INT_BOUNDS.userIdleSeconds[0]),
    requiredPolls: Number.isInteger(raw.requiredPolls) ? asLimit(raw.requiredPolls, INT_BOUNDS.requiredPolls[0]) : null,
    requireUserIdle: asBool(raw.requireUserIdle),
    allowWhenNoSessions: asBool(raw.allowWhenNoSessions),
    waitForChildProcesses: asBool(raw.waitForChildProcesses),
    guardPatterns: asList(raw.guardProcesses)?.length ?? null,
  };
}

interface ChildView {
  /** "<name> (PID n)" */
  label: string;
  busy: boolean | null;
  ignored: boolean;
}

interface SessionView {
  name: string;
  ignored: boolean;
  /** null = the scanner's answer is unreadable, which blocks like `true`. */
  working: boolean | null;
  cantTell: boolean;
  turn: TurnState;
  turnReason: string;
  silenceSeconds: number | null;
  children: ChildView[] | null;
}

interface StrayView {
  pid: number | null;
  name: string;
  /** Stood in for by a transcript that is still waited for, or waived by the user. */
  cleared: boolean;
  /** Waited for even when the stray itself is waived. null = unreadable. */
  children: ChildView[] | null;
}

interface UnclaimedView {
  project: string | null;
  secondsAgo: number | null;
}

interface ScanView {
  sessions: SessionView[];
  errors: string[];
  roots: number;
  /** null = the process list could not be read. */
  strays: StrayView[] | null;
  unclaimed: UnclaimedView[];
  idleSeconds: number | null;
  guardHits: string[] | null;
  processListOk: boolean;
  helperProblem: string | null;
}

function readChild(value: unknown): ChildView {
  const raw = asRecord(value) ?? {};
  return {
    label: `${asText(raw.name) ?? UNNAMED} (PID ${asFinite(raw.pid) ?? UNNAMED})`,
    busy: asBool(raw.busy),
    ignored: raw.ignored === true,
  };
}

function readSession(value: unknown): SessionView {
  const raw = asRecord(value) ?? {};
  const working = asBool(raw.working);
  return {
    name: asText(raw.name) ?? UNNAMED,
    ignored: raw.ignored === true,
    working,
    cantTell: working === null || raw.status === 'cantTell',
    turn: raw.turn === 'CLOSED' || raw.turn === 'OPEN' ? raw.turn : 'UNKNOWN',
    turnReason: asText(raw.turnReason) ?? 'cannotRead',
    silenceSeconds: asFinite(raw.silenceSeconds),
    children: asList(raw.children)?.map(readChild) ?? null,
  };
}

function readStray(value: unknown): StrayView {
  const raw = asRecord(value) ?? {};
  return {
    pid: asFinite(raw.pid),
    name: asText(raw.name) ?? UNNAMED,
    cleared: raw.accounted === true || raw.ignored === true,
    children: asList(raw.children)?.map(readChild) ?? null,
  };
}

function readUnclaimed(value: unknown): UnclaimedView {
  const raw = asRecord(value) ?? {};
  return { project: asText(raw.project), secondsAgo: asFinite(raw.secondsAgo) };
}

/** null when the value is not shaped like a scan: a result we cannot read is no result. */
function readScan(value: unknown): ScanView | null {
  const raw = asRecord(value);
  const sessions = asList(raw?.sessions);
  const errors = asList(raw?.errors);
  const roots = asList(raw?.roots);
  const unclaimed = asList(raw?.unclaimedRecent);
  if (raw === null || sessions === null || errors === null || roots === null || unclaimed === null) return null;
  return {
    sessions: sessions.map(readSession),
    errors: errors.map((error) => asText(error) ?? UNREADABLE_ERROR),
    roots: roots.length,
    strays: asList(raw.strays)?.map(readStray) ?? null,
    unclaimed: unclaimed.map(readUnclaimed),
    idleSeconds: asFinite(raw.idleSeconds),
    guardHits: asList(raw.guardHits)?.map((hit) => asText(hit) ?? UNNAMED) ?? null,
    processListOk: raw.processListOk === true,
    helperProblem: asText(raw.helperProblem),
  };
}

// --- checks ------------------------------------------------------------------------------------

function check(id: CheckId, state: CheckState, data: CheckData = {}): Check {
  return { id, state, data };
}

function armedCheck(armed: unknown): Check {
  return check('armed', armed === true ? 'pass' : armed === false ? 'waiting' : 'cantTell');
}

function stopFileCheck(stopPresent: unknown): Check {
  return check('stopFile', stopPresent === false ? 'pass' : stopPresent === true ? 'fail' : 'cantTell');
}

function scannerCheck(rawScan: unknown, scan: ScanView | null, scanStale: unknown): Check {
  const missing = rawScan === null || rawScan === undefined;
  const errors = scan !== null ? scan.errors : missing ? [] : [UNREADABLE_SCAN];
  // A scanner that failed returns no sessions, and no sessions would pass everything below:
  // "I see nothing" must not read as "nothing is working".
  const reason = missing ? 'noScan' : scanStale !== false ? 'stale' : errors.length > 0 ? 'errors' : null;
  return check('scanner', reason === null ? 'pass' : 'cantTell', { reason, errors, roots: scan?.roots ?? null });
}

function helperCheck(environmentProblem: unknown, helperTier: unknown, scan: ScanView | null): Check {
  const problem = asText(environmentProblem);
  const tier = HELPER_TIERS.find((known) => known === helperTier) ?? null;
  const data = { problem: problem ?? scan?.helperProblem ?? null, tier };
  if (problem !== null || tier === 'unavailable') return check('helper', 'fail', data);
  // Only an explicit null says "no problem": an empty or ill-typed answer is no answer.
  const answered = environmentProblem === null && tier !== null;
  const processListOk = scan === null || scan.processListOk;
  return check('helper', answered && processListOk ? 'pass' : 'cantTell', data);
}

function actionAllowedCheck(action: PowerAction | null, capability: unknown): Check {
  const preflight = asRecord(capability);
  const data = { action, detail: asText(preflight?.detail) };
  // 'notify' does nothing to this PC, so there is nothing to preflight.
  if (action === 'notify' || (action !== null && preflight?.ok === true)) return check('actionAllowed', 'pass', data);
  if (action !== null && preflight?.ok === false) return check('actionAllowed', 'fail', data);
  return check('actionAllowed', 'cantTell', data);
}

function remoteWindowsCheck(remoteWindows: unknown): Check | null {
  const windows = asList(remoteWindows);
  const blocking: string[] = [];
  const ignored: string[] = [];
  const covered: string[] = [];
  if (windows === null) return check('remoteWindows', 'cantTell', { blocking, ignored, covered });
  if (windows.length === 0) return null;
  for (const entry of windows) {
    const window = asRecord(entry);
    const name = asText(window?.name) ?? UNNAMED;
    if (window?.covered === true) covered.push(name);
    else if (window?.ignored === true) ignored.push(name);
    else blocking.push(name);
  }
  // Sessions on the other side of a remote window are invisible from here.
  return check('remoteWindows', blocking.length > 0 ? 'cantTell' : 'pass', { blocking, ignored, covered });
}

function registryCheck(scan: ScanView | null): Check {
  const strays = scan?.strays ?? null;
  if (strays === null) {
    return check('registry', 'cantTell', { reason: 'noProcessList', pids: [], names: [], strays: null });
  }
  // A Claude process the registry does not list would otherwise be invisible to every check.
  const unaccounted = strays.filter((stray) => !stray.cleared);
  return check('registry', unaccounted.length > 0 ? 'cantTell' : 'pass', {
    reason: unaccounted.length > 0 ? 'unaccounted' : null,
    pids: unaccounted.flatMap((stray) => (stray.pid === null ? [] : [stray.pid])),
    names: unaccounted.map((stray) => stray.name),
    strays: strays.length,
  });
}

function newestUnclaimed(entries: readonly UnclaimedView[]): UnclaimedView | null {
  return entries.reduce<UnclaimedView | null>(
    (newest, entry) =>
      newest === null || (entry.secondsAgo ?? Infinity) < (newest.secondsAgo ?? Infinity) ? entry : newest,
    null,
  );
}

function unclaimedTranscriptsCheck(scan: ScanView | null, quietSeconds: number | null): Check {
  if (scan === null) {
    return check('unclaimedTranscripts', 'cantTell', { count: null, project: null, secondsAgo: null, quietSeconds });
  }
  const newest = newestUnclaimed(scan.unclaimed);
  return check('unclaimedTranscripts', newest === null ? 'pass' : 'waiting', {
    count: scan.unclaimed.length,
    project: newest?.project ?? null,
    secondsAgo: newest?.secondsAgo ?? null,
    quietSeconds,
  });
}

function hasSessionsCheck(
  scan: ScanView | null,
  rules: Rules,
  sawAnySession: unknown,
  secondsSinceLastSession: unknown,
): Check | null {
  if (scan === null || scan.sessions.length > 0) return null;
  const sawAny = asBool(sawAnySession);
  const secondsSinceLast = asFinite(secondsSinceLastSession);
  const { allowWhenNoSessions, quietSeconds } = rules;
  const data = { sawAny, secondsSinceLast, quietSeconds };
  if (allowWhenNoSessions === true) return check('hasSessions', 'pass', data);
  if (allowWhenNoSessions === null || sawAny === null || quietSeconds === null) {
    return check('hasSessions', 'cantTell', data);
  }
  if (!sawAny) return check('hasSessions', 'waiting', data);
  // Seen, but not knowing when the last one ended is not "long enough ago".
  if (secondsSinceLast === null) return check('hasSessions', 'cantTell', data);
  // No sessions must not be a faster way to the action than an idle session: closing the last
  // Claude window by mistake would otherwise turn the PC off before anyone notices.
  return check('hasSessions', secondsSinceLast >= quietSeconds ? 'pass' : 'waiting', data);
}

function sessionsIdleCheck(scan: ScanView | null): Check {
  if (scan === null) {
    return check('sessionsIdle', 'cantTell', { total: null, working: null, cantTell: null, ignored: null, names: [] });
  }
  const blocking = scan.sessions.filter((session) => session.working !== false && !session.ignored);
  const cantTell = blocking.filter((session) => session.cantTell).length;
  return check('sessionsIdle', blocking.length === 0 ? 'pass' : cantTell > 0 ? 'cantTell' : 'waiting', {
    total: scan.sessions.length,
    working: blocking.length - cantTell,
    cantTell,
    ignored: scan.sessions.filter((session) => session.ignored).length,
    names: blocking.map((session) => session.name),
  });
}

function turnsClosedCheck(scan: ScanView | null): Check {
  if (scan === null) return check('turnsClosed', 'cantTell', { names: [], reasons: [] });
  // Not only OPEN blocks: a turn we could not read says nothing about the session being done.
  const unclosed = scan.sessions.filter((session) => !session.ignored && session.turn !== 'CLOSED');
  const anyUnknown = unclosed.some((session) => session.turn === 'UNKNOWN');
  return check('turnsClosed', unclosed.length === 0 ? 'pass' : anyUnknown ? 'cantTell' : 'waiting', {
    names: unclosed.map((session) => session.name),
    reasons: unclosed.map((session) => session.turnReason),
  });
}

function quietCheck(scan: ScanView | null, quietSeconds: number | null): Check | null {
  let quietest: { name: string; seconds: number } | null = null;
  for (const session of scan?.sessions ?? []) {
    if (session.ignored) continue;
    if (session.silenceSeconds === null) {
      return check('quiet', 'cantTell', { quietestSeconds: null, name: session.name, quietSeconds });
    }
    if (quietest === null || session.silenceSeconds < quietest.seconds) {
      quietest = { name: session.name, seconds: session.silenceSeconds };
    }
  }
  if (quietest === null) return null;
  const data = { quietestSeconds: quietest.seconds, name: quietest.name, quietSeconds };
  if (quietSeconds === null) return check('quiet', 'cantTell', data);
  return check('quiet', quietest.seconds >= quietSeconds ? 'pass' : 'waiting', data);
}

function childProcessesCheck(scan: ScanView | null, waitForChildProcesses: boolean | null): Check | null {
  if (waitForChildProcesses === false) return null;
  // A setting that is neither on nor off must not silently switch the gate off.
  if (waitForChildProcesses === null) return check('childProcesses', 'cantTell', { items: [] });
  if (scan === null) return null;
  // A stray's children count even when the stray is waived: letting the process go is not
  // letting go of the build it left running.
  const parents = [
    ...scan.sessions.filter((session) => !session.ignored).map((session) => ({ name: session.name, children: session.children })),
    ...(scan.strays ?? []).map((stray) => ({
      name: `an unmatched Claude process (PID ${stray.pid ?? UNNAMED})`,
      children: stray.children,
    })),
  ];
  const items: string[] = [];
  let unreadable = false;
  for (const parent of parents) {
    if (parent.children === null) {
      unreadable = true;
      continue;
    }
    for (const child of parent.children) {
      if (child.ignored || child.busy === false) continue;
      if (child.busy === null) unreadable = true;
      items.push(`${child.label} started by ${parent.name}`);
    }
  }
  return check('childProcesses', unreadable ? 'cantTell' : items.length > 0 ? 'waiting' : 'pass', { items });
}

function userIdleCheck(scan: ScanView | null, rules: Rules): Check | null {
  const { requireUserIdle, userIdleSeconds } = rules;
  if (requireUserIdle === false) return null;
  const idleSeconds = scan?.idleSeconds ?? null;
  const data = { idleSeconds, userIdleSeconds };
  // Unknown idle time is not "away": the person may be sitting right here.
  if (requireUserIdle === null || idleSeconds === null || userIdleSeconds === null) {
    return check('userIdle', 'cantTell', data);
  }
  return check('userIdle', idleSeconds >= userIdleSeconds ? 'pass' : 'waiting', data);
}

function guardCheck(scan: ScanView | null, guardPatterns: number | null): Check | null {
  if (guardPatterns === 0) return null;
  const hits = scan?.guardHits ?? null;
  // No process list is not "nothing on the keep-on list is running".
  if (guardPatterns === null || hits === null) return check('guard', 'cantTell', { hits: hits ?? [] });
  return check('guard', hits.length > 0 ? 'waiting' : 'pass', { hits });
}

/** Consecutive all-clear polls including this one; null = the count so far is unreadable. */
function countStablePolls(allClear: boolean, stablePollsBefore: unknown): number | null {
  if (!allClear) return 0;
  const before = asFinite(stablePollsBefore);
  return before !== null && Number.isSafeInteger(before) && before >= 0 ? before + 1 : null;
}

// --- verdict -----------------------------------------------------------------------------------

/**
 * Reported as Verdict.requiredPolls when the contract's own count is unreadable: the strictest
 * count the settings allow, so that no consumer comparing k with n can read it as "confirmed".
 */
const STRICTEST_REQUIRED_POLLS = INT_BOUNDS.requiredPolls[1];

function runChecks(input: unknown): Verdict {
  const raw = asRecord(input) ?? {};
  const rules = readRules(raw.contract);
  const scan = readScan(raw.scan);

  const checks = [
    armedCheck(raw.armed),
    stopFileCheck(raw.stopPresent),
    scannerCheck(raw.scan, scan, raw.scanStale),
    helperCheck(raw.environmentProblem, raw.helperTier, scan),
    actionAllowedCheck(rules.action, raw.capability),
    remoteWindowsCheck(raw.remoteWindows),
    registryCheck(scan),
    unclaimedTranscriptsCheck(scan, rules.quietSeconds),
    hasSessionsCheck(scan, rules, raw.sawAnySession, raw.secondsSinceLastSession),
    sessionsIdleCheck(scan),
    turnsClosedCheck(scan),
    quietCheck(scan, rules.quietSeconds),
    childProcessesCheck(scan, rules.waitForChildProcesses),
    userIdleCheck(scan, rules),
    guardCheck(scan, rules.guardPatterns),
  ].filter((entry): entry is Check => entry !== null);

  const allClear = checks.every((entry) => entry.state === 'pass');
  const stable = countStablePolls(allClear, raw.stablePolls);
  const n = rules.requiredPolls;
  // Without both numbers nothing is confirmed, so the count restarts rather than carrying on.
  const k = stable !== null && n !== null ? stable : 0;
  const confirmed: CheckState = stable === null || n === null ? 'cantTell' : k >= n ? 'pass' : 'waiting';
  checks.push(check('confirmed', confirmed, { k, n }));

  return {
    checks,
    allClear,
    ok: allClear && confirmed === 'pass',
    stablePolls: k,
    requiredPolls: n ?? STRICTEST_REQUIRED_POLLS,
  };
}

function blockedVerdict(error: unknown): Verdict {
  const cause = error instanceof Error && typeof error.message === 'string' ? error.message : 'unknown error';
  return {
    checks: [
      check('scanner', 'cantTell', {
        reason: 'errors',
        errors: [`The checks could not be evaluated: ${cause}`],
        roots: null,
      }),
      check('confirmed', 'cantTell', { k: 0, n: null }),
    ],
    allClear: false,
    ok: false,
    stablePolls: 0,
    requiredPolls: STRICTEST_REQUIRED_POLLS,
  };
}
