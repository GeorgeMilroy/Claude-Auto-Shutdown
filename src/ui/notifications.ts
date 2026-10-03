// The editor's own notifications and dialogs: the cancellable countdown notification, one-shot
// messages and modal questions. Every message this extension shows goes through this file, and
// every text is passed through plainMessage on its way out: it quotes names other programs wrote
// (sessions, folders, OS errors, another window's app), and the editor would turn link syntax in
// them into a link that runs a command.

import * as vscode from 'vscode';

import { fmtClock } from '../shared/text';
import { copy } from './copy';
import { detached } from './detached';
import { plainMessage } from './markdown';
import type { ToastAction } from './transitions';

export interface CountdownNoticeOptions {
  /** e.g. "Claude finished. This PC shuts down at 02:15:30." */
  message: string;
  /** Whole seconds left right now, as every surface shows them; null = the state does not say. */
  remainingSeconds(): number | null;
  /** Length of the whole countdown in seconds; null = unknown (no bar). */
  totalSeconds: number | null;
  /** The user pressed the notification's Cancel. */
  onCancel(): void;
}

const TICK_MS = 1000;

function elapsedPercent(remainingSeconds: number | null, totalSeconds: number | null): number | null {
  if (remainingSeconds === null || totalSeconds === null || totalSeconds <= 0) return null;
  return Math.min(100, Math.max(0, (1 - remainingSeconds / totalSeconds) * 100));
}

/** The line under the countdown notification's title: "1:27 left", or the final check. */
export function countdownNoticeLine(seconds: number | null): string {
  return seconds === null ? copy.finalCheck : copy.countdownLeft(fmtClock(seconds));
}

/**
 * The countdown as a progress notification. It stays up exactly as long as this window shows that
 * countdown: hide() withdraws it, so nothing lingers once the countdown is over. Its digits are
 * computed from the leader's deadline on every tick; nothing is decremented locally.
 */
export class CountdownNotice implements vscode.Disposable {
  private withdraw: (() => void) | null = null;

  show(options: CountdownNoticeOptions): void {
    this.hide();
    const withdrawn = new Promise<void>((resolve) => {
      this.withdraw = resolve;
    });
    detached(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: plainMessage(options.message), cancellable: true },
        (progress, token) => {
          token.onCancellationRequested(() => options.onCancel());
          let reportedPercent = 0;
          const tick = (): void => {
            const seconds = options.remainingSeconds();
            const percent = elapsedPercent(seconds, options.totalSeconds);
            // The bar only ever moves forward, by the difference to what it already shows.
            const increment = percent === null ? undefined : Math.max(0, percent - reportedPercent);
            if (percent !== null) reportedPercent = Math.max(reportedPercent, percent);
            progress.report({ message: plainMessage(countdownNoticeLine(seconds)), increment });
          };
          tick();
          const timer = setInterval(tick, TICK_MS);
          return withdrawn.finally(() => clearInterval(timer));
        },
      ),
    );
  }

  hide(): void {
    this.withdraw?.();
    this.withdraw = null;
  }

  dispose(): void {
    this.hide();
  }
}

export type ToastLevel = 'info' | 'warning' | 'error';

function showMessage(level: ToastLevel, message: string, buttons: string[]): Thenable<string | undefined> {
  const text = plainMessage(message);
  switch (level) {
    case 'error':
      return vscode.window.showErrorMessage(text, ...buttons);
    case 'warning':
      return vscode.window.showWarningMessage(text, ...buttons);
    default:
      return vscode.window.showInformationMessage(text, ...buttons);
  }
}

/** A one-shot message with at most one button. `run` is called when that button is pressed. */
export function showToast(level: ToastLevel, message: string, action: ToastAction | null, run: (action: ToastAction) => void): void {
  detached(
    showMessage(level, message, action === null ? [] : [action.label]).then((picked) => {
      if (action !== null && picked === action.label) run(action);
    }),
  );
}

/** A one-shot message without a button. */
export function notify(level: ToastLevel, message: string): void {
  showToast(level, message, null, () => undefined);
}

/**
 * A modal question. Resolves to the label of the button pressed, or undefined when the dialog
 * was dismissed. Button labels are ours; the title and the detail may quote untrusted values.
 */
export function askModal(level: 'info' | 'warning', title: string, detail: string, buttons: string[]): Thenable<string | undefined> {
  const options: vscode.MessageOptions = { modal: true, detail: plainMessage(detail) };
  return level === 'warning'
    ? vscode.window.showWarningMessage(plainMessage(title), options, ...buttons)
    : vscode.window.showInformationMessage(plainMessage(title), options, ...buttons);
}
