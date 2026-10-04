// Dashboard-only wording: hero titles, section headings, button labels and the few layout
// sentences that no other surface needs. Every sentence that the status bar, the dialogs or the
// log also say comes from shared/text.ts - never from here.
//
// Titles are written in capitals here because shared/text.ts delivers its own titles that way;
// the stylesheet upper-cases nothing.

import { actionWords, fmtDuration, fmtSetting, fmtSpoken } from '../shared/text';
import type { PowerAction } from '../shared/config';
import type { CountdownKind } from '../shared/protocol';

export type Mode = 'real' | 'test' | 'notify';

const MODE_SUFFIX: Record<Mode, string> = { real: 'FOR REAL', test: 'TEST RUN', notify: 'MESSAGE ONLY' };

const COUNTDOWN_TITLES: Record<Exclude<CountdownKind, 'real'>, string> = { test: 'TEST RUN', preview: 'PREVIEW' };

/** Ends the text with a full stop unless it already ends a sentence. */
export function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const hero = {
  offTitle: 'NOT WATCHING',
  offLead: 'This PC stays on.',
  watchingTitle: (mode: Mode): string => `WATCHING · ${MODE_SUFFIX[mode]}`,
  confirmingTitle: (mode: Mode): string => `DOUBLE-CHECKING · ${MODE_SUFFIX[mode]}`,
  startedWithEditor: 'Watching started with VS Code (the "Watch on startup" setting).',
  tookOver: 'Took over watching from a window that closed.',
  cancelNotice: (duration: string): string => `You get ${duration} to cancel first.`,

  countdownTitle: COUNTDOWN_TITLES,
  committingTitle: (kind: CountdownKind): string =>
    kind === 'real' ? 'FINAL CHECK…' : `${COUNTDOWN_TITLES[kind]} · FINAL CHECK…`,
  committingLead: 'Making sure nothing changed.',
  mouseCancels: 'Esc cancels while VS Code is focused. So does moving the mouse or typing.',
  mouseDoesNotCancel: 'Moving the mouse will NOT cancel. Press Esc or the button.',
  escapeHint: 'Press Escape to cancel.',
  timeLeft: (seconds: number): string => `${fmtSpoken(seconds)} left`,

  executingTitle(action: PowerAction, mode: Mode): string {
    if (mode === 'test') return 'TEST RUN FINISHING…';
    const gerund = actionWords(action).gerund;
    return `${(gerund === '' ? 'Notifying you' : gerund).toUpperCase()} NOW…`;
  },

  degradedTitle: "CAN'T TELL · PC STAYS ON",
  degradedLead: "Can't tell if Claude is done, so this PC stays on.",
  lastGoodCheck: (seconds: number | null): string =>
    seconds === null ? 'No check has completed yet.' : `Last check ${fmtDuration(seconds)} ago.`,
  distrustList: "Don't trust the list below.",

  connectingTitle: 'CONNECTING…',
  connectingLead: 'Finding out whether this PC is being watched.',
  lostContactTitle: "LOST CONTACT · CAN'T TELL",
  isolatedTitle: "CAN'T COORDINATE",
  cantRunTitle: "CAN'T RUN HERE",

  confirmProgress: (k: number, n: number): string => `Check ${k} of ${n}`,
  confirmSpoken: (k: number, n: number): string => `Check ${k} of ${n} passed`,
  nextCheck: (seconds: number): string => `next ~${Math.max(1, Math.ceil(seconds))} s`,
};

export const buttons = {
  stopWatching: 'Stop watching',
  stopping: 'Stopping…',
  cancelling: 'Cancelling…',
  checkAgain: 'Check again',
  showLog: 'Show log',
  openLogFile: 'Open log file',
  showDetails: 'Show details',
  gotIt: 'Got it',
  keepOn: 'Keep this PC on',
  startAgain: 'Start again…',
  setUpAgain: 'Set up again…',
  switchToReal: 'Switch to "For real"',
  settings: 'Settings',
  stopFolder: 'Emergency stop folder',
  undo: 'Undo',
};

export const banners = {
  limited: (app: string | null, version: string | null): string => {
    const who = app === null ? 'another version of this extension' : version === null ? app : `${app} (${version})`;
    return `Controlled by ${who}. Only Cancel and Stop watching work from this window.`;
  },
  autoStop:
    "Couldn't reach the window in control, so I set Emergency stop. Nothing will happen until you clear it.",
  experimental: (osName: string): string =>
    `${osName === '' ? 'This' : osName} support is experimental and untested on real hardware. Use test runs.`,
};

export const plan = {
  heading: 'WHEN CLAUDE FINISHES',
  lockedHeading: 'THE PLAN',
  actionLabel: 'What happens to this PC',
  modeLabel: 'Test run or for real',
  testRadio: 'Test run: PC stays on, you get a message',
  realRadio: (action: PowerAction): string => `For real: this PC ${actionWords(action).present}`,
  notifyNote: 'Only a message. Nothing ever turns off, so no test is needed.',
  changeRules: 'Change rules',
  locked: 'Stop watching to change this.',
  lockedSummary: (action: PowerAction, mode: Mode): string => {
    const menu = actionWords(action).menu;
    return mode === 'notify' ? menu : `${menu} · ${mode === 'test' ? 'Test run' : 'For real'}`;
  },
  testTakesLong: 'A test run takes as long as the real thing.',
  confirmFirst: "You'll be asked to confirm first.",
  preview: 'Preview the countdown (20 s)',
  ready: 'Ready in a moment',
  unavailable: (action: PowerAction): string =>
    `${actionWords(action).menu} isn't available on this PC. Pick another action.`,
  pickAnother: 'Pick another action.',
  optionUnavailable: (label: string): string => `${label} (not available)`,
};

export const lanes = {
  waitingHeading(count: number): string {
    if (count === 0) return 'ALL CLEAR';
    return `WAITING FOR ${count} ${count === 1 ? 'THING' : 'THINGS'}`;
  },
  ifStartedHeading: 'IF YOU STARTED NOW',
  nothingInTheWay: 'Nothing in the way right now.',
  checksOk: (count: number): string => `${plural(count, 'check')} OK`,
  earliest: (time: string): string => `Earliest: ${time} (not before)`,
  laneSettings: (title: string): string => `Open the settings for ${title}`,
  stray: (pid: number | null, name: string | null): string => {
    const which = [pid === null ? null : `PID ${pid}`, name].filter((part) => part !== null).join(', ');
    return `A Claude process${which === '' ? '' : ` (${which})`} can't be matched to a session`;
  },
  strayName: (pid: number | null, name: string | null): string =>
    `${name ?? 'Claude process'}${pid === null ? '' : ` (PID ${pid})`}`,
  /** A busy command a stray Claude process started, under that process's row. */
  strayChild: (name: string, pid: number | null): string => `${name}${pid === null ? '' : ` (PID ${pid})`} is still running`,
  /** The same, when the stray itself has no row: it says who started the command. */
  strayChildOf: (name: string, pid: number | null, stray: string): string =>
    `${name}${pid === null ? '' : ` (PID ${pid})`}, started by ${stray}, is still running`,
  unnamedCommand: 'A command',
  dontWaitForIt: "Don't wait for it",
  dontWaitForRemotes: "Don't wait for remote windows",
  staysOn: 'So this PC stays on.',
  notWaitedFor: 'Not waited for',
};

export const sessions = {
  heading: (count: number, omitted: number): string =>
    omitted > 0 ? `SESSIONS · ${count} (+${omitted} not shown)` : `SESSIONS · ${count}`,
  omitted: (count: number): string =>
    `${count === 1 ? '1 more session is' : `${count} more sessions are`} counted but not listed ` +
    '(too many to send between windows).',
  staleHeading: (seconds: number | null): string =>
    seconds === null ? 'SESSIONS · not checked yet' : `SESSIONS · last seen ${fmtDuration(seconds)} ago`,
  looking: 'Looking for Claude Code sessions…',
  none: (roots: readonly string[]): string =>
    `No Claude Code sessions found on this PC${roots.length === 0 ? '' : ` (looked in ${roots.join(', ')})`}.`,
  unseen: "Sessions inside WSL, SSH or a container can't be seen from here.",
  canStartNow: 'You can start now: I wait for one to appear and finish.',
  finishedGroup: (count: number): string => `${count} finished`,
  notInList: 'not in the session list',
  unverified: "Couldn't confirm this session's process; treating it as running.",
  entrypoint(raw: string): string {
    if (raw === 'cli') return 'CLI';
    if (raw === 'claude-desktop') return 'Desktop app';
    if (raw === 'claude-vscode') return 'VS Code';
    return raw;
  },
  pid: (pid: number): string => `PID ${pid}`,
  turn: (turn: string): string => `turn ${turn}`,
  claudeStatus: (status: string, overruled: boolean): string =>
    `Claude Code: ${status}${overruled ? ', judged by the transcript' : ''}`,
  subagentsHeading: (count: number): string => `Subagents (${count})`,
  subagentWrote: (seconds: number | null): string =>
    seconds === null ? 'write time unknown' : `wrote ${fmtDuration(seconds)} ago`,
  subagentActive: 'active',
  childRunning: (name: string, pid: number | null): string =>
    `${name}${pid === null ? '' : ` (PID ${pid})`} is still running`,
  childIgnored: (name: string, pid: number | null): string => `${name}${pid === null ? '' : ` (PID ${pid})`}`,
  unnamedCommand: 'A command',
  unnamedSession: 'Unnamed session',
  dontWait: "Don't wait for this session",
  openTranscript: 'Open transcript',
  previewLoading: 'Reading the transcript…',
  previewEmpty: 'No conversation in the transcript yet.',
  previewCount: (count: number): string => `(last ${plural(count, 'event')})`,
  speaker: { claude: 'Claude', you: 'You', system: 'System', other: 'Other' },
  quietSpoken: (seconds: number, target: number): string => `Quiet ${fmtSpoken(seconds)} of ${fmtSpoken(target)}`,
};

export const footer = {
  log: 'Log',
  settings: 'Settings',
  help: 'Help',
  getStarted: 'Get started',
  preview: 'Preview the countdown',
  lastRun: 'What happened last time?',
  emergencyStop: 'Emergency stop: how it works',
};

export const regions = {
  status: 'Status',
  plan: 'Plan',
  waitingFor: 'Waiting for',
  sessions: 'Sessions',
  notices: 'Notices',
};

export const crash = {
  title: "THE DASHBOARD CAN'T SHOW THIS",
  lead: 'Something in the state could not be displayed, so treat this PC as not watched.',
  hint: 'These buttons still work.',
  cancel: 'Cancel: keep this PC on',
};

/** "90 s", "5 min": a configured duration, or a phrase that claims nothing when it is unreadable. */
export function settingText(seconds: unknown): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? fmtSetting(seconds) : null;
}
