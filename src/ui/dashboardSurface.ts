// One place the dashboard is shown: the side bar view or the editor tab. It knows when its page
// is able to receive a state and checks everything the page sends. No vscode import, so this
// part of the webview boundary runs in unit tests.

import type { HostToWebview, UiState, ViewContext, WebviewToHost } from '../shared/protocol';
import { parseWebviewMessage } from './webviewMessages';

export interface SurfacePort {
  /** Deliver a message to the page. */
  post(message: HostToWebview): void;
  isVisible(): boolean;
}

export interface DashboardContent {
  state: UiState | null;
  view: ViewContext;
}

export interface SurfaceEvents {
  /** What the page should show now. Asked for at every send: a stored copy could be stale. */
  content(): DashboardContent;
  /** A checked message from the page. A 'ready' has already been answered with the state. */
  message(message: WebviewToHost, surface: DashboardSurface): void;
}

export class DashboardSurface {
  private readonly port: SurfacePort;
  private readonly events: SurfaceEvents;
  /** The page's script has asked for a state at least once. */
  private ready = false;

  constructor(port: SurfacePort, events: SurfaceEvents) {
    this.port = port;
    this.events = events;
  }

  get visible(): boolean {
    return this.port.isVisible();
  }

  /** Whatever the page posted. Untrusted. */
  receive(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (message === null) return;
    if (message.type === 'ready') {
      this.ready = true;
      this.sendState();
    }
    this.events.message(message, this);
  }

  /**
   * The page was hidden or shown. A hidden page is torn down (its context is not retained); when
   * it comes back it says 'ready' again. Should the editor have kept it alive after all, this
   * send brings it up to date at once.
   */
  visibilityChanged(): void {
    this.sendState();
  }

  sendState(): void {
    if (!this.ready || !this.visible) return;
    const { state, view } = this.events.content();
    this.port.post({ type: 'state', state, view });
  }

  /** Any other message for the page (a transcript preview, "focus the plan"). */
  post(message: HostToWebview): void {
    if (this.ready && this.visible) this.port.post(message);
  }
}
