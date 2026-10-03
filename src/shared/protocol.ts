// Everything that crosses a boundary: leader window <-> other windows (local pipe / socket), and
// extension host <-> webview. Plain JSON only.
//
// One window is the LEADER: it owns the endpoint, runs the engine and the controller, and pushes
// `UiState` to every other window (followers). Followers render that state and send `Command`s.
// Messages that drive logic carry DURATIONS (ms), never wall-clock deadlines: wall clocks step.

import type { Check, RootStatus, Session, StrayProcess, TranscriptEvent } from '../core/types';
import type { Capability, HelperTier, PlatformId } from '../platform/types';
import type { ArmContract, PowerAction } from './config';

/** Bump when UiState / Command change incompatibly. The frozen core below never changes. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * off        - not watching; this PC stays on
 * watching   - watching, something is still unmet
 * confirming - everything is clear, re-checking k of n times ("double-checking")
 * countdown  - the cancellable warning before the action
 * committing - countdown elapsed: final fresh scan + last chance for a pending Cancel
 * executing  - the power command is being run
 */
export type Phase = 'off' | 'watching' | 'confirming' | 'countdown' | 'committing' | 'executing';

/** real = the action will run; test = test run; preview = the 20 s demo started from Help. */
export type CountdownKind = 'real' | 'test' | 'preview';

export interface CountdownState {
  /** Random id of this countdown. */
  id: string;
  kind: CountdownKind;
  action: PowerAction;
  totalMs: number;
  /**
   * Time left when this state was published, minus a 1 s guard band so no window ever shows more
   * time than really remains. Receivers anchor it to their own monotonic receipt time.
   */
  remainingMs: number;
}

export type CancelVia = 'esc' | 'button' | 'statusBar' | 'notification' | 'osAlert' | 'command';

export type CancelReason =
  | { id: 'user'; via: CancelVia }
  | { id: 'userCameBack' } // the idle gate saw input during the countdown
  | { id: 'sessionResumed'; name: string }
  | { id: 'checkFailed'; check: string } // a CheckId
  | { id: 'settingsChanged' }
  | { id: 'timeJump' } // this PC slept and woke up, or the clock changed
  | { id: 'leaderChanged' } // another window took over
  | { id: 'emergencyStop' }
  | { id: 'stoppedWatching' }
  | { id: 'scanStale' }; // the engine stopped answering

export type StopCause =
  | 'user'
  | 'settingsChanged'
  | 'timeJump'
  | 'windowClosed' // the controlling window closed and no other window could take over
  | 'lostControl' // the controlling window lost its leader connection while it was still open
  | 'editorRestarted' // found on next start: watching ended without a result
  | 'afterAction';

export type LastResult =
  | {
      kind: 'testPassed';
      atMs: number;
      action: PowerAction;
      armedAtMs: number | null;
      /** When the last session finished / everything first went clear, if known. */
      lastSessionFinishedAtMs: number | null;
      allClearAtMs: number | null;
      /** The session that held things up longest, if any. */
      heldUpBy: { name: string; seconds: number } | null;
    }
  | {
      kind: 'done';
      atMs: number;
      action: PowerAction;
      /** For sleep / hibernate: when this PC woke again, if observed. */
      resumedAtMs: number | null;
      /**
       * true = the OS showed it happened (lock screen, resume gap). false = the command was sent but
       * it was not confirmed: this PC was still on well after a shutdown, or the OS didn't confirm a
       * lock / sleep / hibernate. null = no confirmation exists for this action.
       */
      confirmed: boolean | null;
    }
  | { kind: 'failed'; atMs: number; action: PowerAction; message: string }
  | { kind: 'cancelled'; atMs: number; reason: CancelReason; stillWatching: boolean; countdownKind: CountdownKind }
  | { kind: 'stopped'; atMs: number; cause: StopCause; armedAtMs: number | null; wasReal: boolean };

export interface ActivityEntry {
  atMs: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface RemoteWindow {
  /** e.g. "WSL: Ubuntu", "SSH: build-box", "Dev Container" */
  name: string;
  /** `remote:<name>` */
  ignoreKey: string;
  ignored: boolean;
  /** Covered by a scanned foreign root (WSL), so it does not block. */
  covered: boolean;
}

export interface LeaderInfo {
  windowId: string;
  /** Workspace / folder name of the controlling window. */
  label: string;
  /** vscode.env.appName, e.g. "Visual Studio Code", "Cursor". */
  app: string;
  /** Extension version. */
  ext: string;
  pid: number;
  /** Identifies the editor whose settings the leader reads (hash of its user-settings location). */
  realm: string;
}

export interface UiState {
  v: number;
  /** Increases with every publish. */
  seq: number;
  /** Random id of this leader incarnation. */
  epoch: string;
  leader: LeaderInfo;
  hostname: string;

  phase: Phase;
  armed: boolean;
  armedAtMs: number | null;
  /** How watching started: a person, the watchOnStartup setting, or a window that closed. */
  armedBy: 'user' | 'startup' | 'handover' | null;
  /**
   * The rules in force: the frozen arm contract while watching, otherwise the leader's current
   * settings. Every surface renders THIS, never its own local settings.
   */
  contract: ArmContract;
  contractDigest: string;
  /** Realm whose settings `contract` came from. */
  contractRealm: string;

  confirm: { k: number; n: number; nextCheckInMs: number | null };
  countdown: CountdownState | null;
  /** After a cancel no new countdown starts for this long. */
  cooldownRemainingMs: number | null;

  checks: Check[];
  sessions: Session[];
  /**
   * Sessions left out of `sessions` so the state fits on the wire between windows (256 KB per
   * message). They still count in every check; only their rows are not shown. Normally 0.
   */
  sessionsOmitted: number;
  /**
   * Claude Code processes with no registry entry, copied from the last scan (each carries the
   * ignoreKey for "Don't wait for it"). null = the process list could not be read / no scan yet.
   */
  strays: StrayProcess[] | null;
  remoteWindows: RemoteWindow[];

  scan: {
    /** The engine only scans while watching or while a dashboard is visible somewhere. */
    engineActive: boolean;
    /** Age of the last completed scan when this state was published; null = none yet. */
    lastCompletedAgoMs: number | null;
    /** The last completed scan is too old to trust (> max(30 s, 3 x poll)). */
    stale: boolean;
    errors: string[];
    roots: RootStatus[];
  };

  platform: {
    id: PlatformId;
    osName: string;
    experimental: boolean;
    helperTier: HelperTier;
    /** Why the platform / helper is not fully available, else null. */
    problem: string | null;
    /** Result of the preflight for contract.action; null = not checked yet. */
    capability: Capability | null;
    /** Preflight per action, for the plan's action select. Missing = not checked yet. */
    capabilities: Partial<Record<PowerAction, Capability>>;
    keepAwake: 'held' | 'off' | 'unavailable';
  };

  stop: {
    /** Emergency stop is set. */
    present: boolean;
    /** Folder to create the STOP file in. */
    dir: string;
    /** It was created automatically because a Cancel could not reach the controlling window. */
    auto: boolean;
  };

  lastResult: LastResult | null;
  /** A test run has completed on this PC at least once. */
  testPassedOnce: boolean;
  /** Newest last, at most 40. */
  activity: ActivityEntry[];
  logFile: string;
}

// ---------------------------------------------------------------------------------------------
// Commands (any window -> leader)
// ---------------------------------------------------------------------------------------------

export type Command =
  /**
   * Start watching. Carries the exact contract the user saw (and, for real, confirmed in a modal
   * in THEIR window) plus the leader epoch it was issued against. Never retried automatically.
   */
  | { name: 'arm'; contract: ArmContract; digest: string; epoch: string; realm: string }
  /** Stop watching. Always accepted. */
  | { name: 'disarm' }
  /** Cancel a running countdown. Always accepted. */
  | { name: 'cancel'; via: CancelVia }
  /** Scan now. */
  | { name: 'refresh' }
  /** "Don't wait for this" (session / process / remote window), or undo it. */
  | { name: 'ignore'; key: string; on: boolean }
  /** Start the 20 s demo countdown. Only while not watching. */
  | { name: 'preview' }
  /** "Got it" on a result card. */
  | { name: 'dismissResult' }
  /** A window noticed its settings changed. From the contract's realm while watching = stop. */
  | { name: 'settingsChanged'; realm: string; digest: string };

export type CommandName = Command['name'];

export interface CommandResult {
  ok: boolean;
  /** Plain English, shown to the user when ok is false. */
  error?: string;
}

/** Commands that make things SAFER. They are retried against a new leader and never rejected. */
export const SAFE_COMMANDS: readonly CommandName[] = ['disarm', 'cancel'];

// ---------------------------------------------------------------------------------------------
// Wire format (newline-delimited JSON over the local endpoint, max 256 KB per line)
// ---------------------------------------------------------------------------------------------

export interface WindowHello {
  windowId: string;
  pid: number;
  app: string;
  ext: string;
  realm: string;
  label: string;
  /** vscode.env.remoteName rendered for humans, or null for a local window. */
  remote: string | null;
}

/** Armed state offered to a sibling window when the leader's window closes gracefully. */
export interface HandoverPayload {
  contract: ArmContract;
  contractRealm: string;
  armedAtMs: number;
  sawAnySession: boolean;
  /** ms since a session was last seen; null = never. */
  sinceLastSessionMs: number | null;
  /** ms left of the post-cancel cooldown. */
  cooldownRemainingMs: number;
  ignores: string[];
}

// On the wire the hello also carries {nonce, proof} and the welcome {proof}: HMAC proofs keyed with
// the per-user secret (ProvenHello / ProvenWelcome in coordination/auth.ts).
export type ClientMessage =
  | ({ t: 'hello'; v: number } & WindowHello)
  | { t: 'cmd'; id: string; cmd: Command }
  | { t: 'view'; visible: boolean }
  | { t: 'handoverAck'; ok: boolean };

export type ServerMessage =
  | { t: 'welcome'; v: number; epoch: string; leader: LeaderInfo; state: UiState }
  | { t: 'state'; state: UiState }
  | { t: 'ack'; id: string; ok: boolean; error?: string }
  | { t: 'handover'; payload: HandoverPayload }
  | { t: 'leaving'; successor: string | null };

// ---------------------------------------------------------------------------------------------
// Extension host <-> webview
// ---------------------------------------------------------------------------------------------

export type Role = 'electing' | 'leader' | 'follower' | 'isolated';

/** Facts about THIS window that the webview needs besides the shared state. */
export interface ViewContext {
  role: Role;
  /** The leader runs another protocol version: only Cancel and Stop watching work here. */
  limited: boolean;
  /**
   * THIS window's own settings as a contract. While not watching, the plan shows (and "start"
   * sends) this; while watching, every surface shows state.contract instead.
   */
  plan: ArmContract;
  windowLabel: string;
  /** Dirty editors in this window (shown in the real-mode confirmation). */
  unsavedFiles: number;
  /** A Cancel / Stop sent from here has not been acknowledged yet. */
  pending: 'cancel' | 'disarm' | null;
  /** We created the STOP file because the leader did not acknowledge within 2 s. */
  autoStopSet: boolean;
}

export type HostToWebview =
  /** state null = no trustworthy state (electing, lost contact, isolated). Never show a stale one. */
  | { type: 'state'; state: UiState | null; view: ViewContext }
  | { type: 'preview'; key: string; events: TranscriptEvent[]; error: string | null }
  | { type: 'focusPlan' };

export type WebviewToHost =
  | { type: 'ready' }
  /** Start watching with the plan currently shown. Real mode is confirmed by a native modal. */
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'refresh' }
  | { type: 'preview' }
  | { type: 'dismissResult' }
  | { type: 'setAction'; action: PowerAction }
  | { type: 'setTestMode'; testMode: boolean }
  | { type: 'ignore'; key: string; on: boolean }
  | { type: 'openSettings'; setting?: string }
  | { type: 'showLog' }
  | { type: 'openLogFile' }
  | { type: 'revealStop' }
  | { type: 'openWalkthrough' }
  | { type: 'lastRun' }
  /** Ask for the last events of a transcript (the session's own when `path` is omitted). */
  | { type: 'requestPreview'; key: string; path?: string }
  | { type: 'openTranscript'; path: string };

const WEBVIEW_TYPES = new Set<string>([
  'ready',
  'start',
  'stop',
  'cancel',
  'refresh',
  'preview',
  'dismissResult',
  'setAction',
  'setTestMode',
  'ignore',
  'openSettings',
  'showLog',
  'openLogFile',
  'revealStop',
  'openWalkthrough',
  'lastRun',
  'requestPreview',
  'openTranscript',
]);

/** Cheap shape check for messages coming out of the webview (untrusted). */
export function isWebviewMessage(value: unknown): value is WebviewToHost {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    WEBVIEW_TYPES.has((value as { type: string }).type)
  );
}
