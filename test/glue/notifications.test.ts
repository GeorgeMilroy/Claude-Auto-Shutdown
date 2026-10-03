// The editor's notifications and dialogs, against a stand-in for the `vscode` module that records
// what would have been shown. Two promises are kept here:
// - no text this extension shows can carry a link, whatever a session, folder, OS error or other
//   window put into it (the editor runs `[label](command:…)` in a notification when clicked);
// - the countdown digits of the status bar, the notification and the dashboard are the same.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LastResult, UiState } from '../../src/shared/protocol';
import { countdownToast, describeResult, fmtClock } from '../../src/shared/text';
import { copy } from '../../src/ui/copy';
import { lastRunReport } from '../../src/ui/lastRun';
import { plainMessage } from '../../src/ui/markdown';
import { askModal, CountdownNotice, notify, showToast } from '../../src/ui/notifications';
import { statusBarModel } from '../../src/ui/presenter';
import { remainingSeconds, stateForNow } from '../../src/ui/snapshot';
import { TransitionTracker } from '../../src/ui/transitions';
import { anchorCountdown, remainingSeconds as dashboardSeconds } from '../../src/webview/clock';
import { counting, countdown, snapshot, uiState, watching } from './fixtures';

/** Everything the stand-in editor was asked to show, as the text a person would see. */
const { shown, progressLines } = vi.hoisted(() => ({ shown: [] as string[], progressLines: [] as string[] }));

vi.mock('vscode', () => {
  const message =
    () =>
    (text: string, ...rest: unknown[]): Promise<undefined> => {
      shown.push(text);
      const options = rest[0];
      if (options !== null && typeof options === 'object' && 'detail' in options) shown.push(String(options.detail));
      return Promise.resolve(undefined);
    };
  return {
    ProgressLocation: { Notification: 15 },
    window: {
      showInformationMessage: message(),
      showWarningMessage: message(),
      showErrorMessage: message(),
      withProgress: (options: { title: string }, task: (progress: unknown, token: unknown) => Promise<void>) => {
        shown.push(options.title);
        const progress = { report: (step: { message?: string }) => step.message !== undefined && progressLines.push(step.message) };
        const token = { onCancellationRequested: () => ({ dispose: () => undefined }) };
        return task(progress, token);
      },
    },
  };
});

/** VS Code's own link parser for notification text (parseLinkedText in the workbench bundle). */
const EDITOR_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

/** What the editor does with a message before it looks for links: line breaks become spaces. */
function linksIn(text: string): string[] {
  return [...text.replace(/(\r\n|\n|\r)/gm, ' ').matchAll(EDITOR_LINK)].map((match) => match[2] ?? '');
}

const NAME = '[Show](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22shutdown%20%2Fs%20%2Ft%200%5Cr%22%7D)';
const VARIANTS = [
  NAME,
  '[Show]( command:x)',
  `[a\n](command:x)`,
  '[Show](https://example.com/x)',
  '[Show](file:///C:/Windows/System32/shutdown.exe "title")',
  '\\[Show\\](command:x)',
  '[[Show]](command:x)',
];

const AT = 1_700_000_400_000;

/** Every result whose one line or body can carry somebody else's words. */
function hostileResults(name: string): LastResult[] {
  return [
    { kind: 'cancelled', atMs: AT, reason: { id: 'sessionResumed', name }, stillWatching: true, countdownKind: 'real' },
    { kind: 'cancelled', atMs: AT, reason: { id: 'checkFailed', check: name }, stillWatching: false, countdownKind: 'real' },
    { kind: 'failed', atMs: AT, action: 'shutdown', message: name },
    { kind: 'testPassed', atMs: AT, action: 'shutdown', armedAtMs: null, lastSessionFinishedAtMs: null, allClearAtMs: null, heldUpBy: { name, seconds: 60 } },
  ];
}

/** Every message the host builds with somebody else's words in it. */
function hostileMessages(name: string): string[] {
  const results = hostileResults(name);
  return [
    ...results.map((result) => describeResult(result, name).oneLine),
    ...results.flatMap((result) => Object.values(lastRunReport(result, name))),
    copy.noLogFile(`C:\\${name}\\activity.log`),
    copy.autoStopFailed(name),
    copy.settingNotSaved(name),
    `Claude Auto Shutdown: ${name}`,
    name,
  ];
}

/** The toasts the tracker raises in a window that sees these results arrive. */
function trackerToasts(name: string): string[] {
  const tracker = new TransitionTracker();
  tracker.next(snapshot(watching()), AT);
  return hostileResults(name).flatMap((result, index) =>
    tracker
      .next(snapshot(uiState({ lastResult: { ...result, atMs: AT + index } })), AT + index)
      .flatMap((effect) => (effect.kind === 'toast' ? [effect.message] : [])),
  );
}

beforeEach(() => {
  shown.length = 0;
  progressLines.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('no link in anything shown', () => {
  it('the hostile name really is a link to the editor, so the tests below test something', () => {
    expect(linksIn(NAME)).toHaveLength(1);
    expect(trackerToasts(NAME).some((message) => linksIn(message).length > 0)).toBe(true);
  });

  it.each(VARIANTS)('a toast at every level: %s', (name) => {
    for (const message of [...hostileMessages(name), ...trackerToasts(name)]) {
      for (const level of ['info', 'warning', 'error'] as const) {
        showToast(level, message, { label: copy.show, command: 'claudeAutoShutdown.open' }, () => undefined);
        notify(level, message);
      }
    }
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) expect(linksIn(text), text).toEqual([]);
  });

  it.each(VARIANTS)('a modal dialog, title and detail: %s', (name) => {
    for (const message of hostileMessages(name)) {
      void askModal('warning', message, message, ['Keep this PC on']);
      void askModal('info', message, message, [copy.showLog]);
    }
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) expect(linksIn(text), text).toEqual([]);
  });

  it('the countdown notification, title and every line under it', () => {
    vi.useFakeTimers();
    const notice = new CountdownNotice();
    notice.show({ message: NAME, remainingSeconds: () => 3, totalSeconds: 90, onCancel: () => undefined });
    vi.advanceTimersByTime(2_000);
    notice.hide();
    expect(shown).toHaveLength(1);
    expect(progressLines).toEqual(['0:03 left', '0:03 left', '0:03 left']);
    for (const text of [...shown, ...progressLines]) expect(linksIn(text), text).toEqual([]);
  });

  it('keeps every word: only the link is broken, and ordinary brackets are left alone', () => {
    expect(plainMessage(NAME)).toBe(NAME.replace('](', ']\\('));
    expect(plainMessage('Project (1) went back to work')).toBe('Project (1) went back to work');
    expect(plainMessage('[draft] notes (v2)')).toBe('[draft] notes (v2)');
    expect(plainMessage('a\nb')).toBe('a\nb');
  });

  it('is the only way this extension shows a message', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file));
    const offenders = files.filter((file) => {
      if (path.normalize(file) === path.join('ui', 'notifications.ts')) return false;
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      return /\.(showInformationMessage|showWarningMessage|showErrorMessage|withProgress)\b/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the countdown digits', () => {
  /** What the three surfaces show `atMono` ms into a countdown received with `remainingMs` left. */
  function digits(remainingMs: number, atMono: number): { statusBar: string; notification: string; dashboard: string } {
    const received = snapshot(counting('real', { countdown: countdown({ remainingMs }) }), { receivedAtMono: 0 });
    const bar = statusBarModel(received, atMono, true).text.match(/\d+:\d\d/)?.[0] ?? 'none';

    const notice = new CountdownNotice();
    progressLines.length = 0;
    notice.show({
      message: countdownToast(received.state as UiState).message,
      remainingSeconds: () => remainingSeconds(received, atMono),
      totalSeconds: 90,
      onCancel: () => undefined,
    });
    notice.hide();

    // The dashboard page gets the state with the time it waited here taken off, and anchors it.
    const forPage = stateForNow(received, atMono)?.countdown;
    if (forPage === null || forPage === undefined) throw new Error('no countdown for the page');
    const page = fmtClock(dashboardSeconds(anchorCountdown(null, forPage, atMono), atMono));
    return { statusBar: bar, notification: (progressLines[0] ?? 'none').replace(' left', ''), dashboard: page };
  }

  it.each([
    [86_400, 0, '1:27'],
    [87_000, 500, '1:27'],
    [87_000, 2_500, '1:25'],
    [60_001, 0, '1:01'],
    [999, 0, '0:01'],
    [1_000, 999, '0:01'],
    [1_000, 1_000, '0:00'],
    [87_000, 90_000, '0:00'],
  ])('%i ms left, %i ms later: %s on every surface', (remainingMs, atMono, expected) => {
    expect(digits(remainingMs, atMono)).toEqual({ statusBar: expected, notification: expected, dashboard: expected });
  });

  it('agree at every moment of the last seconds', () => {
    for (let at = 0; at <= 3_000; at += 50) {
      const { statusBar, notification, dashboard } = digits(2_500, at);
      expect(notification, `${at} ms`).toBe(statusBar);
      expect(dashboard, `${at} ms`).toBe(statusBar);
    }
  });
});
