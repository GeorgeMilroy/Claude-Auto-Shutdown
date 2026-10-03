// Draws what this window may show on the editor's surfaces: status bar, context keys, the
// countdown notification, one-shot messages, the dashboard pages and the output channel.
//
// Every surface is fed from the same snapshot, in every window alike. Each one is drawn on its
// own: a surface that fails must not take the status bar - a way to cancel - down with it.

import type * as vscode from 'vscode';

import type { ViewContext } from '../shared/protocol';
import { ActivityMirror, activityLine } from './activityMirror';
import { copy } from './copy';
import type { Dashboard } from './dashboard';
import type { DashboardContent } from './dashboardSurface';
import { CONTEXT_KEYS } from './ids';
import type { CommandId } from './ids';
import type { Log } from './log';
import { CountdownNotice, showToast } from './notifications';
import { contextKeyValues, statusBarModel } from './presenter';
import type { SettingsBridge } from './settings';
import { countdownOf, remainingSeconds, stateForNow } from './snapshot';
import { ContextKeys, StatusBar } from './statusBar';
import { TransitionTracker } from './transitions';
import type { Effect } from './transitions';
import type { AutoStopOutcome, WindowSession } from './windowSession';
import { unsavedFiles } from './workspaceFacts';

export interface WindowUiOptions {
  session: WindowSession;
  settings: SettingsBridge;
  dashboard: Dashboard;
  log: Log;
  /** This window's label, for the view context. */
  windowLabel: string;
  /** Folder of the Emergency stop file (for the message when it cannot be written). */
  stopDir: string;
  /** Run one of this extension's commands (a button on a message was pressed). */
  run(command: CommandId): void;
  /** Cancel pressed in the countdown notification. */
  cancelFromNotification(): void;
}

/** While a countdown is shown, the status bar digits are refreshed this often between states. */
const COUNTDOWN_TICK_MS = 500;

export class WindowUi implements vscode.Disposable {
  private readonly options: WindowUiOptions;
  private readonly statusBar = new StatusBar();
  private readonly contextKeys = new ContextKeys();
  private readonly countdownNotice = new CountdownNotice();
  private readonly tracker = new TransitionTracker();
  private readonly activity = new ActivityMirror();
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  /** The last failure reported per surface, so a surface that stays broken is logged once. */
  private readonly failures = new Map<string, string>();

  constructor(options: WindowUiOptions) {
    this.options = options;
  }

  /** What the dashboard pages are sent: the state as of this moment, and this window's own facts. */
  dashboardContent(): DashboardContent {
    return { state: stateForNow(this.options.session.current, performance.now()), view: this.viewContext() };
  }

  /** Bring every surface up to date with the session's current snapshot. */
  render(): void {
    this.guarded('the status bar', () => this.renderStatusBar());
    this.guarded('the command conditions', () => this.contextKeys.apply(contextKeyValues(this.options.session.current)));
    this.guarded('the notifications', () => this.announceTransitions());
    this.guarded('the dashboard', () => this.options.dashboard.render());
    this.guarded('the log', () => this.mirrorActivity());
    this.guarded('the countdown clock', () => this.syncCountdownTimer());
  }

  /** A Stop or Cancel from this window went unconfirmed, and what became of Emergency stop. */
  announceAutoStop(outcome: AutoStopOutcome): void {
    const reveal = { label: copy.stopFolder, command: 'claudeAutoShutdown.revealStop' } as const;
    switch (outcome) {
      case 'set':
        return showToast('warning', copy.autoStopSet, reveal, (action) => this.options.run(action.command));
      case 'alreadySet':
        return showToast('warning', copy.autoStopAlreadySet, reveal, (action) => this.options.run(action.command));
      case 'failed':
        return showToast('error', copy.autoStopFailed(this.options.stopDir), null, () => undefined);
      case 'cleared':
        return showToast('info', copy.autoStopCleared, null, () => undefined);
    }
  }

  dispose(): void {
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownNotice.dispose();
    this.statusBar.dispose();
  }

  private viewContext(): ViewContext {
    const { session, settings, windowLabel } = this.options;
    return {
      role: session.current.role,
      limited: session.current.limited,
      plan: settings.plan,
      windowLabel,
      unsavedFiles: unsavedFiles(),
      pending: session.pending,
      autoStopSet: session.autoStopSet,
    };
  }

  private renderStatusBar(): void {
    const { session, settings } = this.options;
    this.statusBar.render(statusBarModel(session.current, performance.now(), settings.current.showStatusBar));
  }

  private announceTransitions(): void {
    for (const effect of this.tracker.next(this.options.session.current, Date.now())) this.apply(effect);
  }

  private apply(effect: Effect): void {
    switch (effect.kind) {
      case 'countdownStarted':
        this.showCountdown(effect.message);
        return;
      case 'countdownEnded':
        this.countdownNotice.hide();
        return;
      case 'previewDone':
        this.contextKeys.set(CONTEXT_KEYS.previewDone, true);
        return;
      case 'toast':
        showToast(effect.level, effect.message, effect.action, (action) => this.options.run(action.command));
        return;
    }
  }

  /** In every window: the cancellable notification, and the dashboard without taking the focus. */
  private showCountdown(message: string): void {
    const { session, dashboard, log } = this.options;
    const totalMs = countdownOf(session.current.state)?.totalMs ?? null;
    this.countdownNotice.show({
      message,
      remainingSeconds: () => remainingSeconds(session.current, performance.now()),
      totalSeconds: totalMs === null ? null : totalMs / 1000,
      onCancel: () => this.options.cancelFromNotification(),
    });
    dashboard.reveal(true).then(undefined, (error: unknown) => {
      log.warn(`The dashboard could not be revealed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private mirrorActivity(): void {
    const { session, log } = this.options;
    const state = session.current.state;
    if (state === null) return;
    const now = Date.now();
    for (const entry of this.activity.take(state.activity)) {
      const line = activityLine(entry, now);
      if (entry.level === 'error') log.error(line);
      else if (entry.level === 'warn') log.warn(line);
      else log.info(line);
    }
  }

  /** Between two states of the leader the digits still have to move. */
  private syncCountdownTimer(): void {
    const counting = countdownOf(this.options.session.current.state) !== null;
    if (counting && this.countdownTimer === null) {
      this.countdownTimer = setInterval(() => this.guarded('the status bar', () => this.renderStatusBar()), COUNTDOWN_TICK_MS);
    } else if (!counting && this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private guarded(what: string, draw: () => void): void {
    try {
      draw();
      this.failures.delete(what);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.failures.get(what) === reason) return;
      this.failures.set(what, reason);
      this.options.log.error(`Couldn't update ${what}: ${reason}`);
    }
  }
}
