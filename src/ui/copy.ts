// Sentences only the extension host says (notifications, pickers, error messages). Everything a
// second surface also says lives in shared/text.ts. Same vocabulary: Watching / Not watching,
// Test run / For real, This PC, Emergency stop.

import type { PowerAction } from '../shared/config';
import { actionWords } from '../shared/text';

export const copy = {
  isolated: "Can't reach the other VS Code windows, so watching is off in this window.",
  notConnected: "The window in control isn't answering yet. Try again in a moment.",
  alreadyWatching: 'Already watching.',
  startInProgress: 'Watching is already being started.',
  planChangedMeanwhile: 'The settings changed while you were deciding. Check the plan and try again.',
  unreadableState: "The window in control sent something this window can't read. Reload this window and try again.",
  requestFailed: "That didn't go through. Check the dashboard and try again.",
  controllerNotReady: 'The controlling window is starting. Try again in a moment.',

  stopWatching: 'Stop watching',
  openDashboard: 'Open dashboard',
  startWatching: 'Start watching…',
  show: 'Show',
  showLog: 'Show log',
  stopFolder: 'Emergency stop folder',

  limited: (app: string | null, version: string | null): string => {
    const who = app === null ? 'another version of this extension' : version === null ? app : `${app} (${version})`;
    return `Controlled by ${who}. Only Cancel and Stop watching work from this window.`;
  },

  /** A real run that began by itself: said loudly, in every window. */
  watchingSinceStartup: (action: PowerAction): string =>
    `Watching for real since startup: this PC ${actionWords(action).future} when Claude finishes.`,

  autoStopSet:
    "Couldn't reach the window in control, so I set Emergency stop. Nothing will happen until you clear it.",
  autoStopAlreadySet:
    "Couldn't reach the window in control. Emergency stop was already set, so nothing will happen until you clear it.",
  autoStopFailed: (dir: string): string =>
    `Couldn't reach the window in control, and couldn't set Emergency stop either (${dir} can't be written). ` +
    'This PC may still act. Cancel in the on-screen warning, or quit VS Code.',
  autoStopCleared: 'The window in control answered, so the Emergency stop I set is removed again.',

  stateDirUnusable: (dir: string): string =>
    `The folder ${dir} can't be written to. Emergency stop and the activity log live there, so watching can't start.`,

  settingNotSaved: (reason: string): string => `Couldn't save the setting: ${reason}`,
  planLocked: 'Stop watching to change this.',

  noLastRun: 'Nothing has happened yet: no test run or action has finished on this PC.',
  recordedOn: (date: string): string => `Recorded on ${date}.`,
  noLogFile: (file: string): string => `There is no log file yet. It is created at ${file} with the first entry.`,

  noTranscript: 'No transcript found for this session.',
  previewTimedOut: "Couldn't read the transcript in time.",

  countdownLeft: (clock: string): string => `${clock} left`,
  finalCheck: 'Final check…',

  startPicker: {
    title: 'Start Watching',
    placeholder: 'What happens when every Claude Code session has finished?',
    test: 'Test run: PC stays on',
    testDetail: (action: PowerAction): string =>
      `Everything runs as normal, but instead of "${actionWords(action).menu}" you get a message. Nothing turns off.`,
    real: (action: PowerAction): string => `For real: ${actionWords(action).menu}…`,
    realDetail: (action: PowerAction): string =>
      `This PC ${actionWords(action).present} once every Claude session has finished. You confirm first.`,
    notify: 'Just notify me',
    notifyDetail: 'Only a message. Nothing ever turns off.',
    chooseAction: 'Choose what happens to this PC…',
    chooseActionDetail: 'Opens the setting. "Just notify me" is selected now, so there is nothing to test or to do for real.',
  },
};
