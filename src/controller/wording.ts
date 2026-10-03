// Built-in English for the activity log and for the OS countdown alert when the glue does not
// inject its own wording. Deliberately tiny: user-facing sentences shared by several surfaces
// live in shared/text.ts, which the controller must not depend on.

import type { PowerAction } from '../shared/config';
import type { CancelReason, CancelVia, CountdownKind } from '../shared/protocol';

/** Reads naturally after "this PC will ..." / "this PC would ...". */
export const ACTION_VERB: Record<PowerAction, string> = {
  shutdown: 'shut down',
  hibernate: 'hibernate',
  sleep: 'go to sleep',
  lock: 'lock',
  notify: 'notify you',
};

const ALERT_TITLE: Record<PowerAction, string> = {
  shutdown: 'Shutting down this PC in',
  hibernate: 'Hibernating this PC in',
  sleep: 'Putting this PC to sleep in',
  lock: 'Locking this PC in',
  notify: 'Notifying you in',
};

const ALERT_BODY: Record<CountdownKind, string> = {
  real: 'Every Claude session has finished.',
  test: 'Test run: nothing will happen to this PC.',
  preview: 'Preview: nothing will happen to this PC.',
};

const VIA_TEXT: Record<CancelVia, string> = {
  esc: 'with Esc',
  button: 'with the Cancel button',
  statusBar: 'from the status bar',
  notification: 'from the notification',
  osAlert: 'in the countdown warning',
  command: 'with the Cancel command',
};

export function builtInAlertText(
  kind: CountdownKind,
  action: PowerAction,
): { title: string; body: string; cancelLabel: string } {
  return {
    title: ALERT_TITLE[action],
    body: ALERT_BODY[kind],
    cancelLabel: kind === 'real' ? 'Cancel: keep this PC on' : 'Cancel',
  };
}

export function cancelReasonText(reason: CancelReason): string {
  switch (reason.id) {
    case 'user':
      return `you cancelled it ${VIA_TEXT[reason.via]}`;
    case 'userCameBack':
      return "you came back (or it can't be told whether you're away)";
    case 'sessionResumed':
      return `"${reason.name}" went back to work`;
    case 'checkFailed':
      return `a check stopped passing (${reason.check})`;
    case 'settingsChanged':
      return 'the settings changed';
    case 'timeJump':
      return 'this PC slept or its clock changed';
    case 'leaderChanged':
      return 'the controlling window is closing or changed';
    case 'emergencyStop':
      return 'Emergency stop is set';
    case 'stoppedWatching':
      return 'watching was stopped';
    case 'scanStale':
      return 'the checks stopped answering';
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
