import { describe, expect, it } from 'vitest';

import { DECISIVE_RECORD_TYPES, classifyRecord } from '../../src/core/transcript';
import type { TurnInfo, TurnReason, TurnState } from '../../src/core/types';
import { assistant, prompt, textBlock, toolResult, toolResultBlock, toolUse } from './fixtures';

function turn(state: TurnState, reason: TurnReason, detail: string | null = null): TurnInfo {
  return { state, reason, detail, scheduledWakeupSeconds: null };
}

describe('classifyRecord: assistant records', () => {
  it('is CLOSED only for end_turn and stop_sequence', () => {
    expect(classifyRecord(assistant('end_turn'))).toEqual(turn('CLOSED', 'turnEnded'));
    expect(classifyRecord(assistant('stop_sequence'))).toEqual(turn('CLOSED', 'turnEnded'));
  });

  it('is OPEN toolInFlight for tool_use', () => {
    expect(classifyRecord(assistant('tool_use', [toolUse('Bash', { command: 'npm test' })]))).toEqual(
      turn('OPEN', 'toolInFlight'),
    );
  });

  it('is OPEN cutAtTokenLimit for max_tokens', () => {
    expect(classifyRecord(assistant('max_tokens'))).toEqual(turn('OPEN', 'cutAtTokenLimit'));
  });

  it('is OPEN replyInProgress for a null or missing stop_reason', () => {
    expect(classifyRecord(assistant(null))).toEqual(turn('OPEN', 'replyInProgress'));
    expect(classifyRecord(assistant(undefined))).toEqual(turn('OPEN', 'replyInProgress'));
    expect(classifyRecord({ type: 'assistant' })).toEqual(turn('OPEN', 'replyInProgress'));
    expect(classifyRecord({ type: 'assistant', message: 'not an object' })).toEqual(turn('OPEN', 'replyInProgress'));
  });

  it('is OPEN replyInProgress for any other stop_reason and reports it as the detail', () => {
    expect(classifyRecord(assistant('pause_turn'))).toEqual(turn('OPEN', 'replyInProgress', 'pause_turn'));
    expect(classifyRecord(assistant('refusal'))).toEqual(turn('OPEN', 'replyInProgress', 'refusal'));
  });

  it('never closes a turn on a stop_reason that only resembles end_turn', () => {
    for (const lookalike of ['END_TURN', ' end_turn', 'end_turn ', 'endturn', ['end_turn'], { stop: 'end_turn' }, true, 1]) {
      expect(classifyRecord(assistant(lookalike)).state).toBe('OPEN');
    }
  });

  it('keeps the detail short and on one line', () => {
    const info = classifyRecord(assistant(`weird\n\treason ${'x'.repeat(500)}`));
    expect(info.reason).toBe('replyInProgress');
    expect(info.detail).toMatch(/^weird reason x+$/);
    expect(info.detail?.length).toBe(120);
  });
});

describe('classifyRecord: user records', () => {
  it('is OPEN readingToolResult when the content carries a tool_result block', () => {
    expect(classifyRecord(toolResult('exit code 0'))).toEqual(turn('OPEN', 'readingToolResult'));
    const mixed = { type: 'user', message: { content: [textBlock('note'), toolResultBlock('out')] } };
    expect(classifyRecord(mixed)).toEqual(turn('OPEN', 'readingToolResult'));
  });

  it('is OPEN thinking for a prompt, whatever shape its content has', () => {
    expect(classifyRecord(prompt('please fix the build'))).toEqual(turn('OPEN', 'thinking'));
    expect(classifyRecord({ type: 'user', message: { content: [textBlock('hi')] } })).toEqual(turn('OPEN', 'thinking'));
    expect(classifyRecord({ type: 'user', message: { content: [null, 7, 'tool_result'] } })).toEqual(
      turn('OPEN', 'thinking'),
    );
    expect(classifyRecord({ type: 'user' })).toEqual(turn('OPEN', 'thinking'));
    expect(classifyRecord({ type: 'user', message: null })).toEqual(turn('OPEN', 'thinking'));
  });
});

describe('classifyRecord: compaction', () => {
  it('is OPEN compacting for a compact summary', () => {
    expect(classifyRecord(prompt('This session is being continued...', { isCompactSummary: true }))).toEqual(
      turn('OPEN', 'compacting'),
    );
  });

  it('lets isCompactSummary win over a record that would otherwise be CLOSED or UNKNOWN', () => {
    expect(classifyRecord(assistant('end_turn', [textBlock('done')], { isCompactSummary: true }))).toEqual(
      turn('OPEN', 'compacting'),
    );
    expect(classifyRecord({ type: 'summary', isCompactSummary: true })).toEqual(turn('OPEN', 'compacting'));
  });

  it('treats any truthy isCompactSummary as a compaction (it can only keep the PC on)', () => {
    expect(classifyRecord(assistant('end_turn', [], { isCompactSummary: 'false' })).reason).toBe('compacting');
    expect(classifyRecord(assistant('end_turn', [], { isCompactSummary: 1 })).reason).toBe('compacting');
  });

  it('ignores a falsy isCompactSummary', () => {
    for (const falsy of [false, null, 0, '']) {
      expect(classifyRecord(assistant('end_turn', [], { isCompactSummary: falsy }))).toEqual(turn('CLOSED', 'turnEnded'));
    }
  });
});

describe('classifyRecord: everything else is UNKNOWN', () => {
  it('reports the record type as the detail', () => {
    expect(classifyRecord({ type: 'system', subtype: 'compact_boundary' })).toEqual(
      turn('UNKNOWN', 'unknownRecord', 'system'),
    );
    expect(classifyRecord({ type: 'attachment' })).toEqual(turn('UNKNOWN', 'unknownRecord', 'attachment'));
  });

  it('has no detail when the type is missing or not a string', () => {
    expect(classifyRecord({})).toEqual(turn('UNKNOWN', 'unknownRecord'));
    expect(classifyRecord({ type: 42 })).toEqual(turn('UNKNOWN', 'unknownRecord'));
    expect(classifyRecord({ type: ['assistant'] })).toEqual(turn('UNKNOWN', 'unknownRecord'));
    expect(classifyRecord({ type: '   ' })).toEqual(turn('UNKNOWN', 'unknownRecord'));
  });

  it('is case-sensitive about the record type', () => {
    expect(classifyRecord({ type: 'Assistant', message: { stop_reason: 'end_turn' } })).toEqual(
      turn('UNKNOWN', 'unknownRecord', 'Assistant'),
    );
  });

  it('never throws on values that are not records', () => {
    for (const garbage of [null, undefined, 0, 42, NaN, 'assistant', true, [], [assistant('end_turn')], () => 1]) {
      expect(classifyRecord(garbage)).toEqual(turn('UNKNOWN', 'unknownRecord'));
    }
  });

  it('never reports a scheduled wake-up by itself (only readTurn sees the whole turn)', () => {
    const call = assistant('end_turn', [toolUse('ScheduleWakeup', { delaySeconds: 600 })]);
    expect(classifyRecord(call).scheduledWakeupSeconds).toBeNull();
  });
});

describe('DECISIVE_RECORD_TYPES', () => {
  it('is an allow-list of exactly the two conversation record types', () => {
    expect([...DECISIVE_RECORD_TYPES].sort()).toEqual(['assistant', 'user']);
  });
});
