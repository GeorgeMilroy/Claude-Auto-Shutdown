// Claude Code's own status in sessions/<pid>.json, end to end through the scanner. Every record
// carries a timestamp, as every record Claude Code writes does: a turn record whose time can't be
// read would leave the status unchecked, and the transcript would decide.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NOW, SESSION_START, createWorkspace, only, type Workspace } from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const ago = (seconds: number): number => NOW - seconds * 1000;
const at = (ms: number): string => new Date(ms).toISOString();

type Json = Record<string, unknown>;
const prompt = (ms: number, text = 'please do the thing'): Json => ({ type: 'user', timestamp: at(ms), message: { role: 'user', content: text } });
const reply = (ms: number, content: unknown[] = [{ type: 'text', text: 'done' }]): Json => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { role: 'assistant', stop_reason: 'end_turn', content },
});
const toolCall = (ms: number, name = 'Bash', input: Json = { command: 'npm test' }): Json => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name, input }] },
});
const toolAnswer = (ms: number): Json => ({
  type: 'user',
  timestamp: at(ms),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
});
const localCommand = (ms: number): Json[] => [
  { type: 'user', isMeta: true, timestamp: at(ms), message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } },
  { type: 'user', timestamp: at(ms + 1), message: { role: 'user', content: '<command-name>/model</command-name>' } },
  { type: 'user', timestamp: at(ms + 2), message: { role: 'user', content: '<local-command-stdout>Set model to Opus</local-command-stdout>' } },
];

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
});
afterEach(() => ws.cleanup());

function session(status: string | null, statusSecondsAgo: number, fields: Json = {}): void {
  ws.liveSession(4242, ID, {
    kind: 'interactive',
    startedAt: SESSION_START,
    ...(status === null ? {} : { status, statusUpdatedAt: ago(statusSecondsAgo) }),
    ...fields,
  });
}

describe("Claude Code's status decides the turn", () => {
  it('idle closes a turn the transcript leaves open (an interrupt an older version did not mark)', async () => {
    session('idle', 1000);
    ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100))], ago(1100));
    expect(only(await ws.scan())).toMatchObject({
      turn: 'CLOSED',
      turnReason: 'claudeIdle',
      turnSource: 'claude',
      claudeStatus: 'idle',
      claudeStatusSinceMs: ago(1000),
      kind: 'interactive',
      status: 'finished',
      working: false,
      lastActivityMs: ago(1000),
    });
  });

  it('without a status the same transcript keeps the session working', async () => {
    session(null, 0);
    ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100))], ago(1100));
    expect(only(await ws.scan())).toMatchObject({ turn: 'OPEN', turnReason: 'toolInFlight', turnSource: 'transcript', working: true });
  });

  it('busy keeps a session working whose transcript reads finished', async () => {
    session('busy', 900);
    ws.claude.transcript('p', ID, [prompt(ago(1200)), reply(ago(1100))], ago(1100));
    expect(only(await ws.scan())).toMatchObject({
      turn: 'OPEN',
      turnReason: 'claudeBusy',
      turnSource: 'claude',
      status: 'working',
      why: { id: 'turnOpen' },
    });
  });

  it('a panel that was opened and never used finishes once quiet', async () => {
    session('idle', 600);
    expect(only(await ws.scan())).toMatchObject({
      transcriptPath: null,
      turn: 'CLOSED',
      turnReason: 'claudeIdle',
      status: 'finished',
      lastActivityMs: ago(600),
    });
  });

  it('a local command after the turn does not reopen it', async () => {
    session('idle', 1000);
    ws.claude.transcript('p', ID, [prompt(ago(1200)), reply(ago(1100)), ...localCommand(ago(700))], ago(700));
    expect(only(await ws.scan())).toMatchObject({ turnReason: 'claudeIdle', turnSource: 'claude', status: 'finished' });
  });

  it('a prompt written after the status proves it stale: the transcript decides', async () => {
    session('idle', 1000);
    ws.claude.transcript('p', ID, [prompt(ago(1200)), reply(ago(1100)), prompt(ago(400), 'and now the tests')], ago(400));
    expect(only(await ws.scan())).toMatchObject({
      turn: 'OPEN',
      turnReason: 'thinking',
      turnSource: 'transcript',
      claudeStatus: 'idle',
      working: true,
    });
  });

  it('a turn record without a readable time leaves the status unchecked', async () => {
    session('idle', 1000);
    const untimed = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [] } };
    ws.claude.transcript('p', ID, [prompt(ago(1200)), untimed], ago(1100));
    expect(only(await ws.scan())).toMatchObject({ turnReason: 'toolInFlight', turnSource: 'transcript', working: true });
  });

  it('the quiet time starts again when the status changes', async () => {
    session('idle', 60);
    ws.claude.transcript('p', ID, [prompt(ago(3700)), reply(ago(3600))], ago(3600));
    expect(only(await ws.scan())).toMatchObject({
      turnReason: 'claudeIdle',
      status: 'justFinished',
      working: true,
      why: { id: 'recentWrite' },
      lastActivityMs: ago(60),
      silenceSeconds: 60,
    });
  });

  it('a status word this version does not know is "can\'t tell"', async () => {
    session('paused', 1000);
    ws.claude.transcript('p', ID, [prompt(ago(1200)), reply(ago(1100))], ago(1100));
    expect(only(await ws.scan())).toMatchObject({
      turn: 'UNKNOWN',
      turnReason: 'claudeStatusUnknown',
      turnDetail: 'paused',
      status: 'cantTell',
      working: true,
    });
  });

  it('a background agent is judged by its transcript', async () => {
    session('idle', 1000, { kind: 'bg' });
    ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100))], ago(1100));
    expect(only(await ws.scan())).toMatchObject({ kind: 'bg', turnSource: 'transcript', turnReason: 'toolInFlight', working: true });
  });
});

describe('waiting for the user', () => {
  it('keeps the PC on by default and says what for', async () => {
    session('waiting', 1000, { waitingFor: 'permission prompt' });
    ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100))], ago(1100));
    expect(only(await ws.scan())).toMatchObject({
      turn: 'OPEN',
      turnReason: 'claudeWaiting',
      turnDetail: 'permission prompt',
      waitingFor: 'permission prompt',
      working: true,
    });
  });

  it('lets the session go once quiet when the user turned that off', async () => {
    session('waiting', 1000, { waitingFor: 'permission prompt' });
    ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100))], ago(1100));
    expect(only(await ws.scan({ waitForAnswers: false }))).toMatchObject({
      turn: 'CLOSED',
      turnReason: 'claudeWaiting',
      turnSource: 'claude',
      status: 'finished',
      working: false,
    });
  });
});

describe('what else still counts after Claude Code says idle', () => {
  it('a subagent stopped with the turn no longer counts as working', async () => {
    const transcript = ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100), 'Task')], ago(1100));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', [prompt(ago(1150)), toolCall(ago(1050))], ago(1050));
    session(null, 0);
    expect(only(await ws.scan())).toMatchObject({ activeSubagents: 1, working: true });

    session('idle', 1000);
    expect(only(await ws.scan())).toMatchObject({ turnReason: 'claudeIdle', activeSubagents: 0, status: 'finished' });
  });

  it('a subagent stopped with the turn still counts as stopped when its last write lands just after the status', async () => {
    session('idle', 1000);
    const marker = { type: 'user', timestamp: at(ago(1000)), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
    const transcript = ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100), 'Task'), marker], ago(1000) + 100);
    ws.claude.subagent(transcript, 'agent-a1.jsonl', [prompt(ago(1150)), toolCall(ago(1050)), marker], ago(1000) + 100);
    expect(only(await ws.scan())).toMatchObject({ turnReason: 'claudeIdle', activeSubagents: 0, status: 'finished' });

    ws.claude.subagent(transcript, 'agent-a1.jsonl', [prompt(ago(1150)), toolCall(ago(1050)), marker], ago(1000) + 3000);
    expect(only(await ws.scan())).toMatchObject({ activeSubagents: 1, working: true });
  });

  it('a question let go (waitForAnswers off) does not let go of the subagents still running', async () => {
    session('waiting', 1000, { waitingFor: 'permission prompt' });
    const transcript = ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100), 'Task')], ago(1100));
    ws.claude.subagent(transcript, 'agent-b2.jsonl', [prompt(ago(1150)), toolCall(ago(1050))], ago(1050));
    expect(only(await ws.scan({ waitForAnswers: false }))).toMatchObject({
      turn: 'CLOSED',
      turnReason: 'claudeWaiting',
      activeSubagents: 1,
      working: true,
      why: { id: 'subagentsActive', count: 1 },
    });
  });

  it('a subagent that wrote after the status still counts', async () => {
    session('idle', 1000);
    const transcript = ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100), 'Task')], ago(1100));
    ws.claude.subagent(transcript, 'agent-a1.jsonl', [prompt(ago(1150)), toolCall(ago(800))], ago(800));
    expect(only(await ws.scan())).toMatchObject({ activeSubagents: 1, working: true, why: { id: 'subagentsActive', count: 1 } });
  });

  it('a /loop wake-up scheduled before a local command still keeps the session working', async () => {
    session('idle', 1000);
    const loop = [
      prompt(ago(1300), '/loop check the deploy'),
      toolCall(ago(1250), 'ScheduleWakeup', { delaySeconds: 1800 }),
      toolAnswer(ago(1240)),
      reply(ago(1200)),
      ...localCommand(ago(1100)),
    ];
    ws.claude.transcript('p', ID, loop, ago(1100));
    expect(only(await ws.scan())).toMatchObject({
      turnReason: 'claudeIdle',
      working: true,
      why: { id: 'scheduledWakeup', inSeconds: 700 },
    });
  });
});

describe("don't wait for this session", () => {
  it('ends when Claude Code reports a new status, even with no new write', async () => {
    session('waiting', 1000, { waitingFor: 'permission prompt' });
    ws.claude.transcript('p', ID, [prompt(ago(1200)), toolCall(ago(1100))], ago(1100));
    const before = only(await ws.scan());
    expect(before.ignoreKey.endsWith(`:${ago(1000)}`)).toBe(true);
    const ignores = new Set([before.ignoreKey]);
    expect(only(await ws.scan({ ignores }))).toMatchObject({ ignored: true });

    session('waiting', 500, { waitingFor: 'input needed' });
    expect(only(await ws.scan({ ignores }))).toMatchObject({ ignored: false, working: true });
  });
});
