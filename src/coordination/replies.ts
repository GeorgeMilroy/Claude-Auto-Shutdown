// Sentences a command can be refused with. They end up in front of the user (CommandResult.error),
// so they say what happened and what to do next.

export const CLOSING = 'This window is closing.';

export const NOT_CONNECTED = 'Not connected to the window in control yet. Try again in a moment.';

export const LEADER_LOST = 'The window in control closed before it answered. Check the dashboard and try again.';

export const NO_ANSWER =
  "The window in control didn't answer. Check the dashboard to see whether it went through before you rely on it.";

export const OTHER_VERSION =
  'This window and the window in control run different versions of Claude Auto Shutdown. ' +
  'Only Cancel and Stop watching work between them. Reload the windows to fix this.';

export const UNREADABLE_COMMAND =
  "The window in control couldn't read that request. Check the plan and try again, or reload this window.";

export const HANDLER_FAILED = 'The window in control hit an error handling that. Check the dashboard.';

export const REFUSED = 'The window in control refused.';

/** An unexpected error, for the log. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
