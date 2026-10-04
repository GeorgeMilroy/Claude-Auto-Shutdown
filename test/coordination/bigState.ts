// Big states for the tests of the 256 KB message limit (see src/coordination/trimState.ts).

import type { ChildProcessInfo, Session, StrayProcess, SubagentInfo } from '../../src/core/types';
import type { ActivityEntry, CountdownState, UiState } from '../../src/shared/protocol';
import { armedState } from './harness';

export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function subagent(session: number, index: number): SubagentInfo {
  const name = `agent-${String(index).padStart(2, '0')}-${'a'.repeat(40)}`;
  return {
    name,
    path: `C:\\Users\\someone\\.claude\\projects\\D--work-project-${session}\\subagents\\${name}.jsonl`,
    mtimeMs: 1_700_000_000_000 - index,
    turn: 'CLOSED',
    active: index === 0,
  };
}

function child(index: number): ChildProcessInfo {
  return {
    pid: 9000 + index,
    name: 'node.exe',
    cpuPercent: 12.5,
    ioBytesPerSecond: 1024,
    busy: true,
    ignoreKey: `proc:${9000 + index}:133000000000000000`,
    ignored: false,
  };
}

export function session(index: number, overrides: Partial<Session> = {}): Session {
  return {
    key: `session-${index}`,
    origin: 'registry',
    liveness: 'verified',
    pid: 1000 + index,
    sessionId: `0000${index}-aaaa-bbbb-cccc-dddddddddddd`,
    name: `session number ${index}`,
    cwd: `D:\\work\\project-${index}`,
    folder: `project-${index}`,
    entrypoint: 'claude-vscode',
    rootLabel: '~/.claude',
    startedAtMs: 1_700_000_000_000,
    transcriptPath: `C:\\Users\\someone\\.claude\\projects\\D--work-project-${index}\\${index}.jsonl`,
    lastActivityMs: 1_700_000_000_000,
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
    subagents: Array.from({ length: 20 }, (_, n) => subagent(index, n)),
    children: Array.from({ length: 10 }, (_, n) => child(n)),
    status: 'finished',
    working: false,
    why: { id: 'quiet' },
    ignoreKey: `session:${index}`,
    ignored: false,
    ...overrides,
  };
}

export function stray(index: number): StrayProcess {
  return {
    pid: 5000 + index,
    name: 'claude.exe',
    path: 'C:\\Users\\someone\\.local\\bin\\claude.exe',
    accounted: false,
    ignoreKey: `proc:${5000 + index}:1`,
    ignored: false,
    ...{ children: Array.from({ length: 10 }, (_, n) => child(n)) },
  };
}

export function activity(count: number, textLength: number): ActivityEntry[] {
  return Array.from({ length: count }, (_, n) => ({ atMs: n, level: 'info', text: `${n} ${'x'.repeat(textLength)}` }));
}

/** A real countdown on a PC with 300 sessions of 20 subagents each: several MB of JSON. */
export function hugeState(overrides: Partial<UiState> = {}): UiState {
  const countdown: CountdownState = { id: 'c1', kind: 'real', action: 'shutdown', totalMs: 60_000, remainingMs: 4100 };
  return armedState({
    phase: 'countdown',
    countdown,
    checks: [{ id: 'sessionsIdle', state: 'pass', data: { working: 0, total: 300 } }],
    sessions: Array.from({ length: 300 }, (_, n) => session(n)),
    strays: Array.from({ length: 30 }, (_, n) => stray(n)),
    stop: { present: false, dir: 'C:\\state', auto: false },
    lastResult: { kind: 'failed', atMs: 1, action: 'shutdown', message: 'earlier' },
    activity: activity(40, 2000),
    scan: {
      engineActive: true,
      lastCompletedAgoMs: 100,
      stale: false,
      errors: Array.from({ length: 50 }, (_, n) => `problem ${n}: ${'e'.repeat(1000)}`),
      roots: [],
    },
    ...overrides,
  });
}
