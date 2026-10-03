// The status bar item and the context keys: thin appliers of what presenter.ts worked out.

import * as vscode from 'vscode';

import { detached } from './detached';
import { DISPLAY_NAME, STATUS_BAR_ID } from './ids';
import type { ContextKeyValues, StatusBarModel } from './presenter';

const BACKGROUNDS: Record<StatusBarModel['background'], vscode.ThemeColor | undefined> = {
  none: undefined,
  warning: new vscode.ThemeColor('statusBarItem.warningBackground'),
  error: new vscode.ThemeColor('statusBarItem.errorBackground'),
};

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private tooltipSource: string | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Right, 100);
    this.item.name = DISPLAY_NAME;
  }

  render(model: StatusBarModel): void {
    this.item.text = model.text;
    this.item.backgroundColor = BACKGROUNDS[model.background];
    this.item.command = model.command ?? undefined;
    // Replacing the tooltip closes an open hover, so it is only replaced when its text changed.
    if (model.tooltip !== this.tooltipSource) {
      this.tooltipSource = model.tooltip;
      this.item.tooltip = trustedMarkdown(model.tooltip, model.tooltipCommands);
    }
    if (model.visible) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * Markdown whose links may run the listed commands and no others. The source was escaped by the
 * presenter; this is the second lock: a link that got through anyway could still only run one of
 * these commands, and none of them takes arguments.
 */
function trustedMarkdown(source: string, commands: readonly string[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(source);
  markdown.isTrusted = { enabledCommands: [...commands] };
  markdown.supportHtml = false;
  markdown.supportThemeIcons = false;
  return markdown;
}

/** Sets a context key only when its value changed (each set is a round trip to the main process). */
export class ContextKeys {
  private readonly current = new Map<string, boolean | string>();

  apply(values: ContextKeyValues): void {
    for (const [key, value] of Object.entries(values)) this.set(key, value);
  }

  set(key: string, value: boolean | string): void {
    if (this.current.get(key) === value) return;
    this.current.set(key, value);
    detached(vscode.commands.executeCommand('setContext', key, value));
  }
}
