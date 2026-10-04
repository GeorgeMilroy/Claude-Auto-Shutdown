import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/core/types';
import type { UiState, ViewContext } from '../../src/shared/protocol';
import { rowKeyIntent, tabStopIndex } from '../../src/webview/roving';
import { buildSessions, FOLD_FINISHED_ABOVE, previewLength } from '../../src/webview/sessionsModel';
import type { SessionRow, SessionsModel } from '../../src/webview/sessionsModel';
import { allScenes, expectPrintable, NOW, scene, stateOf } from './support';

interface Options {
  wide?: boolean;
  scanAgeMs?: number | null;
  view?: Partial<ViewContext>;
  state?: (state: UiState) => UiState;
}

function sessionsOf(id: string, options: Options = {}): SessionsModel {
  const { view } = scene(id);
  const state = (options.state ?? ((value) => value))(stateOf(id));
  return buildSessions({
    state,
    view: { ...view, ...options.view },
    scanAgeMs: options.scanAgeMs === undefined ? 3_000 : options.scanAgeMs,
    nowMs: NOW,
    wide: options.wide ?? false,
  });
}

function row(model: SessionsModel, name: string): SessionRow {
  const found = model.rows.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no row named ${name}`);
  return found;
}

function withSessions(change: (sessions: Session[]) => Session[]): (state: UiState) => UiState {
  return (state) => ({ ...state, sessions: change(state.sessions) });
}

describe('the list', () => {
  it('is headed by the number of sessions', () => {
    expect(sessionsOf('watching-real').heading).toBe('SESSIONS · 3');
  });

  it("orders rows: can't tell, working, just finished, finished", () => {
    const shuffled = sessionsOf('watching-test', { state: withSessions((sessions) => [...sessions].reverse()) });
    expect(shuffled.rows.map((each) => each.status)).toEqual(['Working', 'Just finished', 'Finished']);
    const unknown = sessionsOf('watching-test', {
      state: withSessions((sessions) => [...sessions, { ...sessions[0], key: 'odd', name: 'odd', status: 'napping' } as unknown as Session]),
    });
    expect(unknown.rows[0]?.name).toBe('odd');
  });

  it('never draws a status it does not know as finished', () => {
    const model = sessionsOf('watching-test', {
      state: withSessions((sessions) => [{ ...sessions[0], status: 'napping' } as unknown as Session]),
    });
    expect(model.rows[0]?.glyph.icon).toBe('question');
    expect(model.rows[0]?.finished).toBe(false);
  });

  it('explains an empty list, and offers to start only while not watching', () => {
    const off = sessionsOf('off-empty');
    expect(off.rows).toEqual([]);
    expect(off.empty?.[0]).toBe('No Claude Code sessions found on this PC (looked in ~/.claude).');
    expect(off.empty?.join(' ')).toContain('You can start now');
    const watching = sessionsOf('watching-real', { state: withSessions(() => []) });
    expect(watching.empty?.join(' ')).not.toContain('You can start now');
  });

  it('promises to wait for a session only when the rules do (allowWhenNoSessions off)', () => {
    const plan = { ...scene('off-empty').view.plan, allowWhenNoSessions: true, testMode: false };
    const off = sessionsOf('off-empty', { view: { plan } });
    const text = off.empty?.join(' ') ?? '';
    expect(text).not.toContain('I wait for one to appear');
    expect(off.empty?.[2]).toBe(
      'No Claude session needed: with your settings this PC can shut down even if none ever appears. ' +
        "About 2 min after you start, once you've been away 10 min.",
    );
  });

  it("while watching, tells the rules in force, not this window's plan", () => {
    const allowing = (state: UiState): UiState => ({ ...state, sessions: [], contract: { ...state.contract, allowWhenNoSessions: true } });
    const watching = sessionsOf('watching-real', { state: allowing });
    expect(watching.empty?.join(' ')).toContain('with your settings this PC can shut down even if none ever appears');
    const plan = { ...scene('watching-real').view.plan, allowWhenNoSessions: true };
    const waiting = sessionsOf('watching-real', { state: withSessions(() => []), view: { plan } });
    expect(waiting.empty?.join(' ')).not.toMatch(/No Claude session needed|I wait for one/);
  });

  it('says it is still looking before the first scan has completed', () => {
    expect(sessionsOf('off-empty', { scanAgeMs: null }).empty).toEqual(['Looking for Claude Code sessions…']);
  });
});

describe('sessions left out to fit between windows', () => {
  it('are counted in the heading and named in a muted line', () => {
    const model = sessionsOf('watching-omitted');
    expect(model.heading).toBe('SESSIONS · 3 (+37 not shown)');
    expect(model.omitted).toBe('37 more sessions are counted but not listed (too many to send between windows).');
    expect(sessionsOf('watching-real').omitted).toBeNull();
    expect(sessionsOf('watching-real').heading).toBe('SESSIONS · 3');
  });

  it('say "1 more session is" for one', () => {
    const model = sessionsOf('watching-omitted', { state: (state) => ({ ...state, sessionsOmitted: 1 }) });
    expect(model.omitted).toBe('1 more session is counted but not listed (too many to send between windows).');
  });

  it('never let the list claim that no session was found', () => {
    const model = sessionsOf('watching-omitted', { state: (state) => ({ ...state, sessions: [], sessionsOmitted: 2 }) });
    expect(model.empty).toBeNull();
    expect(model.heading).toBe('SESSIONS · 0 (+2 not shown)');
    expect(model.omitted).toBe('2 more sessions are counted but not listed (too many to send between windows).');
  });
});

describe('folding finished sessions', () => {
  it(`folds them into one line when there are more than ${FOLD_FINISHED_ABOVE} sessions and the view is narrow`, () => {
    const model = sessionsOf('off-many');
    expect(model.rows).toHaveLength(8);
    expect(model.finishedFold?.label).toBe('6 finished');
    expect(model.finishedFold?.keys).toHaveLength(6);
  });

  it('does not fold in the wide layout, nor a short list', () => {
    expect(sessionsOf('off-many', { wide: true }).finishedFold).toBeNull();
    expect(sessionsOf('watching-test').finishedFold).toBeNull();
  });

  it('does not fold when nothing is finished', () => {
    expect(sessionsOf('watching-overrides').rows.length).toBeGreaterThan(FOLD_FINISHED_ABOVE);
    expect(sessionsOf('watching-overrides').finishedFold).toBeNull();
  });

  it('shows more transcript lines in the wide layout', () => {
    expect(previewLength(false)).toBe(5);
    expect(previewLength(true)).toBe(12);
  });
});

describe('a row', () => {
  it('ages the silence by the age of the scan', () => {
    expect(row(sessionsOf('watching-real', { scanAgeMs: 0 }), 'api-refactor').line).toContain('last wrote 18 s ago');
    expect(row(sessionsOf('watching-real', { scanAgeMs: 7_000 }), 'api-refactor').line).toContain('last wrote 25 s ago');
  });

  it('gives a just-finished session a meter that stops at the target', () => {
    const fresh = row(sessionsOf('watching-test', { scanAgeMs: 0 }), 'docs');
    expect(fresh.meter?.fraction).toBeCloseTo(18 / 300);
    expect(fresh.meter?.valueText).toBe('Quiet 18 seconds of 5 minutes');
    const overdue = row(sessionsOf('watching-test', { scanAgeMs: 900_000 }), 'docs');
    expect(overdue.meter?.fraction).toBe(1);
    expect(overdue.line).toBe('Quiet 5:00 of 5:00');
  });

  it('gives no other session a meter', () => {
    const model = sessionsOf('watching-test');
    expect(row(model, 'api-refactor').meter).toBeNull();
    expect(row(model, 'infra').meter).toBeNull();
  });

  it('shows the stuck hint for an open turn that has been silent for long', () => {
    const model = sessionsOf('watching-real');
    expect(row(model, 'web-ui').hint).toMatch(/^Nothing written for 47 min/);
    expect(row(model, 'api-refactor').hint).toBeNull();
  });

  it('spells out the raw details', () => {
    const model = sessionsOf('watching-real');
    expect(row(model, 'api-refactor').details).toBe('D:\\work\\api-refactor · CLI · PID 9120 · turn OPEN');
    expect(row(model, 'web-ui').details).toContain('VS Code');
    expect(row(model, 'scratch').details).toContain('turn UNKNOWN');
  });

  it('leaves unknown details out instead of printing blanks', () => {
    const transcriptOnly = row(sessionsOf('watching-overrides'), '3f9a2c1d');
    expect(transcriptOnly.details).toBe('turn OPEN');
  });

  it('tags a session found only by its transcript, and one from another machine', () => {
    const model = sessionsOf('watching-overrides');
    expect(row(model, '3f9a2c1d').tags).toEqual(['not in the session list']);
    expect(row(model, 'ubuntu-api').tags).toEqual(['WSL: Ubuntu']);
    expect(row(model, 'scratch').tags).toEqual([]);
  });

  it('says when the process could not be confirmed', () => {
    const model = sessionsOf('watching-overrides');
    expect(row(model, 'unverified-one').notes).toEqual(["Couldn't confirm this session's process; treating it as running."]);
    expect(row(model, 'scratch').notes).toEqual([]);
  });

  it('lists subagents with how long ago they wrote', () => {
    const api = row(sessionsOf('watching-real'), 'api-refactor');
    expect(api.subagentsHeading).toBe('Subagents (2)');
    expect(api.subagents.map((each) => `${each.name} · ${each.text}`)).toEqual([
      'agent-a1 · wrote 4 s ago · active',
      'agent-b7 · wrote 6 min ago',
    ]);
  });

  it('can ask for a preview only when there is a transcript', () => {
    const model = sessionsOf('watching-real');
    expect(row(model, 'api-refactor').hasTranscript).toBe(true);
    expect(row(model, 'api-refactor').openTranscript?.action).toMatchObject({ do: 'send', messages: [{ type: 'openTranscript' }] });
    expect(row(model, 'scratch').hasTranscript).toBe(false);
    expect(row(model, 'scratch').openTranscript).toBeNull();
  });
});

describe("a row with Claude Code's own status", () => {
  it('says what Claude Code says, in the line, the hint and the details', () => {
    const model = sessionsOf('watching-claude-status');
    const busy = row(model, 'api-refactor');
    expect(busy.status).toBe('Working');
    expect(busy.details).toBe('D:\\work\\api-refactor · VS Code · PID 9120 · turn OPEN · Claude Code: busy');
    const asking = row(model, 'web-ui');
    expect(asking.hint).toBe('Needs your answer (permission prompt). Nothing written for 47 min.');
    expect(asking.details).toContain('Claude Code: waiting');
    expect(row(model, 'docs').details).toContain('turn CLOSED · Claude Code: idle');
  });

  it('says when the transcript overruled the status, and leaves garbage out', () => {
    const overruled = sessionsOf('watching-claude-status', {
      state: withSessions((sessions) => sessions.map((s) => (s.name === 'docs' ? { ...s, turnSource: 'transcript' } : s))),
    });
    expect(row(overruled, 'docs').details).toContain('Claude Code: idle, judged by the transcript');
    for (const claudeStatus of [null, '', '  ', 7, {}, ['busy']]) {
      const garbled = sessionsOf('watching-claude-status', {
        state: withSessions((sessions) => sessions.map((s) => ({ ...s, claudeStatus: claudeStatus as string }))),
      });
      expect(row(garbled, 'api-refactor').details).not.toContain('Claude Code');
      expectPrintable(garbled);
    }
    const long = sessionsOf('watching-claude-status', {
      state: withSessions((sessions) => sessions.map((s) => ({ ...s, claudeStatus: `a\n${'x'.repeat(200)}` }))),
    });
    expect(row(long, 'api-refactor').details).toMatch(/Claude Code: a x{30}$/);
  });
});

describe('"Don\'t wait for…" on sessions', () => {
  it("is offered for a session that can't be read, and for one that went silent while working", () => {
    const model = sessionsOf('watching-real');
    expect(row(model, 'scratch').dontWait?.action).toEqual({
      do: 'send',
      messages: [{ type: 'ignore', key: 'session:0:9400:scratch:0:0:0', on: true }],
    });
    expect(row(model, 'web-ui').dontWait).not.toBeNull();
    expect(row(model, 'api-refactor').dontWait).toBeNull();
  });

  it('turns into "Not waited for" with an Undo', () => {
    const ignored = row(sessionsOf('watching-overrides'), 'old-notes');
    expect(ignored.status).toBe('Not waited for');
    expect(ignored.glyph.icon).toBe('debug-step-over');
    expect(ignored.dontWait).toBeNull();
    expect(ignored.undo?.action).toEqual({
      do: 'send',
      messages: [{ type: 'ignore', key: 'session:0:9401:old-notes:0:0:0', on: false }],
    });
  });

  it('offers the same for a command a session started', () => {
    const children = row(sessionsOf('watching-overrides'), 'web-ui').children;
    expect(children.map((child) => child.text)).toEqual(['npm (PID 4321) is still running', 'cargo (PID 4410) · Not waited for']);
    expect(children[0]?.control).toEqual({
      label: "Don't wait for it",
      action: { do: 'send', messages: [{ type: 'ignore', key: 'proc:4321:133800000000000000', on: true }] },
    });
    expect(children[1]?.control?.label).toBe('Undo');
  });

  it('does not list a command that is neither busy nor ignored', () => {
    const model = sessionsOf('watching-overrides', {
      state: withSessions((sessions) =>
        sessions.map((each) => ({ ...each, children: each.children.map((child) => ({ ...child, busy: false })) })),
      ),
    });
    expect(row(model, 'web-ui').children.map((child) => child.ignored)).toEqual([true]);
  });

  it('is not offered from a window that can only Cancel and Stop', () => {
    const model = sessionsOf('watching-overrides', { view: { limited: true } });
    for (const each of model.rows) {
      expect(each.dontWait).toBeNull();
      expect(each.undo).toBeNull();
      expect(each.children.every((child) => child.control === null)).toBe(true);
    }
    // Looking at a transcript still works: the host answers that by itself.
    expect(row(model, 'web-ui').openTranscript).not.toBeNull();
  });
});

describe('a list that cannot be trusted', () => {
  it('says how old it is instead of how many sessions there are', () => {
    const model = sessionsOf('degraded', { scanAgeMs: 48_000 });
    expect(model.stale).toBe(true);
    expect(model.heading).toBe('SESSIONS · last seen 48 s ago');
  });

  it('shows the rows as they were last seen, without ageing them', () => {
    const model = sessionsOf('degraded', { scanAgeMs: 48_000 });
    expect(row(model, 'api-refactor').line).toContain('last wrote 18 s ago');
  });
});

describe('roving tabindex', () => {
  it('moves with Up, Down, Home and End, and stops at the ends', () => {
    expect(rowKeyIntent('ArrowDown', 0, 3, false)).toEqual({ move: 1 });
    expect(rowKeyIntent('ArrowDown', 2, 3, false)).toBeNull();
    expect(rowKeyIntent('ArrowUp', 2, 3, false)).toEqual({ move: 1 });
    expect(rowKeyIntent('ArrowUp', 0, 3, false)).toBeNull();
    expect(rowKeyIntent('Home', 2, 3, false)).toEqual({ move: 0 });
    expect(rowKeyIntent('End', 0, 3, false)).toEqual({ move: 2 });
  });

  it('opens with Right and closes with Left', () => {
    expect(rowKeyIntent('ArrowRight', 1, 3, false)).toEqual({ expand: true });
    expect(rowKeyIntent('ArrowRight', 1, 3, true)).toBeNull();
    expect(rowKeyIntent('ArrowLeft', 1, 3, true)).toEqual({ expand: false });
    expect(rowKeyIntent('ArrowLeft', 1, 3, false)).toBeNull();
  });

  it('leaves every other key, and a key from outside the list, alone', () => {
    expect(rowKeyIntent('Enter', 1, 3, false)).toBeNull();
    expect(rowKeyIntent('a', 1, 3, false)).toBeNull();
    expect(rowKeyIntent('ArrowDown', -1, 3, false)).toBeNull();
    expect(rowKeyIntent('ArrowDown', 0, 0, false)).toBeNull();
  });

  it('keeps one tab stop: the remembered row, else the first', () => {
    expect(tabStopIndex(['a', 'b', 'c'], 'b')).toBe(1);
    expect(tabStopIndex(['a', 'b', 'c'], 'gone')).toBe(0);
    expect(tabStopIndex(['a', 'b', 'c'], null)).toBe(0);
  });
});

describe('every fixture', () => {
  it('builds without throwing and prints no raw unknown, narrow and wide', () => {
    for (const { scene: each } of allScenes()) {
      if (each.state === null) continue;
      for (const wide of [false, true]) {
        for (const scanAgeMs of [null, 4_000]) {
          expectPrintable(buildSessions({ state: each.state, view: each.view, scanAgeMs, nowMs: NOW, wide }));
        }
      }
    }
  });
});
