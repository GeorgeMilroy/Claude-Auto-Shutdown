// Synthetic inputs for the evaluate tests. Nothing here touches the file system: the paths are
// strings that are never opened.

import type { EvaluateInput } from '../../src/core/evaluate';
import type {
  Check,
  CheckId,
  CheckState,
  ChildProcessInfo,
  ScanResult,
  Session,
  StrayProcess,
  SubagentInfo,
  Verdict,
} from '../../src/core/types';
import { DEFAULT_CONFIG, toArmContract } from '../../src/shared/config';
import type { ArmContract, Config } from '../../src/shared/config';
import type { RemoteWindow } from '../../src/shared/protocol';

/** Every check id, in the order evaluate() must emit them. */
export const CHECK_ORDER: readonly CheckId[] = [
  'armed',
  'stopFile',
  'scanner',
  'helper',
  'actionAllowed',
  'remoteWindows',
  'registry',
  'unclaimedTranscripts',
  'hasSessions',
  'sessionsIdle',
  'turnsClosed',
  'quiet',
  'childProcesses',
  'userIdle',
  'guard',
  'confirmed',
];

/** Defaults: shut down, quiet 300 s, 3 polls, away 600 s, wait for child processes, no keep-on list. */
export function contract(overrides: Partial<Config> = {}): ArmContract {
  return toArmContract({ ...DEFAULT_CONFIG, ...overrides });
}

/** A finished session: turn ended, quiet for 15 minutes. */
export function session(overrides: Partial<Session> = {}): Session {
  return {
    key: '0:4242:aaaa1111',
    origin: 'registry',
    liveness: 'verified',
    pid: 4242,
    sessionId: 'aaaa1111-0000-4000-8000-000000000001',
    name: 'web-ui',
    cwd: 'C:\\work\\web-ui',
    folder: 'web-ui',
    entrypoint: 'cli',
    rootLabel: '~/.claude',
    startedAtMs: 1_790_000_000_000,
    transcriptPath: 'C:\\fixture\\.claude\\projects\\web-ui\\aaaa1111.jsonl',
    lastActivityMs: 1_790_000_100_000,
    silenceSeconds: 900,
    turn: 'CLOSED',
    turnReason: 'turnEnded',
    turnDetail: null,
    kind: 'interactive',
    claudeStatus: null,
    waitingFor: null,
    claudeStatusSinceMs: null,
    turnSource: 'transcript',
    activeSubagents: 0,
    subagents: [],
    children: [],
    status: 'finished',
    working: false,
    why: { id: 'quiet' },
    ignoreKey: 'session:0:4242:aaaa1111:2048:1790000100:0',
    ignored: false,
    ...overrides,
  };
}

/** Mid-turn: a tool call is in flight. */
export function workingSession(overrides: Partial<Session> = {}): Session {
  return session({
    key: '0:5151:bbbb2222',
    pid: 5151,
    name: 'api',
    silenceSeconds: 12,
    turn: 'OPEN',
    turnReason: 'toolInFlight',
    status: 'working',
    working: true,
    why: { id: 'turnOpen' },
    ignoreKey: 'session:0:5151:bbbb2222:4096:1790000900:0',
    ...overrides,
  });
}

/** The turn ended, but more recently than the quiet target. */
export function justFinishedSession(overrides: Partial<Session> = {}): Session {
  return session({
    key: '0:6161:cccc3333',
    pid: 6161,
    name: 'docs',
    silenceSeconds: 40,
    status: 'justFinished',
    working: true,
    why: { id: 'recentWrite' },
    ...overrides,
  });
}

/** No transcript could be read, so nothing is known about it. */
export function cantTellSession(overrides: Partial<Session> = {}): Session {
  return session({
    key: '0:7171:dddd4444',
    pid: 7171,
    name: 'scratch',
    transcriptPath: null,
    lastActivityMs: null,
    silenceSeconds: null,
    turn: 'UNKNOWN',
    turnReason: 'noTranscript',
    status: 'cantTell',
    working: true,
    why: { id: 'turnUnknown' },
    ...overrides,
  });
}

export function child(overrides: Partial<ChildProcessInfo> = {}): ChildProcessInfo {
  return {
    pid: 7001,
    name: 'npm',
    cpuPercent: 12.5,
    ioBytesPerSecond: 65_536,
    busy: true,
    ignoreKey: 'proc:7001:134000000000000000',
    ignored: false,
    ...overrides,
  };
}

export function subagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    name: 'agent-a1',
    path: 'C:\\fixture\\.claude\\projects\\web-ui\\aaaa1111\\subagents\\agent-a1.jsonl',
    mtimeMs: 1_790_000_050_000,
    turn: 'CLOSED',
    active: false,
    ...overrides,
  };
}

/** An unregistered Claude process that no transcript accounts for, with no busy children. */
export function stray(overrides: Partial<StrayProcess> = {}): StrayProcess {
  return {
    pid: 9001,
    name: 'claude',
    path: 'C:\\fixture\\bin\\claude.exe',
    accounted: false,
    ignoreKey: 'proc:9001:134000000000000001',
    ignored: false,
    children: [],
    ...overrides,
  };
}

/** A remote window that blocks: neither covered by a scanned root nor waived. */
export function remoteWindow(overrides: Partial<RemoteWindow> = {}): RemoteWindow {
  const name = overrides.name ?? 'SSH: build-box';
  return { name, ignoreKey: `remote:${name}`, ignored: false, covered: false, ...overrides };
}

/** A clean scan: one finished session, the user away for 20 minutes. */
export function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    startedAtMs: 1_790_001_000_000,
    completedAtMs: 1_790_001_000_150,
    sessions: [session()],
    errors: [],
    roots: [{ path: 'C:\\fixture\\.claude', label: '~/.claude', kind: 'local', ok: true, missing: false, detail: null }],
    strays: [],
    unclaimedRecent: [],
    idleSeconds: 1200,
    guardHits: [],
    processListOk: true,
    helperProblem: null,
    ...overrides,
  };
}

/** An input for which every check passes and this poll is the one that confirms it. */
export function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  const rules = overrides.contract ?? contract();
  return {
    scan: scan(),
    scanStale: false,
    contract: rules,
    armed: true,
    stopPresent: false,
    capability: { ok: true, detail: 'Allowed by Windows' },
    environmentProblem: null,
    helperTier: 'full',
    remoteWindows: [],
    stablePolls: rules.requiredPolls - 1,
    sawAnySession: true,
    secondsSinceLastSession: 0,
    ...overrides,
  };
}

/** For values the type system forbids: the whole point of these tests. */
export function illTyped<T>(value: unknown): T {
  return value as T;
}

export function ids(verdict: Verdict): CheckId[] {
  return verdict.checks.map((entry) => entry.id);
}

export function find(verdict: Verdict, id: CheckId): Check | undefined {
  return verdict.checks.find((entry) => entry.id === id);
}

export function stateOf(verdict: Verdict, id: CheckId): CheckState | 'omitted' {
  return find(verdict, id)?.state ?? 'omitted';
}

export function dataOf(verdict: Verdict, id: CheckId): Check['data'] | undefined {
  return find(verdict, id)?.data;
}

/** Ids of the checks that are not passing, `confirmed` excluded. */
export function unmet(verdict: Verdict): CheckId[] {
  return verdict.checks.filter((entry) => entry.id !== 'confirmed' && entry.state !== 'pass').map((entry) => entry.id);
}
