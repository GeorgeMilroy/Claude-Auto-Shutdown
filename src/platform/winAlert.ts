// The OS-level countdown warning on Windows: a separate one-shot PowerShell process that shows one
// small always-on-top window (resources/win-countdown-alert.ps1) and does nothing else.
//
// The window is display only. It prints CANCEL when the user presses its button or closes it; the
// controller decides what that means. Ending the countdown is always done by killing the process.

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { powershellPath } from './winPower';
import type { CountdownAlert, CountdownAlertOptions } from './types';

export interface AlertLaunch {
  file: string;
  args: string[];
  cwd: string;
  /** Variables added to the environment of the alert process (the texts). */
  env: Record<string, string>;
}

const KINDS: readonly CountdownAlertOptions['kind'][] = ['real', 'test', 'preview'];
const MAX_SECONDS = 86_400;

/** Shown inside the window so a rehearsal can never be mistaken for the real thing. */
const BADGES: Record<CountdownAlertOptions['kind'], string> = {
  real: '',
  test: 'TEST RUN - nothing will happen to this PC',
  preview: 'PREVIEW - nothing will happen to this PC',
};

/** One line of display text: no control characters (they would also corrupt the environment block). */
function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * The command line of the alert; null when the options are not usable.
 *
 * Only numbers and fixed words travel as arguments. The texts go through environment variables: an
 * argument that happens to start with '-' would be read by PowerShell as a parameter name.
 *
 * `nowMs` is the moment the alert was asked for. The window counts down to the absolute deadline
 * derived from it, so the seconds PowerShell and WinForms take to start are already spent when it
 * appears, and it never shows more time than remains.
 */
export function buildAlertLaunch(
  systemRoot: string,
  extensionPath: string,
  options: CountdownAlertOptions,
  parentPid: number,
  nowMs: number,
): AlertLaunch | null {
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || !KINDS.includes(options.kind)) return null;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return null;
  const seconds = Math.min(Math.floor(options.seconds), MAX_SECONDS);
  const file = powershellPath(systemRoot);
  return {
    file,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(extensionPath, 'resources', 'win-countdown-alert.ps1'),
      '-Seconds',
      String(seconds),
      '-DeadlineUnixMs',
      String(nowMs + seconds * 1000),
      '-Kind',
      options.kind,
      '-ParentPid',
      String(parentPid),
      ...(options.sound === true ? ['-Sound'] : []),
    ],
    cwd: path.win32.dirname(file),
    env: {
      CAS_ALERT_TITLE: cleanText(options.title, 120),
      CAS_ALERT_BODY: cleanText(options.body, 240),
      CAS_ALERT_CANCEL: cleanText(options.cancelLabel, 60),
      CAS_ALERT_BADGE: BADGES[options.kind],
    },
  };
}

/** An alert that shows nothing (the window could not be started). */
export function inertAlert(): CountdownAlert {
  return { onCancel: () => undefined, stop: () => undefined };
}

/** A running alert window. */
export class AlertProcess implements CountdownAlert {
  private child: ChildProcess | null = null;
  private listeners: (() => void)[] = [];
  private cancelled = false;
  private stopped = false;
  private shown = false;
  private ended = false;
  private stdoutText = '';
  private stderrText = '';
  private resolveExited!: () => void;
  /** Resolves when the window's process is gone. */
  readonly exited = new Promise<void>((resolve) => (this.resolveExited = resolve));

  constructor(
    launch: AlertLaunch,
    private readonly log: (message: string) => void,
  ) {
    try {
      this.child = spawn(launch.file, launch.args, {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.onExit(null, error instanceof Error ? error.message : String(error));
      return;
    }
    this.child.stdout?.on('data', (chunk: Buffer) => this.onOutput(chunk.toString('utf8')));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrText.length < 2000) this.stderrText += chunk.toString('latin1');
    });
    this.child.on('error', (error) => this.onExit(null, error.message));
    this.child.on('exit', (code) => this.onExit(code, null));
  }

  /** PID of the window's process while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The window reported that it is on screen. */
  get isShown(): boolean {
    return this.shown;
  }

  onCancel(listener: () => void): void {
    if (this.stopped) return;
    if (this.cancelled) this.notify(listener);
    else this.listeners.push(listener);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.listeners = [];
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
  }

  private onOutput(text: string): void {
    this.stdoutText += text;
    let newline: number;
    while ((newline = this.stdoutText.indexOf('\n')) >= 0) {
      const word = this.stdoutText.slice(0, newline).trim();
      this.stdoutText = this.stdoutText.slice(newline + 1);
      if (word === 'SHOWN') this.shown = true;
      else if (word === 'CANCEL') this.onCancelled();
    }
    // Only two short words are ever expected; anything longer is noise.
    if (this.stdoutText.length > 4096) this.stdoutText = '';
  }

  private onCancelled(): void {
    if (this.cancelled || this.stopped) return;
    this.cancelled = true;
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) this.notify(listener);
  }

  private notify(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.log(`Countdown alert: the cancel handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onExit(code: number | null, error: string | null): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.stopped && !this.cancelled && (error !== null || (code !== null && code !== 0))) {
      const reason = error ?? (this.stderrText.replace(/\s+/g, ' ').trim().slice(0, 300) || `exit code ${code}`);
      this.log(`The countdown warning window could not be shown: ${reason}`);
    }
    this.resolveExited();
  }
}
