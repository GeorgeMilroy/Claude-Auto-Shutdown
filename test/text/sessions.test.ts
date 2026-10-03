import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus, SessionWhy, TurnReason } from '../../src/core/types';
import { describeSession, turnReasonText } from '../../src/shared/text';
import {
  GARBAGE,
  TURN_REASONS,
  cantTellSession,
  expectPrintable,
  finishedSession,
  justFinishedSession,
  session,
  workingSession,
} from './fixtures';

const QUIET = 300;

describe('turnReasonText', () => {
  const expected: Record<TurnReason, string> = {
    turnEnded: 'Turn ended',
    toolInFlight: 'Running a tool',
    cutAtTokenLimit: 'Reply cut off at the token limit',
    replyInProgress: 'Writing a reply',
    readingToolResult: 'Reading a tool result',
    thinking: 'Thinking',
    compacting: 'Compacting context',
    recordBeingWritten: 'Writing to the transcript',
    unknownRecord: 'Unrecognised transcript record',
    noTranscript: 'No transcript found',
    cannotRead: "Couldn't read the transcript",
    noConversationRecord: 'No conversation in the transcript yet',
    ambiguousTranscripts: 'Several transcripts changed at once',
  };

  it.each(TURN_REASONS)('%s', (reason) => {
    expect(turnReasonText(reason, null)).toBe(expected[reason]);
  });

  it.each(TURN_REASONS)('%s never leaks its detail as a raw value', (reason) => {
    for (const detail of [null, '', '   ', 'end_turn', 'EACCES: permission denied', ...GARBAGE]) {
      const text = turnReasonText(reason, detail as string | null);
      expect(text).not.toBe('');
      expectPrintable(text);
      expect(text).not.toMatch(/waiting for you/i);
    }
  });

  it('adds the detail only where it explains something', () => {
    expect(turnReasonText('cannotRead', 'EACCES: permission denied')).toBe(
      "Couldn't read the transcript (EACCES: permission denied)",
    );
    expect(turnReasonText('unknownRecord', 'queue-operation')).toBe('Unrecognised transcript record (queue-operation)');
    expect(turnReasonText('replyInProgress', 'pause_turn')).toBe('Writing a reply');
    expect(turnReasonText('turnEnded', 'end_turn')).toBe('Turn ended');
  });

  it('prints a reason it does not know verbatim', () => {
    expect(turnReasonText('hookRunning' as TurnReason, null)).toBe('hookRunning');
    expect(turnReasonText('hookRunning' as TurnReason, 'Stop hook')).toBe('hookRunning (Stop hook)');
    expect(turnReasonText('toString' as TurnReason, null)).toBe('toString');
    expect(turnReasonText(undefined as unknown as TurnReason, null)).toBe("Can't tell");
  });
});

describe('describeSession: the four words', () => {
  it.each<[SessionStatus, string]>([
    ['working', 'Working'],
    ['justFinished', 'Just finished'],
    ['finished', 'Finished'],
    ['cantTell', "Can't tell"],
  ])('%s -> %s', (status, word) => {
    expect(describeSession(session({ status }), QUIET, 18).status).toBe(word);
  });

  it('an ignored session reads "Not waited for" whatever it is doing', () => {
    for (const status of ['working', 'justFinished', 'finished', 'cantTell'] as const) {
      const text = describeSession(session({ status, ignored: true }), QUIET, 18);
      expect(text.status).toBe('Not waited for');
      expect(text.line).toBe('Until it writes again');
      expect(text.canIgnore).toBe(false);
      expect(text.hint).toBeNull();
    }
  });

  it('a status it does not know is a can\'t tell, never Finished', () => {
    for (const status of [...GARBAGE, 'idle', 'done']) {
      expect(describeSession(session({ status: status as SessionStatus }), QUIET, 18).status).toBe("Can't tell");
    }
  });
});

describe('describeSession: the second line', () => {
  it('working on an open turn', () => {
    const text = describeSession(workingSession('api-refactor', { activeSubagents: 2 }), QUIET, 18);
    expect(text.line).toBe('Running a tool · last wrote 18 s ago · 2 subagents active');
    expect(describeSession(workingSession('api-refactor'), QUIET, 18).line).toBe('Running a tool · last wrote 18 s ago');
    expect(describeSession(workingSession('api-refactor', { activeSubagents: 1 }), QUIET, 400).line).toBe(
      'Running a tool · last wrote 6 min ago · 1 subagent active',
    );
  });

  it('just finished: quiet so far of the quiet time required', () => {
    expect(describeSession(justFinishedSession('docs'), QUIET, 18).line).toBe('Quiet 0:18 of 5:00');
  });

  it('finished', () => {
    expect(describeSession(finishedSession('infra'), QUIET, 3720).line).toBe('Turn ended · quiet 1 h 2 min');
  });

  it('can\'t tell: says why and that it counts as working', () => {
    expect(describeSession(cantTellSession('scratch'), QUIET, 40).line).toBe('No transcript found. Counted as working.');
    const unreadable = session({
      status: 'cantTell',
      turn: 'UNKNOWN',
      turnReason: 'cannotRead',
      turnDetail: 'EBUSY',
      why: { id: 'turnUnknown' },
    });
    expect(describeSession(unreadable, QUIET, 40).line).toBe("Couldn't read the transcript (EBUSY). Counted as working.");
    const noClock = session({ status: 'cantTell', turn: 'CLOSED', turnReason: 'turnEnded', why: { id: 'silenceUnknown' } });
    expect(describeSession(noClock, QUIET, null).line).toBe("Can't tell when it last wrote. Counted as working.");
  });

  it('turn ended but something is still going on', () => {
    const closed = { turn: 'CLOSED', turnReason: 'turnEnded', status: 'working', working: true } as const;
    expect(describeSession(session({ ...closed, why: { id: 'subagentsActive', count: 2 }, activeSubagents: 2 }), QUIET, 4).line).toBe(
      'Turn ended · 2 subagents active · last wrote 4 s ago',
    );
    expect(describeSession(session({ ...closed, why: { id: 'childBusy', name: 'npm', pid: 4321 } }), QUIET, 500).line).toBe(
      'Turn ended · npm (PID 4321) is still running',
    );
    expect(describeSession(session({ ...closed, why: { id: 'scheduledWakeup', inSeconds: 240 } }), QUIET, 500).line).toBe(
      'Turn ended · next scheduled run in 4 min',
    );
  });

  it('never promises a run "in 0 s": a /loop task due now, or whose time is unknown, is just pending', () => {
    const closed = { turn: 'CLOSED', turnReason: 'turnEnded', status: 'working', working: true } as const;
    for (const inSeconds of [0, -3]) {
      expect(describeSession(session({ ...closed, why: { id: 'scheduledWakeup', inSeconds } }), QUIET, 500).line).toBe(
        'Turn ended · a scheduled run is pending',
      );
    }
  });

  it('survives a reason it does not know', () => {
    const text = describeSession(session({ why: { id: 'somethingNew' } as unknown as SessionWhy }), QUIET, 18);
    expect(text.line).toBe('Running a tool · last wrote 18 s ago');
  });

  it('leaves out what it does not know instead of printing it', () => {
    expect(describeSession(workingSession('api-refactor'), QUIET, null).line).toBe('Running a tool');
    expect(describeSession(finishedSession('infra'), QUIET, null).line).toBe('Turn ended');
    expect(describeSession(justFinishedSession('docs'), QUIET, null).line).toBe(
      "Turn ended · can't tell how long it has been quiet",
    );
    expect(describeSession(justFinishedSession('docs'), NaN, 18).line).toBe(
      "Turn ended · can't tell how long it has been quiet",
    );
  });
});

describe('describeSession: stuck hint', () => {
  it('an open turn silent for more than 10 min with no subagent at work', () => {
    expect(describeSession(workingSession('web-ui'), QUIET, 2820).hint).toBe(
      'Nothing written for 47 min. May be waiting for your approval, or was interrupted.',
    );
  });

  it.each<[string, Partial<Session>, number | null]>([
    ['exactly 10 min', {}, 600],
    ['a short silence', {}, 18],
    ['unknown silence', {}, null],
    ['subagents at work', { activeSubagents: 1 }, 2820],
    ['a closed turn', { turn: 'CLOSED', turnReason: 'turnEnded' }, 2820],
    ['an unreadable turn', { turn: 'UNKNOWN', turnReason: 'noTranscript', status: 'cantTell' }, 2820],
    ['a session not waited for', { ignored: true }, 2820],
  ])('no hint for %s', (_case, overrides, silence) => {
    expect(describeSession(session(overrides), QUIET, silence).hint).toBeNull();
  });
});

describe('describeSession: tooltip', () => {
  it('is the raw engine truth', () => {
    expect(describeSession(workingSession('api-refactor'), QUIET, 18).tooltip).toBe('toolInFlight · turn OPEN · PID 9120');
    expect(describeSession(finishedSession('infra'), QUIET, 3720).tooltip).toBe('turnEnded · turn CLOSED · PID 9120');
  });

  it('adds the raw detail and leaves out a PID it does not have', () => {
    const foreign = session({ pid: null, turn: 'UNKNOWN', turnReason: 'cannotRead', turnDetail: 'EACCES', liveness: 'foreign' });
    expect(describeSession(foreign, QUIET, 18).tooltip).toBe('cannotRead (EACCES) · turn UNKNOWN');
  });

  it('never says a turn is closed unless the engine said so', () => {
    for (const turn of [...GARBAGE, 'closed', 'DONE']) {
      const text = describeSession(session({ turn: turn as 'OPEN' }), QUIET, 18);
      expect(text.tooltip).toContain('turn UNKNOWN');
      expectPrintable(text);
    }
  });
});

describe('describeSession: "Don\'t wait for this session"', () => {
  it('is offered for a session it can\'t tell about', () => {
    expect(describeSession(cantTellSession('scratch'), QUIET, 5).canIgnore).toBe(true);
    expect(describeSession(cantTellSession('scratch'), QUIET, null).canIgnore).toBe(true);
  });

  it('is offered for a working session only after more than 10 min of silence', () => {
    expect(describeSession(workingSession('web-ui'), QUIET, 601).canIgnore).toBe(true);
    expect(describeSession(workingSession('web-ui'), QUIET, 600).canIgnore).toBe(false);
    expect(describeSession(workingSession('web-ui'), QUIET, 18).canIgnore).toBe(false);
    expect(describeSession(workingSession('web-ui'), QUIET, null).canIgnore).toBe(false);
  });

  it('is not offered where there is nothing to override', () => {
    expect(describeSession(finishedSession('infra'), QUIET, 9000).canIgnore).toBe(false);
    expect(describeSession(justFinishedSession('docs'), QUIET, 9000).canIgnore).toBe(false);
    expect(describeSession(cantTellSession('scratch'), QUIET, 9000).canIgnore).toBe(true);
    expect(describeSession({ ...cantTellSession('scratch'), ignored: true }, QUIET, 9000).canIgnore).toBe(false);
  });

  it('is not offered without a key the leader would accept', () => {
    for (const ignoreKey of ['', 'proc:1:2', 'remote:x', undefined, null, 7]) {
      const text = describeSession({ ...cantTellSession('scratch'), ignoreKey: ignoreKey as string }, QUIET, 5);
      expect(text.canIgnore).toBe(false);
    }
  });
});

describe('describeSession: hostile input', () => {
  const whys: SessionWhy[] = [
    { id: 'turnOpen' },
    { id: 'turnUnknown' },
    { id: 'silenceUnknown' },
    { id: 'subagentsActive', count: 2 },
    { id: 'childBusy', name: 'npm', pid: 4321 },
    { id: 'scheduledWakeup', inSeconds: 240 },
    { id: 'recentWrite' },
    { id: 'quiet' },
  ];

  it.each(whys)('$id with every field replaced by junk', (why) => {
    for (const junk of GARBAGE) {
      const junkWhy = Object.fromEntries(Object.keys(why).map((key) => [key, key === 'id' ? why.id : junk]));
      const broken = session({
        why: junkWhy as unknown as SessionWhy,
        pid: junk as number,
        name: junk as string,
        turnReason: junk as TurnReason,
        turnDetail: junk as string,
        activeSubagents: junk as number,
        silenceSeconds: junk as number,
      });
      for (const silence of [junk as number, null, 18]) {
        const text = describeSession(broken, junk as number, silence);
        expect(text.line).not.toBe('');
        expect(text.tooltip).not.toBe('');
        expectPrintable(text);
        expect(text.line).not.toMatch(/waiting for you/i);
      }
    }
  });

  it('survives a session with no reason object at all', () => {
    for (const why of [undefined, null, 'turnOpen', 7]) {
      expectPrintable(describeSession(session({ why: why as unknown as SessionWhy }), QUIET, 18));
    }
  });
});
