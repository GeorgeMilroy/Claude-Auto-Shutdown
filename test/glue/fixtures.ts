// Hand-built states for the glue tests. Nothing here touches another module's logic, the real
// ~/.claude or the machine: a UiState is just data.

import type { Check, Session } from '../../src/core/types';
import { DEFAULT_CONFIG, contractDigest, toArmContract } from '../../src/shared/config';
import type { ArmContract, Config } from '../../src/shared/config';
import type { CountdownState, LastResult, Role, UiState } from '../../src/shared/protocol';
import type { WindowSnapshot } from '../../src/ui/snapshot';

export const REALM = 'realm-of-this-editor';

export function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, guardProcesses: [], extraClaudeDirs: [], ...overrides };
}

export function contract(overrides: Partial<Config> = {}): ArmContract {
  return toArmContract(config(overrides));
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
    startedAtMs: 1_000,
    transcriptPath: 'C:\\fixture\\projects\\p\\abc.jsonl',
    lastActivityMs: 2_000,
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
    ignoreKey: 'session:0:9120:abc:10:2:0',
    ignored: false,
    ...overrides,
  };
}

export function uiState(overrides: Partial<UiState> = {}): UiState {
  const rules = overrides.contract ?? contract();
  return {
    v: 1,
    seq: 1,
    epoch: 'epoch-1',
    leader: { windowId: 'leader-window', label: 'api-refactor', app: 'Visual Studio Code', ext: '0.1.0', pid: 4321, realm: REALM },
    hostname: 'test-pc',
    phase: 'off',
    armed: false,
    armedAtMs: null,
    armedBy: null,
    contract: rules,
    contractDigest: contractDigest(rules),
    contractRealm: REALM,
    confirm: { k: 0, n: rules.requiredPolls, nextCheckInMs: null },
    countdown: null,
    cooldownRemainingMs: null,
    checks: [],
    sessions: [],
    sessionsOmitted: 0,
    strays: [],
    remoteWindows: [],
    scan: { engineActive: false, lastCompletedAgoMs: null, stale: false, errors: [], roots: [] },
    platform: {
      id: 'windows',
      osName: 'Windows',
      experimental: false,
      helperTier: 'full',
      problem: null,
      capability: null,
      capabilities: {},
      keepAwake: 'off',
    },
    stop: { present: false, dir: 'C:\\Users\\me\\.claude-auto-shutdown', auto: false },
    lastResult: null,
    testPassedOnce: false,
    activity: [],
    logFile: 'C:\\Users\\me\\.claude-auto-shutdown\\activity.log',
    ...overrides,
  };
}

export function watching(overrides: Partial<UiState> = {}): UiState {
  return uiState({ phase: 'watching', armed: true, armedAtMs: 1_700_000_000_000, armedBy: 'user', ...overrides });
}

export function countdown(overrides: Partial<CountdownState> = {}): CountdownState {
  return { id: 'countdown-1', kind: 'real', action: 'shutdown', totalMs: 90_000, remainingMs: 87_000, ...overrides };
}

export function counting(kind: CountdownState['kind'], overrides: Partial<UiState> = {}): UiState {
  const rules = contract({ testMode: kind !== 'real' });
  const armed = kind !== 'preview';
  return uiState({
    phase: 'countdown',
    armed,
    armedAtMs: armed ? 1_700_000_000_000 : null,
    armedBy: armed ? 'user' : null,
    contract: rules,
    countdown: countdown({ kind }),
    ...overrides,
  });
}

export function check(id: Check['id'], state: Check['state'], data: Check['data'] = {}): Check {
  return { id, state, data };
}

export function snapshot(state: UiState | null, overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  const role: Role = overrides.role ?? 'leader';
  return { role, state, limited: false, receivedAtMono: 1_000, ...overrides };
}

export function testPassed(atMs: number): LastResult {
  return {
    kind: 'testPassed',
    atMs,
    action: 'shutdown',
    armedAtMs: atMs - 3_600_000,
    lastSessionFinishedAtMs: atMs - 420_000,
    allClearAtMs: atMs - 120_000,
    heldUpBy: null,
  };
}
