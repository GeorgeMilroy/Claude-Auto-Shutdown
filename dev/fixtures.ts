// Fixture states for the browser harness (and for the webview tests): one entry per dashboard
// state the UI spec names. Everything is typed against UiState / ViewContext, so a protocol change
// breaks this file at compile time instead of silently rotting the harness.
//
// All data is synthetic. Times are relative to the `now` handed to build(), so "watching since"
// and "wrote 4 s ago" stay plausible whenever the harness is opened.

import type { Check, CheckData, CheckId, CheckState, ChildProcessInfo, Session, StrayProcess, SubagentInfo, TranscriptEvent } from '../src/core/types';
import { DEFAULT_CONFIG, toArmContract } from '../src/shared/config';
import type { ArmContract, PowerAction } from '../src/shared/config';
import type { CountdownKind, CountdownState, LastResult, RemoteWindow, UiState, ViewContext } from '../src/shared/protocol';
import type { Capability } from '../src/platform/types';

export interface FixtureData {
  state: UiState | null;
  view: ViewContext;
  /** Transcript previews by session key, served when the dashboard asks for them. */
  previews?: Record<string, TranscriptEvent[]>;
}

export interface Fixture {
  id: string;
  group: string;
  title: string;
  build(now: number): FixtureData;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// --- building blocks ---------------------------------------------------------------------------

function contract(overrides: Partial<ArmContract> = {}): ArmContract {
  return { ...toArmContract({ ...DEFAULT_CONFIG, guardProcesses: [], extraClaudeDirs: [] }), ...overrides };
}

function view(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    role: 'leader',
    limited: false,
    plan: contract(),
    windowLabel: 'api-refactor',
    unsavedFiles: 0,
    pending: null,
    autoStopSet: false,
    ...overrides,
  };
}

function session(name: string, overrides: Partial<Session> = {}): Session {
  return {
    key: `0:9120:${name}`,
    origin: 'registry',
    liveness: 'verified',
    pid: 9120,
    sessionId: `${name}-0000-4000-8000-000000000000`,
    name,
    cwd: `D:\\work\\${name}`,
    folder: name,
    entrypoint: 'cli',
    rootLabel: '~/.claude',
    startedAtMs: null,
    transcriptPath: `C:\\fixture\\.claude\\projects\\D--work-${name}\\${name}.jsonl`,
    lastActivityMs: null,
    silenceSeconds: 18,
    turn: 'OPEN',
    turnReason: 'toolInFlight',
    turnDetail: null,
    kind: 'interactive',
    claudeStatus: null,
    waitingFor: null,
    claudeStatusSinceMs: null,
    turnSource: 'transcript',
    activeSubagents: 0,
    subagents: [],
    children: [],
    status: 'working',
    working: true,
    why: { id: 'turnOpen' },
    ignoreKey: `session:0:9120:${name}:1024:1700000000:0`,
    ignored: false,
    ...overrides,
  };
}

function subagent(name: string, mtimeMs: number, active: boolean): SubagentInfo {
  return {
    name,
    path: `C:\\fixture\\.claude\\projects\\p\\session\\subagents\\${name}.jsonl`,
    mtimeMs,
    turn: active ? 'OPEN' : 'CLOSED',
    active,
  };
}

function child(name: string, pid: number, ignored = false): ChildProcessInfo {
  return { pid, name, cpuPercent: 37, ioBytesPerSecond: 120_000, busy: true, ignoreKey: `proc:${pid}:133800000000000000`, ignored };
}

/** A Claude process with no registry entry, with the busy commands it started (the scan keeps 10). */
function stray(fields: Omit<StrayProcess, 'children'>, children: ChildProcessInfo[] = []): StrayProcess {
  return { ...fields, children } as StrayProcess;
}

function working(name: string, now: number, overrides: Partial<Session> = {}): Session {
  return session(name, { lastActivityMs: now - 18 * SECOND, startedAtMs: now - 3 * HOUR, ...overrides });
}

function justFinished(name: string, now: number, silenceSeconds = 18): Session {
  return session(name, {
    key: `0:9200:${name}`,
    pid: 9200,
    turn: 'CLOSED',
    turnReason: 'turnEnded',
    status: 'justFinished',
    why: { id: 'recentWrite' },
    silenceSeconds,
    lastActivityMs: now - silenceSeconds * SECOND,
    ignoreKey: `session:0:9200:${name}:2048:1700000000:0`,
  });
}

function finished(name: string, now: number, silenceSeconds = 3720, pid = 9300): Session {
  return session(name, {
    key: `0:${pid}:${name}`,
    pid,
    turn: 'CLOSED',
    turnReason: 'turnEnded',
    status: 'finished',
    working: false,
    why: { id: 'quiet' },
    silenceSeconds,
    lastActivityMs: now - silenceSeconds * SECOND,
    ignoreKey: `session:0:${pid}:${name}:4096:1700000000:0`,
  });
}

function cantTell(name: string, overrides: Partial<Session> = {}): Session {
  return session(name, {
    key: `0:9400:${name}`,
    pid: 9400,
    turn: 'UNKNOWN',
    turnReason: 'noTranscript',
    status: 'cantTell',
    why: { id: 'turnUnknown' },
    transcriptPath: null,
    silenceSeconds: 40,
    ignoreKey: `session:0:9400:${name}:0:0:0`,
    ...overrides,
  });
}

/** api-refactor: a tool call in flight, two subagents, one build it started. */
function apiRefactor(now: number): Session {
  return working('api-refactor', now, {
    activeSubagents: 1,
    subagents: [subagent('agent-a1', now - 4 * SECOND, true), subagent('agent-b7', now - 6 * MINUTE, false)],
    why: { id: 'subagentsActive', count: 1 },
  });
}

/** web-ui: an open turn that has written nothing for 47 minutes (the stuck hint). */
function webUi(now: number, overrides: Partial<Session> = {}): Session {
  return working('web-ui', now, {
    key: '0:9130:web-ui',
    pid: 9130,
    entrypoint: 'claude-vscode',
    silenceSeconds: 47 * 60,
    lastActivityMs: now - 47 * MINUTE,
    ignoreKey: 'session:0:9130:web-ui:8192:1700000000:0',
    ...overrides,
  });
}

type CheckSpec = [CheckState, CheckData?];

/** Checks in evaluation order, all passing except the overrides. `extra` adds the optional checks. */
function checks(
  rules: ArmContract,
  overrides: Partial<Record<CheckId, CheckSpec>> = {},
  extra: readonly CheckId[] = [],
): Check[] {
  const passing: Record<CheckId, CheckData> = {
    armed: {},
    stopFile: {},
    scanner: { reason: '', errors: [], roots: 1 },
    helper: { problem: null, tier: 'full' },
    actionAllowed: { action: rules.action, detail: 'Allowed by Windows' },
    remoteWindows: { blocking: [], ignored: [], covered: [] },
    registry: { reason: '', pids: [], names: [], strays: 0 },
    unclaimedTranscripts: { count: 0, project: '', secondsAgo: null, quietSeconds: rules.quietSeconds },
    hasSessions: { sawAny: true, secondsSinceLast: 900, quietSeconds: rules.quietSeconds },
    sessionsIdle: { total: 3, working: 0, cantTell: 0, ignored: 0, names: [] },
    turnsClosed: { names: [], reasons: [] },
    quiet: { quietestSeconds: 3720, name: 'infra', quietSeconds: rules.quietSeconds },
    childProcesses: { items: [] },
    userIdle: { idleSeconds: 1500, userIdleSeconds: rules.userIdleSeconds },
    guard: { hits: [] },
    confirmed: { k: 0, n: rules.requiredPolls },
  };
  const optional: readonly CheckId[] = ['remoteWindows', 'hasSessions', 'guard'];
  const order = Object.keys(passing) as CheckId[];
  return order
    .filter((id) => !optional.includes(id) || extra.includes(id) || overrides[id] !== undefined)
    .filter((id) => id !== 'userIdle' || rules.requireUserIdle)
    .map((id) => {
      const override = overrides[id];
      // The re-check is the one check that cannot pass by default: it needs polls in a row.
      const state = override?.[0] ?? (id === 'confirmed' ? 'waiting' : 'pass');
      return { id, state, data: { ...passing[id], ...(override?.[1] ?? {}) } };
    });
}

const CAPABLE: Capability = { ok: true, detail: 'Allowed by Windows' };

function baseState(now: number, overrides: Partial<UiState> = {}): UiState {
  const rules = overrides.contract ?? contract();
  return {
    v: 1,
    seq: 42,
    epoch: 'fixture-epoch',
    leader: { windowId: 'w1', label: 'api-refactor', app: 'Visual Studio Code', ext: '0.1.0', pid: 4242, realm: 'fixture-realm' },
    hostname: 'DESKTOP-FIXTURE',
    phase: 'off',
    armed: false,
    armedAtMs: null,
    armedBy: null,
    contract: rules,
    contractDigest: 'fixture-digest',
    contractRealm: 'fixture-realm',
    confirm: { k: 0, n: rules.requiredPolls, nextCheckInMs: null },
    countdown: null,
    cooldownRemainingMs: null,
    checks: checks(rules, { armed: ['waiting'] }),
    sessions: [],
    sessionsOmitted: 0,
    strays: [],
    remoteWindows: [],
    scan: {
      engineActive: true,
      lastCompletedAgoMs: 3 * SECOND,
      stale: false,
      errors: [],
      roots: [{ path: 'C:\\fixture\\.claude', label: '~/.claude', kind: 'local', ok: true, missing: false, detail: null }],
    },
    platform: {
      id: 'windows',
      osName: 'Windows',
      experimental: false,
      helperTier: 'full',
      problem: null,
      capability: CAPABLE,
      capabilities: { shutdown: CAPABLE, hibernate: CAPABLE, sleep: CAPABLE, lock: CAPABLE, notify: { ok: true, detail: 'Only a message.' } },
      keepAwake: 'off',
    },
    stop: { present: false, dir: 'C:\\fixture\\.claude-auto-shutdown', auto: false },
    lastResult: null,
    testPassedOnce: true,
    activity: [{ atMs: now - 3 * HOUR, level: 'info', text: 'Dashboard opened.' }],
    logFile: 'C:\\fixture\\.claude-auto-shutdown\\activity.log',
    ...overrides,
  };
}

function watching(now: number, rules: ArmContract, overrides: Partial<UiState> = {}): UiState {
  return baseState(now, {
    phase: 'watching',
    armed: true,
    armedAtMs: now - 3 * HOUR - 12 * MINUTE,
    armedBy: 'user',
    contract: rules,
    confirm: { k: 0, n: rules.requiredPolls, nextCheckInMs: 6 * SECOND },
    platform: { ...baseState(now).platform, keepAwake: 'held' },
    ...overrides,
  });
}

function hhmmss(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

function event(now: number, secondsAgo: number, who: TranscriptEvent['who'], kind: TranscriptEvent['kind'], text: string): TranscriptEvent {
  return { time: hhmmss(now - secondsAgo * SECOND), who, sidechain: false, text, kind };
}

/** Oldest first, as the host delivers them. */
function apiPreview(now: number): TranscriptEvent[] {
  return [
    event(now, 410, 'you', 'text', 'the retry logic in src/client.ts looks off, can you check it and run the tests'),
    event(now, 402, 'claude', 'thinking', '(thinking)'),
    event(now, 395, 'claude', 'tool', 'Read: src/client.ts'),
    event(now, 394, 'you', 'result', 'export class Client { private retries = 3; async request(url: string) {'),
    event(now, 350, 'claude', 'text', 'The backoff never resets after a success. I will fix that and add a test.'),
    event(now, 340, 'claude', 'tool', 'Edit: src/client.ts'),
    event(now, 339, 'you', 'result', 'The file src/client.ts has been updated.'),
    event(now, 300, 'claude', 'tool', 'Write: test/client.retry.test.ts'),
    event(now, 299, 'you', 'result', 'File created successfully.'),
    event(now, 120, 'claude', 'tool', 'Agent: review the new retry test for flakiness'),
    event(now, 24, 'you', 'text', 'run the tests'),
    event(now, 18, 'claude', 'tool', 'Bash: npm test -- --reporter=dot --run test/client.retry.test.ts'),
  ];
}

function standardPreviews(now: number): Record<string, TranscriptEvent[]> {
  return {
    '0:9120:api-refactor': apiPreview(now),
    '0:9130:web-ui': [
      event(now, 2900, 'you', 'text', 'ship the settings page'),
      event(now, 2822, 'claude', 'tool', 'Bash: npm run deploy:preview'),
    ],
    '0:9200:docs': [event(now, 60, 'you', 'text', 'tighten the README intro'), event(now, 18, 'claude', 'text', 'Done. The intro is now three sentences.')],
    '0:9300:infra': [event(now, 3800, 'you', 'text', 'bump the terraform provider'), event(now, 3720, 'claude', 'text', 'Bumped to 5.71 and ran plan: no changes.')],
  };
}

/** The spec's standard picture: two sessions at work, one unreadable, the user at the keyboard. */
function busyChecks(rules: ArmContract, extra: Partial<Record<CheckId, CheckSpec>> = {}): Check[] {
  return checks(rules, {
    sessionsIdle: ['cantTell', { total: 3, working: 3, cantTell: 1, ignored: 0, names: ['scratch', 'api-refactor', 'web-ui'] }],
    turnsClosed: ['cantTell', { names: ['scratch', 'api-refactor', 'web-ui'], reasons: ['noTranscript', 'toolInFlight', 'toolInFlight'] }],
    quiet: ['waiting', { quietestSeconds: 18, name: 'api-refactor' }],
    userIdle: ['waiting', { idleSeconds: 4 }],
    ...extra,
  });
}

function busySessions(now: number): Session[] {
  return [cantTell('scratch'), apiRefactor(now), webUi(now)];
}

function allFinished(now: number): Session[] {
  return [finished('api-refactor', now, 420, 9120), finished('web-ui', now, 940, 9130), finished('infra', now)];
}

function countdownOf(kind: CountdownKind, action: PowerAction, totalSeconds: number, remainingSeconds: number): CountdownState {
  return { id: `fixture-${kind}`, kind, action, totalMs: totalSeconds * SECOND, remainingMs: remainingSeconds * SECOND };
}

function countdownState(now: number, kind: CountdownKind, rules: ArmContract, overrides: Partial<UiState> = {}): UiState {
  const passing = checks(rules, { confirmed: ['pass', { k: rules.requiredPolls }] });
  return watching(now, rules, {
    phase: 'countdown',
    checks: passing,
    sessions: allFinished(now),
    confirm: { k: rules.requiredPolls, n: rules.requiredPolls, nextCheckInMs: null },
    countdown: countdownOf(kind, rules.action, rules.countdownSeconds, rules.countdownSeconds - 3),
    ...overrides,
  });
}

function resultState(now: number, lastResult: LastResult, overrides: Partial<UiState> = {}): UiState {
  return baseState(now, { lastResult, sessions: allFinished(now), checks: checks(contract(), { armed: ['waiting'] }), ...overrides });
}

const REAL = contract({ testMode: false });
const TEST = contract({ testMode: true });

// --- catalogue ---------------------------------------------------------------------------------

export const FIXTURES: readonly Fixture[] = [
  {
    id: 'off-empty',
    group: 'Not watching',
    title: 'No sessions',
    build: (now) => ({
      state: baseState(now, {
        checks: checks(contract(), {
          armed: ['waiting'],
          hasSessions: ['waiting', { sawAny: false, secondsSinceLast: null }],
          sessionsIdle: ['pass', { total: 0 }],
          userIdle: ['waiting', { idleSeconds: 4 }],
        }),
      }),
      view: view(),
    }),
  },
  {
    id: 'off-sessions',
    group: 'Not watching',
    title: 'Sessions present',
    build: (now) => ({
      state: baseState(now, { sessions: busySessions(now), checks: busyChecks(contract(), { armed: ['waiting'] }) }),
      view: view(),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'off-real',
    group: 'Not watching',
    title: '"For real" selected',
    build: (now) => ({
      state: baseState(now, { contract: REAL, sessions: busySessions(now), checks: busyChecks(REAL, { armed: ['waiting'] }) }),
      view: view({ plan: REAL }),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'off-notify',
    group: 'Not watching',
    title: '"Just notify me" selected',
    build: (now) => {
      const rules = contract({ action: 'notify' });
      return {
        state: baseState(now, { contract: rules, sessions: busySessions(now), checks: busyChecks(rules, { armed: ['waiting'] }) }),
        view: view({ plan: rules }),
      };
    },
  },
  {
    id: 'off-unavailable',
    group: 'Not watching',
    title: 'Action not available (Hibernate)',
    build: (now) => {
      const rules = contract({ action: 'hibernate', testMode: false });
      const off: Capability = { ok: false, detail: 'Hibernation is turned off on this PC' };
      const base = baseState(now);
      return {
        state: baseState(now, {
          contract: rules,
          sessions: busySessions(now),
          checks: busyChecks(rules, { armed: ['waiting'], actionAllowed: ['fail', { action: 'hibernate', detail: off.detail }] }),
          platform: { ...base.platform, capability: off, capabilities: { ...base.platform.capabilities, hibernate: off } },
        }),
        view: view({ plan: rules }),
      };
    },
  },
  {
    id: 'off-many',
    group: 'Not watching',
    title: 'Eight sessions (finished ones fold)',
    build: (now) => ({
      state: baseState(now, {
        sessions: [
          cantTell('scratch'),
          apiRefactor(now),
          finished('infra', now, 3720, 9301),
          finished('billing-export', now, 5400, 9302),
          finished('design-tokens', now, 7300, 9303),
          finished('a-very-long-session-name-that-does-not-fit-in-a-narrow-side-bar', now, 9100, 9304),
          finished('notes', now, 12_000, 9305),
          finished('spike-webgpu', now, 20_000, 9306),
        ],
        checks: busyChecks(contract(), { armed: ['waiting'], sessionsIdle: ['cantTell', { total: 8, working: 2, cantTell: 1 }] }),
      }),
      view: view(),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'watching-real',
    group: 'Watching',
    title: 'For real, blocked by Claude and you',
    build: (now) => ({
      state: watching(now, REAL, { sessions: busySessions(now), checks: busyChecks(REAL) }),
      view: view({ plan: REAL }),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'watching-test',
    group: 'Watching',
    title: 'Test run',
    build: (now) => ({
      state: watching(now, TEST, {
        sessions: [apiRefactor(now), justFinished('docs', now), finished('infra', now)],
        checks: checks(TEST, {
          sessionsIdle: ['waiting', { total: 3, working: 2, cantTell: 0, names: ['api-refactor', 'docs'] }],
          turnsClosed: ['waiting', { names: ['api-refactor'], reasons: ['toolInFlight'] }],
          quiet: ['waiting', { quietestSeconds: 18, name: 'docs' }],
        }),
      }),
      view: view(),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'watching-timers',
    group: 'Watching',
    title: 'Only timers left (shows "Earliest")',
    build: (now) => ({
      state: watching(now, REAL, {
        sessions: [justFinished('docs', now, 132), finished('infra', now)],
        checks: checks(REAL, {
          sessionsIdle: ['waiting', { total: 2, working: 1, cantTell: 0, names: ['docs'] }],
          quiet: ['waiting', { quietestSeconds: 132, name: 'docs' }],
          userIdle: ['waiting', { idleSeconds: 215 }],
        }),
      }),
      view: view({ plan: REAL }),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'watching-claude-status',
    group: 'Watching',
    title: "Claude Code's own status: busy, needs an answer, idle",
    build: (now) => ({
      state: watching(now, REAL, {
        sessions: [
          working('api-refactor', now, {
            entrypoint: 'claude-vscode',
            turnReason: 'claudeBusy',
            claudeStatus: 'busy',
            claudeStatusSinceMs: now - 4 * MINUTE,
            turnSource: 'claude',
          }),
          webUi(now, {
            turnReason: 'claudeWaiting',
            turnDetail: 'permission prompt',
            claudeStatus: 'waiting',
            waitingFor: 'permission prompt',
            claudeStatusSinceMs: now - 47 * MINUTE,
            turnSource: 'claude',
          }),
          {
            ...finished('docs', now, 1300),
            entrypoint: 'claude-vscode',
            turnReason: 'claudeIdle',
            claudeStatus: 'idle',
            claudeStatusSinceMs: now - 1300 * SECOND,
            turnSource: 'claude',
          },
        ],
        checks: busyChecks(REAL, {
          sessionsIdle: ['waiting', { total: 3, working: 2, cantTell: 0, ignored: 0, names: ['api-refactor', 'web-ui'] }],
          turnsClosed: ['waiting', { names: ['api-refactor', 'web-ui'], reasons: ['claudeBusy', 'claudeWaiting'] }],
        }),
      }),
      view: view({ plan: REAL }),
      previews: standardPreviews(now),
    }),
  },
  {
    id: 'watching-overrides',
    group: 'Watching',
    title: 'Every "Don\'t wait for…" override',
    build: (now) => {
      const strays: StrayProcess[] = [
        stray({ pid: 7788, name: 'claude', path: 'C:\\Users\\dev\\.local\\bin\\claude.exe', accounted: false, ignoreKey: 'proc:7788:133800000000000001', ignored: false }),
        stray({ pid: 7790, name: 'claude', path: null, accounted: false, ignoreKey: 'proc:7790:133800000000000002', ignored: true }),
      ];
      const remoteWindows: RemoteWindow[] = [
        { name: 'SSH: build-box', ignoreKey: 'remote:SSH: build-box', ignored: false, covered: false },
        { name: 'WSL: Ubuntu', ignoreKey: 'remote:WSL: Ubuntu', ignored: false, covered: true },
        { name: 'Dev Container', ignoreKey: 'remote:Dev Container', ignored: true, covered: false },
      ];
      return {
        state: watching(now, REAL, {
          sessions: [
            cantTell('scratch'),
            cantTell('old-notes', { key: '0:9401:old-notes', pid: 9401, ignored: true, ignoreKey: 'session:0:9401:old-notes:0:0:0' }),
            webUi(now, {
              children: [child('npm', 4321), child('cargo', 4410, true)],
              why: { id: 'childBusy', name: 'npm', pid: 4321 },
            }),
            session('ubuntu-api', {
              key: '1:0:ubuntu-api',
              pid: null,
              liveness: 'foreign',
              rootLabel: 'WSL: Ubuntu',
              cwd: '/home/dev/api',
              lastActivityMs: now - 18 * SECOND,
            }),
            session('3f9a2c1d', {
              key: '0:0:3f9a2c1d.jsonl',
              pid: null,
              origin: 'transcript',
              liveness: 'none',
              cwd: '',
              folder: 'D--work-spike',
              entrypoint: '',
              lastActivityMs: now - 18 * SECOND,
            }),
            working('unverified-one', now, { key: '0:9500:unverified-one', pid: 9500, liveness: 'unverified' }),
          ],
          strays,
          remoteWindows,
          checks: busyChecks(REAL, {
            remoteWindows: ['cantTell', { blocking: ['SSH: build-box'], ignored: ['Dev Container'], covered: ['WSL: Ubuntu'] }],
            registry: ['cantTell', { reason: 'unaccounted', pids: [7788], names: ['claude'], strays: 2 }],
            sessionsIdle: ['cantTell', { total: 6, working: 5, cantTell: 1, ignored: 1 }],
            childProcesses: ['waiting', { items: ['npm (PID 4321) started by web-ui'] }],
          }),
        }),
        view: view({ plan: REAL }),
        previews: standardPreviews(now),
      };
    },
  },
  {
    id: 'watching-stray-children',
    group: 'Watching',
    title: 'Commands a Claude process without a session entry started',
    build: (now) => {
      const strays: StrayProcess[] = [
        stray(
          { pid: 7788, name: 'claude', path: 'C:\\Users\\dev\\.local\\bin\\claude.exe', accounted: false, ignoreKey: 'proc:7788:133800000000000001', ignored: false },
          [child('node', 7801), child('esbuild', 7802, true)],
        ),
        stray({ pid: 7795, name: 'claude', path: null, accounted: true, ignoreKey: 'proc:7795:133800000000000003', ignored: false }, [child('cargo', 7805)]),
      ];
      return {
        state: watching(now, REAL, {
          sessions: allFinished(now),
          strays,
          checks: checks(REAL, {
            registry: ['cantTell', { reason: 'unaccounted', pids: [7788], names: ['claude'], strays: 2 }],
            userIdle: ['waiting', { idleSeconds: 4 }],
          }),
        }),
        view: view({ plan: REAL }),
      };
    },
  },
  {
    id: 'watching-omitted',
    group: 'Watching',
    title: 'More sessions than fit between windows',
    build: (now) => ({
      state: watching(now, REAL, {
        sessions: allFinished(now),
        sessionsOmitted: 37,
        checks: checks(REAL, {
          sessionsIdle: ['waiting', { total: 40, working: 2, cantTell: 0, ignored: 0, names: [] }],
          userIdle: ['waiting', { idleSeconds: 4 }],
        }),
      }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'watching-cancelled',
    group: 'Watching',
    title: 'Countdown was cancelled, still watching',
    build: (now) => ({
      state: watching(now, REAL, {
        sessions: [webUi(now, { silenceSeconds: 12, lastActivityMs: now - 12 * SECOND }), finished('infra', now)],
        cooldownRemainingMs: 48 * SECOND,
        lastResult: { kind: 'cancelled', atMs: now - 12 * SECOND, reason: { id: 'sessionResumed', name: 'web-ui' }, stillWatching: true, countdownKind: 'real' },
        checks: checks(REAL, {
          sessionsIdle: ['waiting', { total: 2, working: 1, cantTell: 0, names: ['web-ui'] }],
          turnsClosed: ['waiting', { names: ['web-ui'], reasons: ['thinking'] }],
          quiet: ['waiting', { quietestSeconds: 12, name: 'web-ui' }],
        }),
      }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'watching-stop-file',
    group: 'Watching',
    title: 'Emergency stop is set',
    build: (now) => ({
      state: watching(now, REAL, {
        sessions: allFinished(now),
        stop: { present: true, dir: 'C:\\fixture\\.claude-auto-shutdown', auto: false },
        checks: checks(REAL, { stopFile: ['fail'] }),
      }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'confirming',
    group: 'Watching',
    title: 'Double-checking (2 of 3)',
    build: (now) => ({
      state: watching(now, REAL, {
        phase: 'confirming',
        sessions: allFinished(now),
        confirm: { k: 2, n: 3, nextCheckInMs: 6 * SECOND },
        checks: checks(REAL, { confirmed: ['waiting', { k: 2 }] }),
      }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'countdown-real',
    group: 'Countdown',
    title: 'For real (shut down, closes apps)',
    build: (now) => ({ state: countdownState(now, 'real', REAL), view: view({ plan: REAL }) }),
  },
  {
    id: 'countdown-real-no-idle',
    group: 'Countdown',
    title: 'For real, mouse does NOT cancel (sleep)',
    build: (now) => {
      const rules = contract({ testMode: false, action: 'sleep', requireUserIdle: false, countdownSeconds: 30 });
      return {
        state: countdownState(now, 'real', rules, { countdown: countdownOf('real', 'sleep', 30, 9) }),
        view: view({ plan: rules }),
      };
    },
  },
  {
    id: 'countdown-test',
    group: 'Countdown',
    title: 'Test run',
    build: (now) => ({ state: countdownState(now, 'test', TEST), view: view() }),
  },
  {
    id: 'countdown-preview',
    group: 'Countdown',
    title: 'Preview (20 s demo)',
    build: (now) => ({
      state: baseState(now, {
        phase: 'countdown',
        sessions: busySessions(now),
        checks: busyChecks(contract(), { armed: ['waiting'] }),
        countdown: countdownOf('preview', 'shutdown', 20, 17),
      }),
      view: view(),
    }),
  },
  {
    id: 'committing',
    group: 'Countdown',
    title: 'Final check',
    build: (now) => ({
      state: countdownState(now, 'real', REAL, { phase: 'committing', countdown: countdownOf('real', 'shutdown', 90, 0) }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'executing',
    group: 'Countdown',
    title: 'Shutting down now',
    build: (now) => ({
      state: countdownState(now, 'real', REAL, { phase: 'executing', armed: false, countdown: null }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'result-test-passed',
    group: 'Result',
    title: 'Test run passed',
    build: (now) => ({
      state: resultState(now, {
        kind: 'testPassed',
        atMs: now - 6 * HOUR,
        action: 'shutdown',
        armedAtMs: now - 9 * HOUR - 12 * MINUTE,
        lastSessionFinishedAtMs: now - 6 * HOUR - 16 * MINUTE,
        allClearAtMs: now - 6 * HOUR - 2 * MINUTE,
        heldUpBy: { name: 'web-ui', seconds: 2 * 3600 + 9 * 60 },
      }),
      view: view(),
    }),
  },
  {
    id: 'result-done-sleep',
    group: 'Result',
    title: 'Went to sleep, woke again',
    build: (now) => ({
      state: resultState(now, { kind: 'done', atMs: now - 6 * HOUR, action: 'sleep', resumedAtMs: now - 3 * MINUTE, confirmed: null }),
      view: view({ plan: contract({ action: 'sleep', testMode: false }) }),
    }),
  },
  {
    id: 'result-done-notify',
    group: 'Result',
    title: 'Claude finished (notify)',
    build: (now) => ({
      state: resultState(now, { kind: 'done', atMs: now - 20 * MINUTE, action: 'notify', resumedAtMs: null, confirmed: null }),
      view: view({ plan: contract({ action: 'notify' }) }),
    }),
  },
  {
    id: 'result-unconfirmed',
    group: 'Result',
    title: 'Shutdown started, never confirmed',
    build: (now) => ({
      state: resultState(now, { kind: 'done', atMs: now - 9 * MINUTE, action: 'shutdown', resumedAtMs: null, confirmed: false }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'result-lock-unconfirmed',
    group: 'Result',
    title: 'Lock requested, Windows never showed it',
    build: (now) => ({
      state: resultState(now, { kind: 'done', atMs: now - 2 * HOUR, action: 'lock', resumedAtMs: null, confirmed: false }),
      view: view({ plan: contract({ action: 'lock', testMode: false }) }),
    }),
  },
  {
    id: 'result-failed',
    group: 'Result',
    title: "Couldn't shut down",
    build: (now) => ({
      state: resultState(now, { kind: 'failed', atMs: now - 4 * MINUTE, action: 'shutdown', message: 'Windows said: "Access is denied" (exit 5)' }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'result-cancelled',
    group: 'Result',
    title: 'Cancelled by you',
    build: (now) => ({
      state: resultState(now, { kind: 'cancelled', atMs: now - 40 * SECOND, reason: { id: 'user', via: 'esc' }, stillWatching: false, countdownKind: 'real' }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'result-stopped',
    group: 'Result',
    title: 'Watching stopped (PC slept and woke)',
    build: (now) => ({
      state: resultState(now, { kind: 'stopped', atMs: now - 5 * HOUR, cause: 'timeJump', armedAtMs: now - 8 * HOUR, wasReal: true }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'result-stopped-lost-control',
    group: 'Result',
    title: 'Watching stopped (the watching window lost control)',
    build: (now) => ({
      state: resultState(now, { kind: 'stopped', atMs: now - 30 * MINUTE, cause: 'lostControl', armedAtMs: now - 2 * HOUR, wasReal: true }),
      view: view({ plan: REAL }),
    }),
  },
  {
    id: 'degraded',
    group: 'Trouble',
    title: "Degraded: couldn't read the session list (watching)",
    build: (now) => {
      const errors = ['Couldn\'t read C:\\fixture\\.claude\\sessions\\9120.json (EACCES).', 'Couldn\'t list \\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude (timed out).'];
      const base = baseState(now);
      return {
        state: watching(now, REAL, {
          sessions: busySessions(now),
          scan: { ...base.scan, lastCompletedAgoMs: 48 * SECOND, errors },
          checks: busyChecks(REAL, { scanner: ['cantTell', { reason: 'errors', errors, roots: 2 }] }),
        }),
        view: view({ plan: REAL }),
        previews: standardPreviews(now),
      };
    },
  },
  {
    id: 'degraded-off',
    group: 'Trouble',
    title: 'Degraded: last check too old (not watching)',
    build: (now) => {
      const base = baseState(now);
      return {
        state: baseState(now, {
          sessions: busySessions(now),
          scan: { ...base.scan, lastCompletedAgoMs: 95 * SECOND, stale: true },
          checks: busyChecks(contract(), { armed: ['waiting'], scanner: ['cantTell', { reason: 'stale' }] }),
        }),
        view: view(),
      };
    },
  },
  {
    id: 'lost-contact',
    group: 'Trouble',
    title: 'Connecting… then lost contact (after 2 s)',
    build: () => ({ state: null, view: view({ role: 'follower' }) }),
  },
  {
    id: 'lost-contact-stop',
    group: 'Trouble',
    title: 'Lost contact, Emergency stop set by this window',
    build: () => ({ state: null, view: view({ role: 'follower', pending: 'disarm', autoStopSet: true }) }),
  },
  {
    id: 'isolated',
    group: 'Trouble',
    title: "Can't coordinate",
    build: () => ({ state: null, view: view({ role: 'isolated' }) }),
  },
  {
    id: 'limited',
    group: 'Trouble',
    title: 'Limited: controlled by another version',
    build: (now) => {
      const base = watching(now, REAL, { sessions: busySessions(now), checks: busyChecks(REAL) });
      return {
        state: { ...base, leader: { ...base.leader, app: 'Cursor', ext: '0.3.0' } },
        view: view({ role: 'follower', limited: true, plan: REAL }),
      };
    },
  },
  {
    id: 'limited-foreign',
    group: 'Trouble',
    title: 'Limited: a countdown in a state this version barely understands',
    build: () => ({
      // What a newer leader might send: only `phase` is guaranteed. Everything else is missing or odd.
      state: { phase: 'countdown', countdown: { id: 'x', remainingMs: 41_000 }, sessions: 'three' } as unknown as UiState,
      view: view({ role: 'follower', limited: true }),
    }),
  },
  {
    id: 'cant-run',
    group: 'Trouble',
    title: "Can't run here (helper did not start)",
    build: (now) => {
      const base = baseState(now);
      const problem = "Can't check this PC: the Windows helper didn't start";
      return {
        state: baseState(now, {
          scan: { ...base.scan, lastCompletedAgoMs: null },
          platform: { ...base.platform, helperTier: 'unavailable', problem, capability: null, capabilities: {} },
          checks: checks(contract(), { armed: ['waiting'], helper: ['fail', { problem, tier: 'unavailable' }], scanner: ['cantTell', { reason: 'noScan' }] }),
        }),
        view: view(),
      };
    },
  },
  {
    id: 'macos',
    group: 'Trouble',
    title: 'macOS: experimental banner',
    build: (now) => {
      const base = baseState(now);
      const allowed: Capability = { ok: true, detail: 'Allowed by macOS' };
      const noHibernate: Capability = { ok: false, detail: 'macOS decides between sleep and hibernate itself; use Sleep' };
      return {
        state: baseState(now, {
          sessions: busySessions(now),
          checks: busyChecks(contract(), { armed: ['waiting'], actionAllowed: ['pass', { detail: allowed.detail }] }),
          platform: {
            ...base.platform,
            id: 'macos',
            osName: 'macOS',
            experimental: true,
            helperTier: 'limited',
            capability: allowed,
            capabilities: { shutdown: allowed, sleep: allowed, lock: allowed, hibernate: noHibernate, notify: allowed },
          },
        }),
        view: view(),
      };
    },
  },
];

export function fixtureById(id: string | null): Fixture {
  const found = FIXTURES.find((fixture) => fixture.id === id) ?? FIXTURES[0];
  if (found === undefined) throw new Error('the fixture catalogue is empty');
  return found;
}
