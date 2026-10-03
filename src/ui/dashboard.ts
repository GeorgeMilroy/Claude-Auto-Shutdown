// The dashboard webview: once as the side bar view, and the same app in an editor tab.
//
// The page is locked down: scripts only with this page's nonce, files only from dist/webview, no
// retained context while hidden. Everything it posts goes through DashboardSurface, which checks
// each message before anything acts on it.

import * as vscode from 'vscode';

import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { DashboardSurface } from './dashboardSurface';
import type { DashboardContent } from './dashboardSurface';
import { detached } from './detached';
import { DASHBOARD_PANEL_TYPE, DASHBOARD_VIEW_ID, DISPLAY_NAME } from './ids';
import { createNonce, dashboardHtml } from './webviewHtml';

const STYLE_FILES = ['codicon.css', 'main.css'];
const SCRIPT_FILE = 'main.js';

type MessageListener = (message: WebviewToHost, surface: DashboardSurface) => void;

export class Dashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly webviewRoot: vscode.Uri;
  private readonly content: () => DashboardContent;
  private readonly surfaces = new Set<DashboardSurface>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly visibilityListeners = new Set<() => void>();
  private view: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;

  /** `content` is asked for at every send, so a page never gets a state older than the newest. */
  constructor(extensionUri: vscode.Uri, content: () => DashboardContent) {
    this.webviewRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    this.content = content;
  }

  /** Options for registerWebviewViewProvider. */
  static readonly registration = { webviewOptions: { retainContextWhenHidden: false } };

  /** The dashboard is on screen in this window (side bar view or editor tab). */
  get visible(): boolean {
    return [...this.surfaces].some((surface) => surface.visible);
  }

  /** A checked message from a page. */
  onMessage(listener: MessageListener): void {
    this.messageListeners.add(listener);
  }

  onVisibilityChanged(listener: () => void): void {
    this.visibilityListeners.add(listener);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const surface = this.attach(view.webview, () => view.visible);
    view.onDidChangeVisibility(() => this.surfaceChanged(surface));
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
      this.detach(surface);
    });
    this.surfaceChanged(surface);
  }

  /** The same app in an editor tab; a second request brings the existing tab to the front. */
  openInEditor(): void {
    if (this.panel !== null) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(DASHBOARD_PANEL_TYPE, DISPLAY_NAME, vscode.ViewColumn.Active, {
      ...this.webviewOptions(),
      retainContextWhenHidden: false,
    });
    this.panel = panel;
    const surface = this.attach(panel.webview, () => panel.visible);
    panel.onDidChangeViewState(() => this.surfaceChanged(surface));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
      this.detach(surface);
    });
    this.surfaceChanged(surface);
  }

  /** Bring the side bar view on screen. With `preserveFocus` the keyboard focus stays where it is. */
  async reveal(preserveFocus: boolean): Promise<void> {
    if (this.view !== null) this.view.show(preserveFocus);
    else await vscode.commands.executeCommand(`${DASHBOARD_VIEW_ID}.focus`, { preserveFocus });
  }

  /** Send the current state to every page that can take it. */
  render(): void {
    for (const surface of this.surfaces) surface.sendState();
  }

  post(message: HostToWebview): void {
    for (const surface of this.surfaces) surface.post(message);
  }

  dispose(): void {
    this.panel?.dispose();
    this.surfaces.clear();
    this.messageListeners.clear();
    this.visibilityListeners.clear();
  }

  private webviewOptions(): vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [this.webviewRoot] };
  }

  private attach(webview: vscode.Webview, isVisible: () => boolean): DashboardSurface {
    webview.options = this.webviewOptions();
    const surface = new DashboardSurface(
      { post: (message) => detached(webview.postMessage(message)), isVisible },
      {
        content: this.content,
        message: (message, from) => {
          for (const listener of this.messageListeners) listener(message, from);
        },
      },
    );
    webview.onDidReceiveMessage((raw: unknown) => surface.receive(raw));
    this.surfaces.add(surface);
    webview.html = this.html(webview);
    return surface;
  }

  private detach(surface: DashboardSurface): void {
    this.surfaces.delete(surface);
    this.notifyVisibility();
  }

  private surfaceChanged(surface: DashboardSurface): void {
    surface.visibilityChanged();
    this.notifyVisibility();
  }

  private notifyVisibility(): void {
    for (const listener of this.visibilityListeners) listener();
  }

  private html(webview: vscode.Webview): string {
    const uri = (file: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.webviewRoot, file)).toString();
    return dashboardHtml({
      cspSource: webview.cspSource,
      scriptUri: uri(SCRIPT_FILE),
      styleUris: STYLE_FILES.map(uri),
      nonce: createNonce(),
    });
  }
}
