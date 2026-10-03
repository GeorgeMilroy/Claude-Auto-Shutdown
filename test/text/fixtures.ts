// Synthetic data for the copy tests. Nothing here touches the disk, the clock or another module's
// logic: states are built by hand in the shape the contract files describe.

import { expect } from 'vitest';
import type { Check, CheckData, CheckId, CheckState, Session, TurnReason } from '../../src/core/types';
import { DEFAULT_CONFIG, POWER_ACTIONS, toArmContract } from '../../src/shared/config';
import type { ArmContract, PowerAction } from '../../src/shared/config';
import type { CancelReason, CountdownKind, CountdownState, Phase, UiState } from '../../src/shared/protocol';
import type { TextContext } from '../../src/shared/text';

export const ACTIONS: readonly PowerAction[] = POWER_ACTIONS;

/** Listing every member in a Record makes the compiler complain when the union grows. */
const CHECK_ID_SET: Record<CheckId, true> = {
  armed: true,
  stopFile: true,
  scanner: true,
  helper: true,
  actionAllowed: true,
  remoteWindows: true,
  registry: true,
  unclaimedTranscripts: true,
  hasSessions: true,
  sessionsIdle: true,
  turnsClosed: true,
  quiet: true,
  childProcesses: true,
  userIdle: true,
  guard: true,
  confirmed: true,
};
export const CHECK_IDS = Object.keys(CHECK_ID_SET) as CheckId[];

const CHECK_STATE_SET: Record<CheckState, true> = { pass: true, waiting: true, cantTell: true, fail: true };
export const CHECK_STATES = Object.keys(CHECK_STATE_SET) as CheckState[];

const TURN_REASON_SET: Record<TurnReason, true> = {
  turnEnded: true,
  toolInFlight: true,
  cutAtTokenLimit: true,
  replyInProgress: true,
  readingToolResult: true,
  thinking: true,
  compacting: true,
  recordBeingWritten: true,
  unknownRecord: true,
  noTranscript: true,
  cannotRead: true,
  noConversationRecord: true,
  ambiguousTranscripts: true,
};
export const TURN_REASONS = Object.keys(TURN_REASON_SET) as TurnReason[];

const PHASE_SET: Record<Phase, true> = {
  off: true,
  watching: true,
  confirming: true,
  countdown: true,
  committing: true,
  executing: true,
};
export const PHASES = Object.keys(PHASE_SET) as Phase[];

const COUNTDOWN_KIND_SET: Record<CountdownKind, true> = { real: true, test: true, preview: true };
export const COUNTDOWN_KINDS = Object.keys(COUNTDOWN_KIND_SET) as CountdownKind[];

/** One reason per CancelReason id (and every `via`), checked for completeness by the compiler. */
const CANCEL_REASON_BY_ID: { [K in CancelReason['id']]: Extract<CancelReason, { id: K }>[] } = {
  user: [
    { id: 'user', via: 'esc' },
    { id: 'user', via: 'button' },
    { id: 'user', via: 'statusBar' },
    { id: 'user', via: 'notification' },
    { id: 'user', via: 'osAlert' },
    { id: 'user', via: 'command' },
  ],
  userCameBack: [{ id: 'userCameBack' }],
  sessionResumed: [{ id: 'sessionResumed', name: 'web-ui' }],
  checkFailed: CHECK_IDS.map((check) => ({ id: 'checkFailed' as const, check })),
  settingsChanged: [{ id: 'settingsChanged' }],
  timeJump: [{ id: 'timeJump' }],
  leaderChanged: [{ id: 'leaderChanged' }],
  emergencyStop: [{ id: 'emergencyStop' }],
  stoppedWatching: [{ id: 'stoppedWatching' }],
  scanStale: [{ id: 'scanStale' }],
};
export const CANCEL_REASONS: CancelReason[] = Object.values(CANCEL_REASON_BY_ID).flat();

/** What a careless or foreign producer could put where a number or a string belongs. */
export const GARBAGE: readonly unknown[] = [NaN, Infinity, -Infinity, undefined, null, '', 'abc', '300', -1, {}, [], true];

/** A wall-clock time on a fixed winter day, in whatever time zone the tests run in. */
export function localMs(hours: number, minutes: number, seconds = 0): number {
  return new Date(2026, 0, 15, hours, minutes, seconds).getTime();
}

export function contract(overrides: Partial<ArmContract> = {}): ArmContract {
  return { ...toArmContract({ ...DEFAULT_CONFIG, guardProcesses: [], extraClaudeDirs: [] }), ...overrides };
}

export function session(overrides: Partial<Session> = {}): Session {
  return {
    key: '0:9120:abc',
    origin: 'registry',
    liveness: 'verified',
    pid: 9120,
    sessionId: 'abc',
    name: 'api-refactor',
    cwd: 'D:\\work\\api-refactor',
    folder: 'api-refactor',
    entrypoint: 'cli',
    rootLabel: '~/.claude',
    startedAtMs: localMs(23, 0),
    transcriptPath: 'C:\\fixture\\projects\\p\\abc.jsonl',
    lastActivityMs: localMs(23, 30),
    silenceSeconds: 18,
    turn: 'OPEN',
    turnReason: 'toolInFlight',
    turnDetail: null,
    activeSubagents: 0,
    subagents: [],
    children: [],
    status: 'working',
    working: true,
    why: { id: 'turnOpen' },
    ignoreKey: 'session:0:9120:abc:100:1:0',
    ignored: false,
    ...overrides,
  };
}

export function workingSession(name: string, overrides: Partial<Session> = {}): Session {
  return session({ name, key: `0:1:${name}`, ...overrides });
}

export function justFinishedSession(name: string, silenceSeconds = 18): Session {
  return session({
    name,
    key: `0:2:${name}`,
    turn: 'CLOSED',
    turnReason: 'turnEnded',
    status: 'justFinished',
    working: true,
    why: { id: 'recentWrite' },
    silenceSeconds,
  });
}

export function finishedSession(name: string, silenceSeconds = 3720): Session {
  return session({
    name,
    key: `0:3:${name}`,
    turn: 'CLOSED',
    turnReason: 'turnEnded',
    status: 'finished',
    working: false,
    why: { id: 'quiet' },
    silenceSeconds,
  });
}

export function cantTellSession(name: string): Session {
  return session({
    name,
    key: `0:4:${name}`,
    turn: 'UNKNOWN',
    turnReason: 'noTranscript',
    status: 'cantTell',
    working: true,
    why: { id: 'turnUnknown' },
    transcriptPath: null,
    silenceSeconds: 40,
  });
}

export function check(id: CheckId, state: CheckState, data: CheckData = {}): Check {
  return { id, state, data };
}

/** A check whose id or state is not one this version knows (it arrived from another version). */
export function foreignCheck(id: string, state: string, data: unknown = {}): Check {
  return { id, state, data } as unknown as Check;
}

export function context(overrides: Partial<TextContext> = {}): TextContext {
  return { contract: contract(), osName: 'Windows', sessions: [], ...overrides };
}

/** Plausible data for every check in every state, with the keys architecture.md section 4 lists. */
export const CHECK_DATA: Record<CheckId, Record<CheckState, CheckData>> = {
  armed: { pass: {}, waiting: {}, cantTell: {}, fail: {} },
  stopFile: { pass: {}, waiting: {}, cantTell: {}, fail: {} },
  scanner: {
    pass: { reason: '', errors: [], roots: 1 },
    waiting: { reason: 'stale', errors: [], roots: 1 },
    cantTell: { reason: 'errors', errors: ['Could not read sessions/12.json (EACCES).', 'second problem'], roots: 2 },
    fail: { reason: 'noScan', errors: [], roots: 0 },
  },
  helper: {
    pass: { problem: null, tier: 'full' },
    waiting: { problem: null, tier: 'limited' },
    cantTell: { problem: null, tier: 'full' },
    fail: { problem: 'The Windows helper did not start', tier: 'unavailable' },
  },
  actionAllowed: {
    pass: { action: 'shutdown', detail: 'Allowed by Windows' },
    waiting: { action: 'shutdown', detail: '' },
    cantTell: { action: 'hibernate', detail: '' },
    fail: { action: 'hibernate', detail: 'Hibernation is turned off on this PC' },
  },
  remoteWindows: {
    pass: { blocking: [], ignored: ['SSH: build-box'], covered: ['WSL: Ubuntu'] },
    waiting: { blocking: ['SSH: build-box'], ignored: [], covered: [] },
    cantTell: { blocking: ['SSH: build-box', 'Dev Container'], ignored: [], covered: [] },
    fail: { blocking: [], ignored: [], covered: [] },
  },
  registry: {
    pass: { reason: '', pids: [], names: [], strays: 0 },
    waiting: { reason: 'unaccounted', pids: [123], names: ['claude'], strays: 1 },
    cantTell: { reason: 'noProcessList', pids: [], names: [], strays: null },
    fail: { reason: 'unaccounted', pids: [123, 456], names: ['claude', 'claude'], strays: 2 },
  },
  unclaimedTranscripts: {
    pass: { count: 0, project: '', secondsAgo: null, quietSeconds: 300 },
    waiting: { count: 2, project: 'D--work-api', secondsAgo: 40, quietSeconds: 300 },
    cantTell: { count: 0, project: '', secondsAgo: null, quietSeconds: 300 },
    fail: { count: 1, project: 'D--work-api', secondsAgo: 40, quietSeconds: 300 },
  },
  hasSessions: {
    pass: { sawAny: true, secondsSinceLast: 900, quietSeconds: 300 },
    waiting: { sawAny: true, secondsSinceLast: 40, quietSeconds: 300 },
    cantTell: { sawAny: true, secondsSinceLast: null, quietSeconds: 300 },
    fail: { sawAny: null, secondsSinceLast: null, quietSeconds: 300 },
  },
  sessionsIdle: {
    pass: { total: 3, working: 0, cantTell: 0, ignored: 1, names: [] },
    waiting: { total: 3, working: 2, cantTell: 0, ignored: 0, names: ['api-refactor', 'web-ui'] },
    cantTell: { total: 3, working: 2, cantTell: 1, ignored: 0, names: ['api-refactor', 'web-ui', 'scratch'] },
    fail: { total: 1, working: 0, cantTell: 1, ignored: 0, names: ['scratch'] },
  },
  turnsClosed: {
    pass: { names: [], reasons: [] },
    waiting: { names: ['api-refactor', 'web-ui'], reasons: ['toolInFlight', 'thinking'] },
    cantTell: { names: ['scratch'], reasons: ['noTranscript'] },
    fail: { names: ['scratch'], reasons: ['somethingNew'] },
  },
  quiet: {
    pass: { quietestSeconds: 3720, name: 'infra', quietSeconds: 300 },
    waiting: { quietestSeconds: 18, name: 'docs', quietSeconds: 300 },
    cantTell: { quietestSeconds: null, name: 'scratch', quietSeconds: 300 },
    fail: { quietestSeconds: null, name: '', quietSeconds: 300 },
  },
  childProcesses: {
    pass: { items: [] },
    waiting: { items: ['npm (PID 4321) started by web-ui', 'cargo (PID 77) started by api-refactor'] },
    cantTell: { items: [] },
    fail: { items: ['npm (PID 4321) started by web-ui'] },
  },
  userIdle: {
    pass: { idleSeconds: 1500, userIdleSeconds: 600 },
    waiting: { idleSeconds: 4, userIdleSeconds: 600 },
    cantTell: { idleSeconds: null, userIdleSeconds: 600 },
    fail: { idleSeconds: null, userIdleSeconds: 600 },
  },
  guard: {
    pass: { hits: [] },
    waiting: { hits: ['ffmpeg'] },
    cantTell: { hits: [] },
    fail: { hits: ['ffmpeg', 'blender'] },
  },
  confirmed: {
    pass: { k: 3, n: 3 },
    waiting: { k: 1, n: 3 },
    cantTell: { k: 0, n: null },
    fail: { k: 0, n: 3 },
  },
};

export function typicalCheck(id: CheckId, state: CheckState): Check {
  return check(id, state, CHECK_DATA[id][state]);
}

/** Every check passing, in evaluation order. */
export function allPassing(): Check[] {
  return CHECK_IDS.map((id) => typicalCheck(id, 'pass'));
}

/** Every check passing except the given ones (matched by id). */
export function checksWith(...unmet: Check[]): Check[] {
  return allPassing().map((passing) => unmet.find((other) => other.id === passing.id) ?? passing);
}

export function countdown(kind: CountdownKind, overrides: Partial<CountdownState> = {}): CountdownState {
  return { id: 'cd-1', kind, action: 'shutdown', totalMs: 90_000, remainingMs: 87_000, ...overrides };
}

export function uiState(overrides: Partial<UiState> = {}): UiState {
  const rules = overrides.contract ?? contract();
  return {
    v: 1,
    seq: 7,
    epoch: 'epoch-1',
    leader: { windowId: 'w1', label: 'api-refactor', app: 'Visual Studio Code', ext: '0.1.0', pid: 4242, realm: 'realm-1' },
    hostname: 'DESKTOP-TEST',
    phase: 'off',
    armed: false,
    armedAtMs: null,
    armedBy: null,
    contract: rules,
    contractDigest: 'digest',
    contractRealm: 'realm-1',
    confirm: { k: 0, n: rules.requiredPolls, nextCheckInMs: null },
    countdown: null,
    cooldownRemainingMs: null,
    checks: allPassing(),
    sessions: [],
    sessionsOmitted: 0,
    strays: [],
    remoteWindows: [],
    scan: { engineActive: true, lastCompletedAgoMs: 3000, stale: false, errors: [], roots: [] },
    platform: {
      id: 'windows',
      osName: 'Windows',
      experimental: false,
      helperTier: 'full',
      problem: null,
      capability: { ok: true, detail: 'Allowed by Windows' },
      capabilities: {},
      keepAwake: 'off',
    },
    stop: { present: false, dir: 'C:\\fixture\\.claude-auto-shutdown', auto: false },
    lastResult: null,
    testPassedOnce: true,
    activity: [],
    logFile: 'C:\\fixture\\.claude-auto-shutdown\\activity.log',
    ...overrides,
  };
}

export function watchingState(overrides: Partial<UiState> = {}): UiState {
  return uiState({ phase: 'watching', armed: true, armedAtMs: localMs(23, 2), armedBy: 'user', ...overrides });
}

/** Every string reachable inside a value (arrays and plain objects are walked). */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

const LEAKED_VALUE = /NaN|undefined|null|Infinity/;
const BANNED_PHRASE = /Waiting for you/;

/** No string inside `value` shows a raw unknown or the banned session wording. */
export function expectPrintable(value: unknown): void {
  for (const text of stringsIn(value)) {
    expect(text).not.toMatch(LEAKED_VALUE);
    expect(text).not.toMatch(BANNED_PHRASE);
  }
}
