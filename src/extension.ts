// Entry point. Wires this window into the group of editor windows and puts the editor's surfaces
// (status bar, dashboard, commands, notifications) on top of whatever state the window may show.
//
// One window per machine is the leader; only there do the platform helper, the scanner and the
// controller exist (ui/windowSession.ts). Every window - leader or not - draws its surfaces from
// the state it is allowed to show (ui/windowUi.ts) and sends what the person asks for to the
// leader (ui/actions.ts). Nothing in the glue decides what happens to the PC.

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';

import { Coordinator } from './coordination/coordinator';
import { PROTOCOL_VERSION } from './shared/protocol';
import type { Command, CommandResult, Role, UiState, ViewContext, WindowHello } from './shared/protocol';
import { StateDir, resolveEndpoint, resolveStateDir } from './shared/stateDir';
import { Actions } from './ui/actions';
import { copy } from './ui/copy';
import { Dashboard } from './ui/dashboard';
import { detached } from './ui/detached';
import { DASHBOARD_VIEW_ID, DISPLAY_NAME, SETTINGS_SECTION } from './ui/ids';
import type { CommandId, InternalCommandId } from './ui/ids';
import { createLeaderRuntime } from './ui/leaderRuntime';
import { createLog } from './ui/log';
import type { Log } from './ui/log';
import { notify } from './ui/notifications';
import { realmOf, remoteLabel } from './ui/remote';
import { SettingsBridge } from './ui/settings';
import { WindowSession } from './ui/windowSession';
import { WindowUi } from './ui/windowUi';

/** Handed to the end-to-end suite, and only in ExtensionMode.Test. */
export interface TestApi {
  getRole(): Role;
  getState(): UiState | null;
  getView(): ViewContext;
  /** Start watching with this window's plan (a real plan still asks for confirmation). */
  start(): Promise<CommandResult>;
  send(command: Command): Promise<CommandResult>;
}

interface EditorWindow {
  session: WindowSession;
  actions: Actions;
  ui: WindowUi;
  log: Log;
  disposables: vscode.Disposable[];
}

type Handler = () => unknown;

const EMPTY_WINDOW = 'Empty window';
const TEST_HOME_VARIABLE = 'CLAUDE_AUTOSHUTDOWN_TEST_HOME';

let closeWindow: (() => Promise<void>) | null = null;

/** The authority of the remote this window is connected to (`wsl+Ubuntu`), if it has a folder there. */
function remoteAuthority(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'vscode-remote');
  return folder?.uri.authority;
}

function describeWindow(context: vscode.ExtensionContext): WindowHello {
  const authority = remoteAuthority();
  const remote = remoteLabel(vscode.env.remoteName, authority);
  const version: unknown = (context.extension.packageJSON as { version?: unknown }).version;
  return {
    windowId: randomUUID(),
    pid: process.pid,
    app: vscode.env.appName,
    ext: typeof version === 'string' ? version : 'unknown',
    realm: realmOf(context.globalStorageUri.fsPath),
    label: vscode.workspace.name ?? EMPTY_WINDOW,
    remote,
  };
}

/** A stand-in home folder for the scanner. Honoured only outside production, like the state dir override. */
function testHome(production: boolean): string | undefined {
  const value = production ? undefined : process.env[TEST_HOME_VARIABLE];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function buildWindow(context: vscode.ExtensionContext): EditorWindow {
  const production = context.extensionMode === vscode.ExtensionMode.Production;
  const channel = vscode.window.createOutputChannel(DISPLAY_NAME, { log: true });
  const log = createLog(channel);

  const stateDir = new StateDir(resolveStateDir({ production }));
  if (!stateDir.ensure()) log.warn(copy.stateDirUnusable(stateDir.dir));
  const self = describeWindow(context);
  const settings = new SettingsBridge(
    () => vscode.workspace.getConfiguration(SETTINGS_SECTION),
    (warning) => log.warn(`Settings: ${warning}`),
  );
  const coordinator = new Coordinator({
    endpoint: resolveEndpoint({ production, stateDir: stateDir.dir }),
    self,
    protocolVersion: PROTOCOL_VERSION,
    secret: stateDir.secret(),
    // Why a window can't coordinate (watching is off in it) is shown by default; the rest is chatter.
    log: (message, level) => {
      if (level === 'warn') log.warn(`windows: ${message}`);
      else log.debug(`windows: ${message}`);
    },
  });

  const session: WindowSession = new WindowSession({
    coordinator,
    stateDir,
    self,
    log: (message) => log.info(message),
    createLeader: (start) =>
      createLeaderRuntime(
        {
          extensionPath: context.extensionPath,
          stateDir,
          self,
          hostname: os.hostname(),
          getConfig: () => settings.current,
          getRemoteWindows: () =>
            [self.remote, ...coordinator.peers().map((peer) => peer.hello.remote)].filter((name): name is string => name !== null),
          hasViewers: () => session.viewVisible || coordinator.peers().some((peer) => peer.viewVisible),
          stillLeader: () => coordinator.stillOwnsEndpoint(),
          homeDir: testHome(production),
          log: (message) => log.debug(message),
        },
        start,
      ),
  });

  const dashboard: Dashboard = new Dashboard(context.extensionUri, () => ui.dashboardContent());
  const applySettings = (): void => {
    const change = settings.reload();
    if (!change.changed) return;
    session.settingsChanged({ contractChanged: change.contractChanged, digest: settings.digest });
    ui.render();
  };
  const actions = new Actions({
    extensionId: context.extension.id,
    session,
    settings,
    stateDir,
    self,
    dashboard,
    log,
    settingsMayHaveChanged: applySettings,
  });
  const ui: WindowUi = new WindowUi({
    session,
    settings,
    dashboard,
    log,
    windowLabel: self.label,
    stopDir: stateDir.dir,
    run: (command) => detached(vscode.commands.executeCommand(command)),
    cancelFromNotification: () => detached(actions.cancelCountdown('notification')),
  });

  dashboard.onMessage((message, surface) => actions.handleWebviewMessage(message, surface));
  dashboard.onVisibilityChanged(() => session.setViewVisible(dashboard.visible));
  session.onChange(() => ui.render());
  session.onAutoStop((outcome) => ui.announceAutoStop(outcome));

  const disposables = [
    channel,
    ui,
    dashboard,
    vscode.window.registerWebviewViewProvider(DASHBOARD_VIEW_ID, dashboard, Dashboard.registration),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SETTINGS_SECTION)) applySettings();
    }),
  ];
  return { session, actions, ui, log, disposables };
}

function registerCommands(actions: Actions, log: Log): vscode.Disposable[] {
  // Commands take no arguments: whatever a caller passes is dropped before the handler runs.
  const register = (id: string, handler: Handler): vscode.Disposable =>
    vscode.commands.registerCommand(id, async () => {
      try {
        await handler();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.error(`${id} failed: ${reason}`);
        notify('error', `${DISPLAY_NAME}: ${reason}`);
      }
    });

  const contributed: Record<CommandId, Handler> = {
    'claudeAutoShutdown.open': () => actions.openDashboard(),
    'claudeAutoShutdown.openInEditor': () => actions.openInEditor(),
    'claudeAutoShutdown.start': () => actions.pickAndStart(),
    'claudeAutoShutdown.stop': () => actions.stopWatching(),
    'claudeAutoShutdown.cancelCountdown': () => actions.cancelCountdown('command'),
    'claudeAutoShutdown.preview': () => actions.preview(),
    'claudeAutoShutdown.refresh': () => actions.refresh(),
    'claudeAutoShutdown.showLog': () => actions.showLog(),
    'claudeAutoShutdown.openLogFile': () => actions.openLogFile(),
    'claudeAutoShutdown.lastRun': () => actions.showLastRun(),
    'claudeAutoShutdown.revealStop': () => actions.revealStopFolder(),
    'claudeAutoShutdown.openSettings': () => actions.openSettings(),
    'claudeAutoShutdown.help': () => actions.openWalkthrough(),
  };
  // Not in the Command Palette: the Esc key binding and the status bar item during a countdown.
  const internal: Record<InternalCommandId, Handler> = {
    'claudeAutoShutdown.cancelCountdownWithEscape': () => actions.cancelCountdown('esc'),
    'claudeAutoShutdown.cancelCountdownFromStatusBar': () => actions.cancelCountdown('statusBar'),
  };
  return Object.entries({ ...contributed, ...internal }).map(([id, handler]) => register(id, handler));
}

function testApi(window: EditorWindow): TestApi {
  return {
    getRole: () => window.session.current.role,
    getState: () => window.session.current.state,
    getView: () => window.ui.dashboardContent().view,
    start: () => window.actions.start(),
    send: (command) => window.session.send(command),
  };
}

export function activate(context: vscode.ExtensionContext): { test: TestApi } | undefined {
  const window = buildWindow(context);
  context.subscriptions.push(...window.disposables, ...registerCommands(window.actions, window.log));
  window.ui.render();
  window.session.start();
  // deactivate() is awaited by the editor; the subscriptions above are disposed after it.
  closeWindow = () => window.session.dispose();
  return context.extensionMode === vscode.ExtensionMode.Test ? { test: testApi(window) } : undefined;
}

/**
 * The window is closing: say goodbye to the other windows (a sibling takes over watching), then
 * stop the controller - which writes its records synchronously - and release the helper.
 */
export async function deactivate(): Promise<void> {
  const close = closeWindow;
  closeWindow = null;
  await close?.();
}
