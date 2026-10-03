// Everything a person can ask this window to do - from the Command Palette, the status bar, a
// notification or the dashboard. Each request ends up here, whichever surface it came from, so a
// button and its command can never behave differently.
//
// Nothing in this file decides what happens to the PC: starting, stopping and cancelling are
// requests to the leader. The confirmation of a real run is shown here, in the window the person
// is looking at; what its buttons mean is decided in startFlow.ts.

import * as path from 'node:path';
import * as vscode from 'vscode';

import { tailEvents } from '../core/transcript';
import type { TranscriptEvent } from '../core/types';
import type { Config } from '../shared/config';
import type { CancelVia, Command, CommandResult, WebviewToHost, WindowHello } from '../shared/protocol';
import { StateDir } from '../shared/stateDir';
import type { RealModalText } from '../shared/text';
import { copy } from './copy';
import type { Dashboard } from './dashboard';
import type { DashboardSurface } from './dashboardSurface';
import { SETTINGS_SECTION, WALKTHROUGH_ID } from './ids';
import { lastRunReport, readLastRun } from './lastRun';
import type { Log } from './log';
import { askModal, notify } from './notifications';
import type { SettingsBridge } from './settings';
import { isRecord } from './snapshot';
import { StartFlow, modalAnswer, modalButtons } from './startFlow';
import type { RealRunAnswer } from './startFlow';
import { startChoices, startRefusal } from './startPlan';
import type { PlanChange } from './startPlan';
import { isListedTranscript, isSettingKey, previewTarget } from './webviewMessages';
import type { WindowSession } from './windowSession';
import { unsavedFiles } from './workspaceFacts';

export interface ActionsOptions {
  extensionId: string;
  session: WindowSession;
  settings: SettingsBridge;
  stateDir: StateDir;
  self: WindowHello;
  dashboard: Dashboard;
  log: Log;
  /** Re-read the settings now instead of waiting for the editor's change event. */
  settingsMayHaveChanged(): void;
}

/** Enough for the wide layout of the dashboard (the narrow one shows the last 5). */
const PREVIEW_EVENTS = 12;
/** A transcript inside WSL is read over a network path, which can hang. */
const PREVIEW_TIMEOUT_MS = 5000;
const LOG_FILE_NAME = 'activity.log';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function confirmRealRun(text: RealModalText): Promise<RealRunAnswer> {
  const picked = await askModal('warning', text.title, text.detail, modalButtons(text));
  return modalAnswer(text, picked);
}

async function saveAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.files.saveAll');
}

export class Actions {
  private readonly options: ActionsOptions;
  private readonly startFlow: StartFlow;

  constructor(options: ActionsOptions) {
    this.options = options;
    this.startFlow = new StartFlow({
      session: options.session,
      settings: options.settings,
      realm: options.self.realm,
      confirmRealRun,
      saveAll,
      unsavedFiles,
    });
  }

  // ----- dashboard, log, settings --------------------------------------------------------------

  openDashboard(): Promise<void> {
    return this.options.dashboard.reveal(false);
  }

  openInEditor(): void {
    this.options.dashboard.openInEditor();
  }

  showLog(): void {
    this.options.log.show();
  }

  /** The activity log file of the window in control (the same file for every window of a user). */
  async openLogFile(): Promise<void> {
    const file = this.logFile();
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    } catch {
      notify('info', copy.noLogFile(file));
    }
  }

  async openSettings(setting?: keyof Config): Promise<void> {
    const query = setting === undefined ? `@ext:${this.options.extensionId}` : `@id:${SETTINGS_SECTION}.${setting}`;
    await vscode.commands.executeCommand('workbench.action.openSettings', query);
  }

  async openWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${this.options.extensionId}#${WALKTHROUGH_ID}`, false);
  }

  async showLastRun(): Promise<void> {
    const result = readLastRun(this.options.stateDir);
    if (result === null) {
      notify('info', copy.noLastRun);
      return;
    }
    const report = lastRunReport(result, this.osName());
    const picked = await askModal('info', report.message, report.detail, [copy.showLog]);
    if (picked === copy.showLog) this.showLog();
  }

  /** Opens the folder a STOP file goes into; when one is there, shows that file. */
  async revealStopFolder(): Promise<void> {
    const folder = this.stopFolder();
    if (folder === this.options.stateDir) folder.ensure();
    const { file } = folder.stopStatus();
    if (file !== null) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
    else await vscode.env.openExternal(vscode.Uri.file(folder.dir));
  }

  // ----- watching ------------------------------------------------------------------------------

  /** The Command Palette's "Start Watching…": pick test run / for real / just notify, then start. */
  async pickAndStart(): Promise<void> {
    const refusal = startRefusal(this.options.session.current);
    if (refusal !== null) {
      notify('warning', refusal);
      return;
    }
    const picker = copy.startPicker;
    const picked = await vscode.window.showQuickPick(startChoices(this.options.settings.current.action), {
      title: picker.title,
      placeHolder: picker.placeholder,
    });
    if (picked === undefined) return;
    if (picked.change === null) {
      await this.openSettings('action');
      return;
    }
    if (await this.writePlan(picked.change)) await this.startAndReport();
  }

  /** Start with this window's plan, and tell the person when that did not work. */
  async startAndReport(): Promise<void> {
    const result = await this.start();
    // No error text = the person chose "Keep this PC on" in the confirmation.
    if (result.ok || result.error === undefined) return;
    this.options.dashboard.post({ type: 'focusPlan' });
    notify('error', result.error);
  }

  /** Start watching with this window's plan (see startFlow.ts). */
  start(): Promise<CommandResult> {
    return this.startFlow.start();
  }

  async stopWatching(): Promise<void> {
    await this.options.session.sendSafe({ name: 'disarm' });
  }

  async cancelCountdown(via: CancelVia): Promise<void> {
    await this.options.session.sendSafe({ name: 'cancel', via });
  }

  preview(): Promise<void> {
    return this.request({ name: 'preview' });
  }

  refresh(): Promise<void> {
    return this.request({ name: 'refresh' });
  }

  // ----- messages from the dashboard -----------------------------------------------------------

  /** `message` has been checked field by field (see webviewMessages.ts). */
  handleWebviewMessage(message: WebviewToHost, surface: DashboardSurface): void {
    this.dispatch(message, surface).catch((error: unknown) => {
      this.options.log.error(`A request from the dashboard (${message.type}) failed: ${describe(error)}`);
    });
  }

  private async dispatch(message: WebviewToHost, surface: DashboardSurface): Promise<void> {
    switch (message.type) {
      case 'ready':
        // The surface has already answered with the state.
        return this.options.log.debug('dashboard: a page loaded and asked for the state');
      case 'start':
        return this.startAndReport();
      case 'stop':
        return this.stopWatching();
      case 'cancel':
        return this.cancelCountdown('button');
      case 'refresh':
        return this.refresh();
      case 'preview':
        return this.preview();
      case 'dismissResult':
        return this.request({ name: 'dismissResult' });
      case 'setAction':
        return void (await this.writePlan({ action: message.action }));
      case 'setTestMode':
        return void (await this.writePlan({ testMode: message.testMode }));
      case 'ignore':
        return this.request({ name: 'ignore', key: message.key, on: message.on });
      case 'openSettings':
        return this.openSettings(isSettingKey(message.setting) ? message.setting : undefined);
      case 'showLog':
        return this.showLog();
      case 'openLogFile':
        return this.openLogFile();
      case 'revealStop':
        return this.revealStopFolder();
      case 'openWalkthrough':
        return this.openWalkthrough();
      case 'lastRun':
        return this.showLastRun();
      case 'requestPreview':
        return this.sendPreview(message.key, message.path, surface);
      case 'openTranscript':
        return this.revealTranscript(message.path);
    }
  }

  // ----- plan ----------------------------------------------------------------------------------

  /**
   * Writes the plan's two inline settings to the user settings. Refused while watching: there the
   * change would silently end the watch the person had confirmed.
   */
  private async writePlan(change: PlanChange): Promise<boolean> {
    const state = this.options.session.current.state;
    if (state === null || state.armed !== false) {
      this.options.log.warn(`A change of the plan was ignored. ${copy.planLocked}`);
      return false;
    }
    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    try {
      if (change.action !== undefined) await configuration.update('action', change.action, vscode.ConfigurationTarget.Global);
      if (change.testMode !== undefined) await configuration.update('testMode', change.testMode, vscode.ConfigurationTarget.Global);
    } catch (error) {
      notify('error', copy.settingNotSaved(describe(error)));
      return false;
    }
    this.options.settingsMayHaveChanged();
    return true;
  }

  // ----- transcripts ---------------------------------------------------------------------------

  /** Reads only a file the current state lists as a transcript; anything else gets an empty answer. */
  private async sendPreview(key: string, requested: string | undefined, surface: DashboardSurface): Promise<void> {
    const file = previewTarget(this.options.session.current.state, key, requested);
    if (file === null) {
      surface.post({ type: 'preview', key, events: [], error: copy.noTranscript });
      return;
    }
    const events = await Promise.race<TranscriptEvent[] | null>([
      tailEvents(file, PREVIEW_EVENTS),
      delay(PREVIEW_TIMEOUT_MS).then(() => null),
    ]);
    surface.post({ type: 'preview', key, events: events ?? [], error: events === null ? copy.previewTimedOut : null });
  }

  /** Shows the file in the OS file manager. It is never opened in the editor: it can be hundreds of MB. */
  private async revealTranscript(file: string): Promise<void> {
    if (!isListedTranscript(this.options.session.current.state, file)) return;
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
  }

  // ----- helpers -------------------------------------------------------------------------------

  private async request(command: Command): Promise<void> {
    const result = await this.options.session.send(command);
    if (!result.ok) notify('warning', result.error ?? copy.requestFailed);
  }

  private osName(): string {
    const platform: unknown = this.options.session.current.state?.platform;
    const reported = isRecord(platform) ? platform.osName : null;
    return typeof reported === 'string' && reported !== '' ? reported : (OS_NAMES[process.platform] ?? process.platform);
  }

  /**
   * The leader's log file. Every window of a user has the same one; outside production a window
   * can be pointed elsewhere, and then the leader's file is the one that gets written. A path
   * that does not look like the log is not opened on a peer's say-so.
   */
  private logFile(): string {
    const reported = this.options.session.current.state?.logFile;
    const usable = typeof reported === 'string' && path.isAbsolute(reported) && path.basename(reported) === LOG_FILE_NAME;
    return usable ? reported : this.options.stateDir.logFile;
  }

  /** The folder the leader looks in for a STOP file (see logFile for why the leader's). */
  private stopFolder(): StateDir {
    const stop: unknown = this.options.session.current.state?.stop;
    const reported = isRecord(stop) ? stop.dir : null;
    const own = this.options.stateDir;
    return typeof reported === 'string' && path.isAbsolute(reported) && reported !== own.dir ? new StateDir(reported) : own;
  }
}
