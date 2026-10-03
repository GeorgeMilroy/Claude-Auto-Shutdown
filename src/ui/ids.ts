// Every id this extension registers with the editor. package.json contributes the same ids;
// test/glue/manifest.test.ts keeps the two in step.

export const SETTINGS_SECTION = 'claudeAutoShutdown';
export const DASHBOARD_VIEW_ID = 'claudeAutoShutdown.dashboard';
export const DASHBOARD_PANEL_TYPE = 'claudeAutoShutdown.dashboardPanel';
export const STATUS_BAR_ID = 'claudeAutoShutdown.status';
export const WALKTHROUGH_ID = 'getStarted';
export const DISPLAY_NAME = 'Claude Auto Shutdown';

/** Contributed commands. None of them takes arguments. */
export const COMMAND_IDS = [
  'claudeAutoShutdown.open',
  'claudeAutoShutdown.openInEditor',
  'claudeAutoShutdown.start',
  'claudeAutoShutdown.stop',
  'claudeAutoShutdown.cancelCountdown',
  'claudeAutoShutdown.preview',
  'claudeAutoShutdown.refresh',
  'claudeAutoShutdown.showLog',
  'claudeAutoShutdown.openLogFile',
  'claudeAutoShutdown.lastRun',
  'claudeAutoShutdown.revealStop',
  'claudeAutoShutdown.openSettings',
  'claudeAutoShutdown.help',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * Registered, but not contributed (so not in the Command Palette). Commands take no arguments, so
 * the Esc key and the status bar each get an id of their own: the activity log can then say HOW
 * a countdown was cancelled.
 */
export const INTERNAL_COMMAND_IDS = [
  'claudeAutoShutdown.cancelCountdownWithEscape',
  'claudeAutoShutdown.cancelCountdownFromStatusBar',
] as const;

export type InternalCommandId = (typeof INTERNAL_COMMAND_IDS)[number];

export const CONTEXT_KEYS = {
  watching: 'claudeAutoShutdown.watching',
  countdownActive: 'claudeAutoShutdown.countdownActive',
  realCountdown: 'claudeAutoShutdown.realCountdown',
  phase: 'claudeAutoShutdown.phase',
  previewDone: 'claudeAutoShutdown.previewDone',
  testPassed: 'claudeAutoShutdown.testPassed',
} as const;

export type ContextKey = (typeof CONTEXT_KEYS)[keyof typeof CONTEXT_KEYS];
