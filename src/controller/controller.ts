// The state machine that runs in the LEADER window only:
//   off -> watching -> confirming (k of n) -> countdown -> committing -> executing -> off
// It owns the arm contract, the poll loop, the countdown, the final gate and the power action.
// It has no vscode import: everything it needs comes in through ControllerDeps, so the whole
// decision path runs in unit tests with a fake clock, a fake platform and a fake scanner.
//
// Rule underneath everything: not knowing is never permission to act. The only call to
// platform.execute() sits behind gate(); every other path ends with this PC still on.

import { randomBytes } from 'node:crypto';

import type { EvaluateInput } from '../core/evaluate';
import type { ScanRequest } from '../core/scanner';
import type { ScanResult, Verdict } from '../core/types';
import type { ActionResult, Capability, CountdownAlert, Platform } from '../platform/types';
import { POWER_ACTIONS, contractDigest, parseArmContract, toArmContract } from '../shared/config';
import type { ArmContract, Config, PowerAction } from '../shared/config';
import { PROTOCOL_VERSION } from '../shared/protocol';
import type {
  ActivityEntry,
  CancelReason,
  CancelVia,
  Command,
  CommandResult,
  CountdownKind,
  CountdownState,
  HandoverPayload,
  LastResult,
  LeaderInfo,
  Phase,
  RemoteWindow,
  UiState,
  WindowHello,
} from '../shared/protocol';
import type { StateDir, StopStatus } from '../shared/stateDir';
import { ActivityLog } from './activityLog';
import { CapabilityCache } from './capabilities';
import { IgnoreList, MAX_IGNORES, describeIgnoreKey, isIgnoreKey, remoteIgnoreKey } from './ignores';
import { COOLDOWN_MS, parseCommand, parseHandover } from './inputs';
import { KeepAwakeHold } from './keepAwake';
import { PollLoop } from './pollLoop';
import { LastRunStore, loadWatchRecord, removeWatchRecord, saveWatchRecord } from './records';
import type { WatchRecord } from './records';
import { environmentProblemOf, helperStatusOf, remoteWindowNames, saysYes } from './surroundings';
import { Ticker } from './timeGuard';
import { cancelReasonFor, failedVerdict, withoutNewPoll } from './verdict';
import { WatchJournal } from './watchJournal';
import { ACTION_VERB, builtInAlertText, cancelReasonText, errorText } from './wording';

export interface Disposable {
  dispose(): void;
}

/** Injected time source. Production uses Date.now / performance.now / setTimeout. */
export interface Clock {
  /** Wall clock, epoch ms. */
  now(): number;
  /** Monotonic ms. */
  mono(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ControllerDeps {
  platform: Platform;
  scanner: { scan(request: ScanRequest): Promise<ScanResult> };
  evaluate: (input: EvaluateInput) => Verdict;
  stateDir: StateDir;
  clock: Clock;
  /** This leader's current, already validated settings. */
  getConfig(): Config;
  leader: LeaderInfo;
  hostname: string;
  /** Human names of connected remote windows (this window included), e.g. ["WSL: Ubuntu"]. */
  getRemoteWindows(): string[];
  /** A dashboard is visible in some window (the engine only scans while watching or viewed). */
  hasViewers(): boolean;
  /** This process still holds the leadership endpoint. Checked in the final gate. */
  stillLeader(): boolean;
  /**
   * Plain-English summary of the unmet checks for the activity log ("why is this PC still on").
   * Optional: defaults to listing check ids.
   */
  describeBlockers?(verdict: Verdict, scan: ScanResult | null): string;
  /** Words for the OS-level countdown alert. Optional: defaults to built-in English. */
  alertText?(state: UiState): { title: string; body: string; cancelLabel: string };
}

export interface ControllerStartOptions {
  /** Armed state accepted from a sibling window that just closed; null = start not watching. */
  handover: HandoverPayload | null;
  /** The previous leader vanished while watching: record and show it. */
  previousLeaderWasWatching: boolean;
  /**
   * This window became leader during its own start-up with no other window open, so the
   * watchOnStartup setting applies.
   */
  freshStart: boolean;
}

const COUNTDOWN_TICK_MS = 250;
const WATCH_TICK_MS = 1000;
const COUNTDOWN_POLL_MS = 2000;
const COUNTDOWN_PUBLISH_MS = 500;
/** Lets a Cancel that is already in the socket buffer be processed before the final gate. */
const COMMIT_BARRIER_MS = 250;
const WATCHDOG_MS = 5000;
/** Followers judge the leader by silence: while the engine runs, never be quiet for 10 s. */
const HEARTBEAT_MS = 10_000;
const STALE_FLOOR_MS = 30_000;
/** No window may ever show more time than really remains. */
const GUARD_BAND_MS = 1000;
const IDLE_SAMPLE_MS = 1000;
const IDLE_TOLERANCE_MS = 1500;
const PREVIEW_MS = 20_000;
const SHUTDOWN_CONFIRM_MS = 120_000;
const RESUME_GAP_MS = 30_000;
/** A "watching ended" record this fresh was written by the window that just closed. */
const JUST_RECORDED_MS = 60_000;
const FALLBACK_POLL_MS = 10_000;
/** Timer jitter allowed when deciding whether two scans were a whole poll interval apart. */
const POLL_SPACING_SLACK_MS = 500;

const OK: CommandResult = { ok: true };
const NOT_TAKING_COMMANDS = 'The controlling window is starting or closing. Try again in a moment.';
const SETTINGS_CHANGED = 'Settings changed. Check the plan and try again.';

type ArmCommand = Extract<Command, { name: 'arm' }>;
type ArmedBy = NonNullable<UiState['armedBy']>;
type DoneResult = Extract<LastResult, { kind: 'done' }>;

interface Countdown {
  id: string;
  kind: CountdownKind;
  action: PowerAction;
  totalMs: number;
  startedMono: number;
  deadlineMono: number;
}

/**
 * The final gate, opened for one specific run. Every kind of cancel drops the ticket, so a gate
 * that finishes its checks afterwards finds nothing to act on.
 */
interface CommitTicket {
  /** The countdown that elapsed; null for `notify`, which has none. */
  countdownId: string | null;
  kind: 'real' | 'test';
  action: PowerAction;
  cancelCounter: number;
  startedMono: number;
}

interface PollOutcome {
  scan: ScanResult | null;
  verdict: Verdict;
  /** Generation and monotonic time at which the scan STARTED. */
  generation: number;
  startedMono: number;
}

function refuse(error: string): CommandResult {
  return { ok: false, error };
}

function randomId(): string {
  return randomBytes(8).toString('hex');
}

function windowLabel(from: WindowHello | null | undefined): string {
  const label = typeof from?.label === 'string' ? from.label.trim() : '';
  if (label === '') return 'another window';
  return `"${label.length > 80 ? `${label.slice(0, 79)}…` : label}"`;
}

export class Controller {
  private readonly deps: ControllerDeps;
  private readonly clock: Clock;
  private readonly activity: ActivityLog;
  private readonly results: LastRunStore;
  private readonly capabilities: CapabilityCache;
  private readonly ignores = new IgnoreList();
  private readonly journal: WatchJournal;
  private readonly keepAwake: KeepAwakeHold;
  private readonly loop: PollLoop;
  private readonly ticker: Ticker;
  /** Random id of this leader incarnation; an `arm` issued against another one is refused. */
  private readonly epoch = randomId();
  private readonly listeners = new Set<(state: UiState) => void>();
  private seq = 0;
  private lastPublishMono = 0;

  private started = false;
  private disposed = false;
  private handingOver = false;
  private arming = false;

  private phase: Phase = 'off';
  private armed = false;
  /** Frozen at arm time; the only rules in force until watching stops. */
  private contract: ArmContract | null = null;
  private contractRealm: string | null = null;
  /** The frozen rules of the action that is running right now (phase `executing`). */
  private inProgress: { contract: ArmContract; realm: string } | null = null;
  /** Newest digest each realm reported while an arm was waiting for the OS. */
  private readonly digestsWhileArming = new Map<string, string>();
  private armedAtMs: number | null = null;
  private armedBy: UiState['armedBy'] = null;
  private stablePolls = 0;
  /** Monotonic start of the last scan that counted as a poll. */
  private lastCountedPollMono: number | null = null;
  private allClearSinceMs: number | null = null;
  private sawAnySession = false;
  private lastSessionSeenMono: number | null = null;
  private cooldownEndMono: number | null = null;
  private countdown: Countdown | null = null;
  private commit: CommitTicket | null = null;
  private cancelCounter = 0;
  /** Bumped whenever the rules or the run change; a scan started before the bump cannot count. */
  private generation = 0;

  private scan: ScanResult | null = null;
  private verdict: Verdict | null = null;
  private lastScanCompletedMono: number | null = null;
  private engineActiveSinceMono: number | null = null;
  private engineRanBefore = false;
  private staleReported = false;
  /** Unknown until read: an unread brake counts as set. */
  private stop: StopStatus = { present: true, auto: false, file: null };
  private fillingCapabilities = false;
  private alert: CountdownAlert | null = null;

  private watchdogTimer: unknown = null;
  private barrierTimer: unknown = null;
  private shutdownCheckTimer: unknown = null;
  /** The countdown an idle-time question is still out for, if any. */
  private idleSampleFor: Countdown | null = null;
  private lastIdleSampleMono: number | null = null;
  private lastScanFailure = '';

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.clock = deps.clock;
    this.activity = new ActivityLog(deps.stateDir.logFile, () => deps.clock.now());
    this.results = new LastRunStore(deps.stateDir);
    this.capabilities = new CapabilityCache(deps.platform, () => deps.clock.mono());
    this.journal = new WatchJournal({
      note: (level, text) => this.note(level, text),
      describeBlockers: (verdict, scan) => deps.describeBlockers?.(verdict, scan) ?? '',
    });
    this.keepAwake = new KeepAwakeHold(deps.platform, (held) => this.keepAwakeSettled(held));
    this.loop = new PollLoop({
      timers: deps.clock,
      isActive: () => this.engineActive(),
      intervalMs: () => this.pollIntervalMs(),
      generation: () => this.generation,
      scan: () => this.poll(false),
      onError: (error) => this.note('error', `A check failed unexpectedly: ${errorText(error)}`),
    });
    this.ticker = new Ticker({
      clock: deps.clock,
      intervalMs: () => this.tickIntervalMs(),
      onTick: (mono) => this.onTick(mono),
      onJump: () => this.onTimeJump(),
      onError: (error) => this.note('error', `The countdown timer failed: ${errorText(error)}`),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  start(options: ControllerStartOptions): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.refreshStop();

    const leftover = loadWatchRecord(this.deps.stateDir);
    const handover = options.handover === null ? null : parseHandover(options.handover);
    const stored = this.results.restore(this.clock.now(), handover !== null);
    if (handover !== null) this.adoptHandover(handover);
    else this.startNotWatching(options, leftover, stored);

    this.syncTimers();
    this.reevaluate();
    this.publish();
  }

  /** Current state, with countdown.remainingMs / ages computed for "now". */
  getState(): UiState {
    return this.buildState();
  }

  /** Fires on every change, every scan, and every 500 ms during a countdown. */
  onState(listener: (state: UiState) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  handleCommand(command: Command, from: WindowHello): Promise<CommandResult> {
    return this.dispatch(command, from).catch((error: unknown) => {
      this.note('error', `A request could not be handled: ${errorText(error)}`);
      return refuse('Something went wrong while handling that. The activity log has the details.');
    });
  }

  /** This leader's own settings changed (already filtered to this extension's keys). */
  configChanged(): void {
    if (!this.started || this.disposed || this.handingOver) return;
    this.settingsChanged(this.deps.leader.realm, this.leaderDigest());
  }

  /** Viewers or remote windows changed: re-decide whether the engine runs, and re-evaluate. */
  peersChanged(): void {
    if (!this.started || this.disposed) return;
    this.pruneRemoteIgnores();
    this.syncTimers();
    this.reevaluate();
    this.publish();
  }

  /**
   * The window is closing gracefully. Cancels any countdown, stops taking commands, and returns
   * the armed state to offer to a sibling (null when not watching).
   */
  beginHandover(): HandoverPayload | null {
    if (this.disposed) return null;
    this.handingOver = true;
    if (this.countdown?.kind === 'preview') this.endPreview('Preview stopped: this window is closing.');
    else this.cancelAutomatically({ id: 'leaderChanged' });
    this.syncTimers();
    this.publish();
    if (!this.armed || this.contract === null) return null;

    const mono = this.clock.mono();
    return {
      contract: this.contract,
      contractRealm: this.contractRealm ?? this.deps.leader.realm,
      armedAtMs: this.armedAtMs ?? this.clock.now(),
      sawAnySession: this.sawAnySession,
      sinceLastSessionMs:
        this.lastSessionSeenMono === null ? null : Math.max(0, Math.floor(mono - this.lastSessionSeenMono)),
      cooldownRemainingMs: this.cooldownRemainingMs(mono) ?? 0,
      ignores: this.ignores.keys(),
    };
  }

  /**
   * Synchronous teardown. `handedOver` = a sibling took the armed state; otherwise, if watching,
   * a "watching stopped" record is written for the next start: the window closed, or with
   * cause 'lostControl' it is still open but lost its leader connection.
   */
  dispose(options: { handedOver: boolean; cause?: 'lostControl' }): void {
    if (this.disposed) return;
    if (this.armed && !options.handedOver) {
      const lostControl = options.cause === 'lostControl';
      this.note(
        'warn',
        lostControl
          ? 'This window lost control of watching (its leader connection ended), so watching stopped. Nothing was done to this PC.'
          : 'The controlling window closed while watching. Watching stopped; nothing was done to this PC.',
      );
      this.results.record({
        kind: 'stopped',
        atMs: this.clock.now(),
        cause: lostControl ? 'lostControl' : 'windowClosed',
        armedAtMs: this.armedAtMs,
        wasReal: this.isReal(),
      });
      // With a handover the successor has already written its own watching.json: leave it alone.
      removeWatchRecord(this.deps.stateDir);
    }
    this.disposed = true;
    this.loop.dispose();
    this.ticker.dispose();
    for (const timer of [this.watchdogTimer, this.barrierTimer, this.shutdownCheckTimer]) {
      if (timer !== null) this.clock.clearTimeout(timer);
    }
    this.watchdogTimer = this.barrierTimer = this.shutdownCheckTimer = null;
    this.stopAlert();
    this.keepAwake.want(false);
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------------------------

  private startNotWatching(options: ControllerStartOptions, leftover: WatchRecord | null, stored: LastResult | null): void {
    const handoverRejected = options.handover !== null;
    if (handoverRejected) {
      this.note('warn', "Couldn't take over watching from the window that closed: what it handed over wasn't valid.");
    }
    // A window was watching and its watching ended without anybody saying so: say it now.
    const windowVanished = options.previousLeaderWasWatching || handoverRejected;
    const unexplained = windowVanished && !this.watchEndJustRecorded(stored);
    if (leftover !== null || unexplained) {
      this.recordInterruptedWatch(leftover, windowVanished ? 'windowClosed' : 'editorRestarted');
    }
    if (options.freshStart && !handoverRejected && this.config().watchOnStartup) {
      this.detach('starting to watch at startup', this.armOnStartup());
    }
  }

  /** The window that closed a moment ago already recorded how its watching ended. */
  private watchEndJustRecorded(stored: LastResult | null): boolean {
    if (stored === null || (stored.kind === 'cancelled' && stored.stillWatching)) return false;
    return Math.abs(this.clock.now() - stored.atMs) < JUST_RECORDED_MS;
  }

  private recordInterruptedWatch(leftover: WatchRecord | null, cause: 'windowClosed' | 'editorRestarted'): void {
    this.note(
      'warn',
      cause === 'windowClosed'
        ? 'The window that was watching closed and no other window could take over. Watching stopped; nothing was done to this PC.'
        : 'The editor closed or restarted while watching. Watching stopped; nothing was done to this PC.',
    );
    this.results.record({
      kind: 'stopped',
      atMs: this.clock.now(),
      cause,
      armedAtMs: leftover?.armedAtMs ?? null,
      wasReal: leftover?.real === true,
    });
    removeWatchRecord(this.deps.stateDir);
  }

  private adoptHandover(handover: HandoverPayload): void {
    const mono = this.clock.mono();
    this.beginWatching(handover.contract, handover.contractRealm, 'handover', handover.armedAtMs);
    this.sawAnySession = handover.sawAnySession;
    this.lastSessionSeenMono = handover.sinceLastSessionMs === null ? null : mono - handover.sinceLastSessionMs;
    this.cooldownEndMono = handover.cooldownRemainingMs > 0 ? mono + handover.cooldownRemainingMs : null;
    this.ignores.adopt(handover.ignores, mono);
    this.note('info', 'Took over watching from a window that closed.');
  }

  private async armOnStartup(): Promise<void> {
    const contract = toArmContract(this.config());
    const command: ArmCommand = {
      name: 'arm',
      contract,
      digest: contractDigest(contract),
      epoch: this.epoch,
      realm: this.deps.leader.realm,
    };
    const result = await this.arm(command, 'startup', 'the "watch on startup" setting');
    if (result.ok || this.disposed) return;
    this.note('warn', `Couldn't start watching at startup: ${result.error ?? 'unknown reason'}`);
    this.publish();
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  private async dispatch(raw: unknown, from: WindowHello): Promise<CommandResult> {
    // Also true for 'disarm' / 'cancel': once the armed state is on offer to a sibling, saying
    // "ok" here would be a lie. A refusal keeps the request pending for the next leader.
    if (!this.started || this.disposed || this.handingOver) return refuse(NOT_TAKING_COMMANDS);
    const command = parseCommand(raw);
    if (command === null) return refuse("The controlling window didn't understand that request.");

    switch (command.name) {
      case 'arm':
        return this.arm(command, 'user', `window ${windowLabel(from)}`);
      case 'disarm':
        this.disarm(windowLabel(from));
        return OK;
      case 'cancel':
        this.cancel(command.via);
        return OK;
      case 'refresh':
        this.loop.scanNow();
        return OK;
      case 'ignore':
        return this.setIgnore(command.key, command.on);
      case 'preview':
        return this.startPreview();
      case 'dismissResult':
        this.results.dismiss();
        this.publish();
        return OK;
      case 'settingsChanged':
        this.settingsChanged(command.realm, command.digest);
        return OK;
    }
  }

  private async arm(command: ArmCommand, by: ArmedBy, startedBy: string): Promise<CommandResult> {
    const wanted = this.checkArm(command);
    if (typeof wanted === 'string') return refuse(wanted);

    if (wanted.action !== 'notify') {
      const problem = await this.askBeforeArming(wanted.action, command);
      if (problem !== null) {
        this.publish();
        return refuse(problem);
      }
    }

    // Asking the OS took a moment. A STOP file, another Start or a closing window may have arrived.
    const contract = this.checkArm(command);
    if (typeof contract === 'string') return refuse(contract);

    this.beginWatching(contract, command.realm, by, this.clock.now());
    // A result from last night stays on screen when the editor arms by itself in the morning.
    if (by === 'user') this.results.dismiss();
    const outcome = `this PC ${contract.testMode ? 'would' : 'will'} ${ACTION_VERB[contract.action]} once every Claude session has finished`;
    this.note(
      'info',
      contract.testMode
        ? `Started watching as a test run: ${outcome}, but nothing will actually happen. Started by ${startedBy}.`
        : `Started watching for real: ${outcome}. Started by ${startedBy}.`,
    );
    this.syncTimers();
    this.reevaluate();
    this.loop.scanNow();
    this.publish();
    return OK;
  }

  /**
   * Asks the OS whether `action` can run unattended; null = yes. The plan stays editable while
   * that takes seconds, so a setting the arming window's editor changed meanwhile voids the arm.
   */
  private async askBeforeArming(action: PowerAction, command: ArmCommand): Promise<string | null> {
    this.arming = true;
    this.digestsWhileArming.clear();
    let capability: Capability;
    let reported: string | undefined;
    try {
      capability = await this.capabilities.query(action);
    } finally {
      this.arming = false;
      reported = this.digestsWhileArming.get(command.realm);
      this.digestsWhileArming.clear();
    }
    if (reported !== undefined && reported !== command.digest) return SETTINGS_CHANGED;
    if (capability.ok === true) return null;
    return capability.detail || `Couldn't check whether this PC can ${ACTION_VERB[action]} by itself.`;
  }

  /** The contract to watch with, or the plain-English reason watching cannot start. */
  private checkArm(command: ArmCommand): ArmContract | string {
    if (this.disposed || this.handingOver) return NOT_TAKING_COMMANDS;
    if (this.armed) return 'Already watching.';
    if (this.arming) return 'Watching is already being started.';
    if (this.phase === 'executing') return 'The action is running right now.';
    if (command.epoch !== this.epoch) return 'The controlling window changed. Check the plan and try again.';

    const contract = parseArmContract(command.contract);
    if (contract === null || contractDigest(contract) !== command.digest) {
      return "The plan that was sent isn't valid. Check the plan and try again.";
    }
    // Same editor as the leader: the plan the user saw must be the settings the leader has now.
    if (command.realm === this.deps.leader.realm && command.digest !== this.leaderDigest()) {
      return SETTINGS_CHANGED;
    }

    const brakeProblem = this.brakeProblem();
    if (brakeProblem !== null) return brakeProblem;
    const environmentProblem = environmentProblemOf(this.deps.platform);
    if (environmentProblem !== null) return environmentProblem;
    const helper = helperStatusOf(this.deps.platform);
    if (helper.tier === 'unavailable') {
      return helper.problem ?? "The programs running on this PC can't be seen, so watching can't start.";
    }
    return contract;
  }

  /**
   * Emergency stop is set - or the folder it lives in is unusable. That folder also holds the
   * records that say "a window was watching": without it, watching could end without a trace.
   */
  private brakeProblem(): string | null {
    const dir = this.deps.stateDir.dir;
    if (!this.deps.stateDir.ensure()) {
      return `The folder ${dir} can't be written to, so watching can't start. Emergency stop and the activity log live there.`;
    }
    this.refreshStop();
    if (!this.stop.present) return null;
    return this.stop.file === null
      ? `Emergency stop can't be checked because ${dir} can't be read, so watching can't start.`
      : `Emergency stop is set. Delete ${this.stop.file} to start watching.`;
  }

  private disarm(from: string): void {
    if (this.countdown?.kind === 'preview') this.endPreview('Preview stopped.');
    if (this.armed) {
      const kind = this.clearCountdown();
      this.note('info', `Stopped watching (asked from ${from}).`);
      this.stopWatching();
      if (kind !== null) this.recordCancel({ id: 'stoppedWatching' }, kind, false);
      else this.dropStillWatchingNotice();
    }
    this.syncTimers();
    this.publish();
  }

  private cancel(via: CancelVia): void {
    // Counted even when nothing seems to be running: a final gate that is being decided right
    // now must see that a Cancel arrived, whatever state it finds afterwards.
    this.cancelCounter++;
    if (this.countdown?.kind === 'preview') this.endPreview('Preview cancelled.');
    else if (this.armed) this.stopOnUserCancel({ id: 'user', via });
    this.syncTimers();
    this.publish();
  }

  /**
   * A person's Cancel means "keep this PC on", also when an automatic cancel (a session resumed,
   * Emergency stop, a closing window) got to the countdown a moment earlier: watching stops.
   */
  private stopOnUserCancel(reason: Extract<CancelReason, { id: 'user' }>): void {
    // The cooldown runs for exactly the 60 s after an automatic cancel, also across a handover.
    const justCancelled = this.cooldownRemainingMs(this.clock.mono()) !== null;
    const running = this.clearCountdown();
    const kind = running ?? (justCancelled ? this.armedCountdownKind() : null);
    if (running !== null) {
      this.note('info', `Countdown cancelled: ${cancelReasonText(reason)}. Watching stopped.`);
    } else if (justCancelled) {
      this.note('info', 'Cancel pressed right after the countdown had already been cancelled: watching stopped.');
    } else {
      this.note('info', 'Cancel pressed while watching: watching stopped.');
    }
    this.stopWatching();
    if (kind !== null) this.recordCancel(reason, kind, false);
    else this.dropStillWatchingNotice();
  }

  private armedCountdownKind(): 'real' | 'test' {
    return this.contract?.testMode === true ? 'test' : 'real';
  }

  private settingsChanged(realm: string, digest: string): void {
    if (this.arming) this.digestsWhileArming.set(realm, digest);
    if (this.armed) {
      const contract = this.contract;
      if (contract !== null && realm === this.contractRealm && digest !== contractDigest(contract)) {
        this.stopBecause(
          'settingsChanged',
          'The settings changed while watching, so watching stopped. Check the plan and start again.',
        );
      }
    } else {
      // Not watching: every window shows the leader's settings as the plan, and they just moved.
      this.generation++;
      this.reevaluate();
      if (this.engineActive()) this.loop.scanNow();
    }
    this.syncKeepAwake();
    this.syncTimers();
    this.publish();
  }

  private setIgnore(key: string, on: boolean): CommandResult {
    if (!isIgnoreKey(key)) return refuse("That isn't something this PC can stop waiting for.");
    if (on && !this.ignores.has(key) && this.ignores.size >= MAX_IGNORES) {
      return refuse('Too many things are being ignored already. Undo some first.');
    }
    const what = describeIgnoreKey(key, this.scan);
    if (on) this.ignores.add(key, this.clock.mono());
    else this.ignores.remove(key);
    this.generation++;
    this.note('info', on ? `Not waiting for ${what} any more.` : `Waiting for ${what} again.`);
    this.reevaluate();
    this.loop.scanNow();
    this.publish();
    return OK;
  }

  private startPreview(): CommandResult {
    if (this.armed || this.countdown !== null || this.commit !== null || this.phase === 'executing') {
      return refuse('The preview only works while not watching.');
    }
    this.startCountdown('preview', this.config().action, PREVIEW_MS);
    this.note('info', 'Preview countdown started. Nothing will happen to this PC.');
    this.syncTimers();
    this.loop.reschedule();
    this.publish();
    return OK;
  }

  // -------------------------------------------------------------------------------------------
  // Watching lifecycle
  // -------------------------------------------------------------------------------------------

  private beginWatching(contract: ArmContract, realm: string, by: ArmedBy, armedAtMs: number): void {
    if (this.countdown !== null) this.endPreview('Preview stopped: watching started.');
    this.contract = contract;
    this.contractRealm = realm;
    this.armed = true;
    this.armedBy = by;
    this.armedAtMs = armedAtMs;
    this.stablePolls = 0;
    this.lastCountedPollMono = null;
    this.allClearSinceMs = null;
    this.cooldownEndMono = null;
    this.generation++;
    this.phase = 'watching';
    this.journal.reset();
    saveWatchRecord(this.deps.stateDir, {
      armedAtMs,
      real: !contract.testMode,
      action: contract.action,
      pid: this.deps.leader.pid,
    });
    this.syncKeepAwake();
  }

  private stopWatching(): void {
    this.armed = false;
    this.armedBy = null;
    this.armedAtMs = null;
    this.contract = null;
    this.contractRealm = null;
    this.stablePolls = 0;
    this.lastCountedPollMono = null;
    this.allClearSinceMs = null;
    this.cooldownEndMono = null;
    this.generation++;
    this.phase = 'off';
    this.journal.reset();
    removeWatchRecord(this.deps.stateDir);
    this.syncKeepAwake();
  }

  /** Watching ends although the user did not ask for it: say why, loudly, and keep it on record. */
  private stopBecause(cause: 'settingsChanged' | 'timeJump', explanation: string): void {
    const stopped: LastResult = {
      kind: 'stopped',
      atMs: this.clock.now(),
      cause,
      armedAtMs: this.armedAtMs,
      wasReal: this.isReal(),
    };
    if (this.clearCountdown() !== null) this.note('info', `Countdown cancelled: ${cancelReasonText({ id: cause })}.`);
    this.note('warn', explanation);
    this.stopWatching();
    this.results.record(stopped);
  }

  // -------------------------------------------------------------------------------------------
  // Engine: when to scan, and what a finished scan means
  // -------------------------------------------------------------------------------------------

  private engineActive(): boolean {
    return !this.disposed && (this.armed || this.countdown !== null || saysYes(() => this.deps.hasViewers()));
  }

  private pollIntervalMs(): number {
    if (this.countdown !== null || this.commit !== null) return COUNTDOWN_POLL_MS;
    return this.watchPollMs();
  }

  /** The contract's own poll interval, whatever the countdown does to the scan rhythm. */
  private watchPollMs(): number {
    const ms = this.effectiveContract().pollSeconds * 1000;
    return Number.isFinite(ms) && ms >= COUNTDOWN_POLL_MS ? ms : FALLBACK_POLL_MS;
  }

  /**
   * "k checks in a row" means k checks a poll interval apart. An extra scan (Check again, an
   * ignore, the countdown's own 2 s rhythm) is shown and can reset the count, but cannot add to it.
   */
  private spacedFromLastPoll(startedMono: number): boolean {
    if (this.lastCountedPollMono === null) return true;
    return startedMono - this.lastCountedPollMono >= this.watchPollMs() - POLL_SPACING_SLACK_MS;
  }

  private staleAfterMs(): number {
    return Math.max(STALE_FLOOR_MS, 3 * this.pollIntervalMs());
  }

  /** The newest completed scan is too old to act on (or none arrived since the engine started). */
  private isScanStale(): boolean {
    if (!this.engineActive()) return false;
    const reference = this.lastScanCompletedMono ?? this.engineActiveSinceMono;
    return reference !== null && this.clock.mono() - reference > this.staleAfterMs();
  }

  private syncTimers(): void {
    if (this.disposed) return;
    this.ticker.sync();
    this.syncEngine();
  }

  private syncEngine(): void {
    if (!this.engineActive()) {
      this.loop.pause();
      if (this.watchdogTimer !== null) this.clock.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
      this.engineActiveSinceMono = null;
      return;
    }
    if (this.engineActiveSinceMono === null) this.activateEngine();
    if (this.watchdogTimer === null) {
      this.watchdogTimer = this.clock.setTimeout(() => this.watchdog(), WATCHDOG_MS);
    }
  }

  private activateEngine(): void {
    const mono = this.clock.mono();
    // Nothing was scanned while the engine was off, so nothing proves that no session ran in
    // between: "time since a session was last seen" starts again from now.
    if (this.engineRanBefore && this.sawAnySession) this.lastSessionSeenMono = mono;
    this.engineRanBefore = true;
    this.engineActiveSinceMono = mono;
    this.staleReported = false;
    if (this.lastScanCompletedMono !== null && mono - this.lastScanCompletedMono > this.staleAfterMs()) {
      this.scan = null;
      this.verdict = null;
      this.lastScanCompletedMono = null;
    }
    this.loop.scanNow();
  }

  private async poll(forceWide: boolean): Promise<PollOutcome | null> {
    await this.capabilities.refresh([this.effectiveContract().action], () => this.disposed);
    if (this.disposed) return null;
    const generation = this.generation;
    const startedMono = this.clock.mono();
    const scan = await this.runScanner(this.scanRequest(forceWide));
    if (this.disposed) return null;
    return this.absorbScan(scan, generation, startedMono);
  }

  private scanRequest(forceWide: boolean): ScanRequest {
    const contract = this.effectiveContract();
    return {
      quietSeconds: contract.quietSeconds,
      guardPatterns: contract.guardProcesses,
      waitForChildProcesses: contract.waitForChildProcesses,
      extraClaudeDirs: contract.extraClaudeDirs,
      scanWsl: contract.scanWsl,
      ignores: new Set(this.ignores.keys()),
      forceWide,
    };
  }

  /** null = no usable result. The scanner promises never to reject; this does not rely on it. */
  private async runScanner(request: ScanRequest): Promise<ScanResult | null> {
    let failure: string;
    try {
      const scan: unknown = await this.deps.scanner.scan(request);
      const usable =
        scan !== null &&
        typeof scan === 'object' &&
        Array.isArray((scan as ScanResult).sessions) &&
        Array.isArray((scan as ScanResult).errors) &&
        Array.isArray((scan as ScanResult).roots);
      if (usable) {
        this.lastScanFailure = '';
        return scan as ScanResult;
      }
      failure = 'The check returned nothing usable.';
    } catch (error) {
      failure = `The check failed: ${errorText(error)}`;
    }
    // A scanner that stays broken would otherwise write the same line every poll.
    if (failure !== this.lastScanFailure) this.note('error', failure);
    this.lastScanFailure = failure;
    return null;
  }

  private absorbScan(scan: ScanResult | null, generation: number, startedMono: number): PollOutcome {
    const mono = this.clock.mono();
    this.scan = scan;
    if (scan !== null) {
      this.lastScanCompletedMono = mono;
      this.staleReported = false;
      if (scan.sessions.length > 0) {
        this.sawAnySession = true;
        this.lastSessionSeenMono = mono;
      }
      this.pruneIgnores(scan, mono);
    }
    const isNewPoll =
      scan !== null && this.armed && generation === this.generation && this.spacedFromLastPoll(startedMono);
    const verdict = this.evaluate(isNewPoll);
    if (isNewPoll) this.lastCountedPollMono = startedMono;
    if (this.armed) this.journal.poll(scan, verdict, mono);
    this.react(verdict, isNewPoll);
    if (!this.armed) this.fillCapabilities();
    this.syncTimers();
    this.publish();
    return { scan, verdict, generation, startedMono };
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation and reaction
  // -------------------------------------------------------------------------------------------

  /** `isNewPoll` = a fresh scan that started under the current rules; only those are counted. */
  private evaluate(isNewPoll: boolean): Verdict {
    this.refreshStop();
    const contract = this.effectiveContract();
    const input: EvaluateInput = {
      scan: this.scan,
      scanStale: this.isScanStale(),
      contract,
      armed: this.armed,
      stopPresent: this.stop.present,
      capability: this.capabilities.get(contract.action),
      environmentProblem: environmentProblemOf(this.deps.platform),
      helperTier: helperStatusOf(this.deps.platform).tier,
      remoteWindows: this.remoteWindows(),
      stablePolls: this.stablePolls,
      sawAnySession: this.sawAnySession,
      secondsSinceLastSession:
        this.lastSessionSeenMono === null ? null : (this.clock.mono() - this.lastSessionSeenMono) / 1000,
    };

    let verdict: Verdict;
    try {
      verdict = this.deps.evaluate(input);
    } catch (error) {
      verdict = failedVerdict(contract.requiredPolls, `The checks could not be evaluated: ${errorText(error)}`);
    }
    if (!isNewPoll) verdict = withoutNewPoll(verdict, this.stablePolls, contract.requiredPolls);
    this.countPoll(verdict, contract.requiredPolls);
    this.verdict = verdict;
    return verdict;
  }

  private countPoll(verdict: Verdict, requiredPolls: number): void {
    const k = verdict.stablePolls;
    const clear = this.armed && verdict.allClear === true && Number.isInteger(k) && k > 0;
    // Never more than one step per poll, whatever the verdict claims.
    this.stablePolls = clear ? Math.min(k, this.stablePolls + 1, requiredPolls) : 0;
    if (this.stablePolls === 0) this.allClearSinceMs = null;
    else if (this.allClearSinceMs === null) this.allClearSinceMs = this.clock.now();
  }

  /** Looks at the evidence again without a new scan (a peer, a setting or the STOP file changed). */
  private reevaluate(): void {
    const verdict = this.evaluate(false);
    // Right after Start there is no scan yet; "waiting for the first check" is not worth a line.
    if (this.armed && this.scan !== null) this.journal.verdict(verdict, this.scan);
    this.react(verdict, false);
  }

  private react(verdict: Verdict, isNewPoll: boolean): void {
    if (!this.armed) return;
    const running = this.countdown !== null || this.commit !== null;
    if (verdict.allClear !== true) {
      if (running) this.cancelAutomatically(cancelReasonFor(verdict, this.scan, this.isScanStale()));
      this.phase = 'watching';
      return;
    }
    if (running) return;
    this.phase = 'confirming';
    if (isNewPoll && this.mayStartFinalStage(verdict)) this.startFinalStage();
  }

  private mayStartFinalStage(verdict: Verdict): boolean {
    const required = this.contract?.requiredPolls;
    return (
      verdict.ok === true &&
      required !== undefined &&
      Number.isFinite(required) &&
      this.stablePolls >= required &&
      this.cooldownRemainingMs(this.clock.mono()) === null &&
      !this.handingOver
    );
  }

  private startFinalStage(): void {
    const contract = this.contract;
    if (contract === null) return;
    const kind = contract.testMode ? 'test' : 'real';
    if (contract.action === 'notify') {
      // Nothing happens to this PC, so there is nothing to warn about: straight to the final gate.
      this.beginCommit(kind, 'notify');
      return;
    }
    const seconds = contract.countdownSeconds;
    this.dropStillWatchingNotice();
    this.startCountdown(kind, contract.action, seconds * 1000);
    this.note(
      'info',
      kind === 'test'
        ? `Everything is clear, ${this.stablePolls} checks in a row. Test run countdown started (${seconds} s); nothing will happen to this PC.`
        : `Everything is clear, ${this.stablePolls} checks in a row. Countdown started: this PC will ${ACTION_VERB[contract.action]} in ${seconds} s.`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Countdown, ticks, time discontinuities
  // -------------------------------------------------------------------------------------------

  private startCountdown(kind: CountdownKind, action: PowerAction, totalMs: number): void {
    const mono = this.clock.mono();
    const countdown: Countdown = { id: randomId(), kind, action, totalMs, startedMono: mono, deadlineMono: mono + totalMs };
    this.countdown = countdown;
    this.phase = 'countdown';
    this.lastIdleSampleMono = null;
    this.startAlert(countdown);
    this.ticker.hasten();
  }

  /** Ends the countdown and voids a pending final gate. Returns what was running, if anything. */
  private clearCountdown(): CountdownKind | null {
    const kind = this.countdown?.kind ?? this.commit?.kind ?? null;
    this.countdown = null;
    this.commit = null;
    this.stopAlert();
    return kind;
  }

  private endPreview(logText: string): void {
    if (this.clearCountdown() === null) return;
    if (!this.armed && this.phase === 'countdown') this.phase = 'off';
    this.note('info', logText);
  }

  /**
   * A cancel nobody asked for (a session resumed, a check failed, the user came back): keep
   * watching, but no new countdown for 60 s, and the confirmations start again from zero.
   */
  private cancelAutomatically(reason: CancelReason): void {
    const kind = this.clearCountdown();
    if (kind === null) return;
    this.stablePolls = 0;
    this.allClearSinceMs = null;
    this.generation++;
    this.cooldownEndMono = this.clock.mono() + COOLDOWN_MS;
    this.phase = 'watching';
    this.note('info', `Countdown cancelled: ${cancelReasonText(reason)}. Still watching.`);
    this.recordCancel(reason, kind, true);
  }

  private recordCancel(reason: CancelReason, countdownKind: CountdownKind, stillWatching: boolean): void {
    this.results.record({ kind: 'cancelled', atMs: this.clock.now(), reason, stillWatching, countdownKind });
  }

  /** A "cancelled, still watching" card describes a run that has since moved on. */
  private dropStillWatchingNotice(): void {
    const result = this.results.shown;
    if (result?.kind === 'cancelled' && result.stillWatching) this.results.dismiss();
  }

  /** 250 ms during a countdown or the final gate, 1 s while merely watching, else no tick. */
  private tickIntervalMs(): number | null {
    if (this.countdown !== null || this.commit !== null) return COUNTDOWN_TICK_MS;
    return this.armed ? WATCH_TICK_MS : null;
  }

  private onTimeJump(): void {
    if (this.armed) {
      // After hours of sleep every "quiet for N minutes" check is trivially green. That is stale
      // evidence, not permission: stop watching and say so.
      this.stopBecause(
        'timeJump',
        'This PC slept, stalled or its clock changed, so watching stopped. Nothing was done to this PC.',
      );
    } else {
      this.endPreview('Preview stopped: this PC slept or its clock changed.');
    }
    this.syncTimers();
    this.publish();
  }

  /** Only ever called for a tick that arrived on time (see Ticker). */
  private onTick(mono: number): void {
    // The brake must act within one tick, not one poll.
    if (this.refreshStop()) {
      this.reevaluate();
      this.publish();
    }
    const countdown = this.countdown;
    if (countdown === null) return;
    if (this.commit === null && mono >= countdown.deadlineMono) {
      this.countdownElapsed(countdown);
      return;
    }
    if (countdown.kind !== 'preview') this.sampleIdle(countdown, mono);
    if (mono - this.lastPublishMono >= COUNTDOWN_PUBLISH_MS) this.publish();
  }

  private countdownElapsed(countdown: Countdown): void {
    if (countdown.kind === 'preview') {
      this.endPreview('Preview finished.');
      this.syncTimers();
      this.publish();
      return;
    }
    this.beginCommit(countdown.kind, countdown.action);
  }

  /** Once per second during a real / test countdown: is the user still away? */
  private sampleIdle(countdown: Countdown, mono: number): void {
    if (this.contract?.requireUserIdle !== true || this.idleSampleFor === countdown) return;
    if (this.lastIdleSampleMono !== null && mono - this.lastIdleSampleMono < IDLE_SAMPLE_MS) return;
    this.idleSampleFor = countdown;
    this.lastIdleSampleMono = mono;
    this.detach('checking whether you are away', this.checkStillAway(countdown, mono));
  }

  private async checkStillAway(countdown: Countdown, askedAtMono: number): Promise<void> {
    let idleSeconds: number | null = null;
    try {
      const value = await this.deps.platform.idleSeconds();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) idleSeconds = value;
    } catch {
      // can't tell = not away
    } finally {
      if (this.idleSampleFor === countdown) this.idleSampleFor = null;
    }
    if (this.disposed || this.countdown?.id !== countdown.id) return;
    // Input that happened after the countdown began shows up as an idle time shorter than the
    // countdown's age. Unknown idle time is treated the same way: can't tell = the user is here.
    const countdownAgeMs = askedAtMono - countdown.startedMono;
    const stillAway = idleSeconds !== null && idleSeconds * 1000 >= countdownAgeMs - IDLE_TOLERANCE_MS;
    if (stillAway) return;
    this.cancelAutomatically({ id: 'userCameBack' });
    this.syncTimers();
    this.publish();
  }

  // -------------------------------------------------------------------------------------------
  // The final gate and the action
  // -------------------------------------------------------------------------------------------

  private beginCommit(kind: 'real' | 'test', action: PowerAction): void {
    const ticket: CommitTicket = {
      countdownId: this.countdown?.id ?? null,
      kind,
      action,
      cancelCounter: this.cancelCounter,
      startedMono: this.clock.mono(),
    };
    this.commit = ticket;
    this.phase = 'committing';
    this.syncTimers();
    this.publish();
    this.detach('the final check', this.runCommit(ticket));
  }

  private async runCommit(ticket: CommitTicket): Promise<void> {
    const freshScan = this.loop.exclusive(() => this.poll(true)).catch(() => null);
    const [outcome] = await Promise.all([freshScan, this.barrier()]);
    if (this.disposed) return;

    // From here to platform.execute() nothing is awaited: a Cancel cannot slip in between the
    // gate and the action.
    const decision = this.gate(ticket, outcome);
    if (decision === 'superseded') return;
    if (decision === 'pass') {
      this.execute(ticket);
      return;
    }
    if (decision.id === 'timeJump') {
      this.onTimeJump();
      return;
    }
    this.cancelAutomatically(decision);
    this.syncTimers();
    this.publish();
  }

  private barrier(): Promise<void> {
    return new Promise((resolve) => {
      this.barrierTimer = this.clock.setTimeout(resolve, COMMIT_BARRIER_MS);
    });
  }

  /**
   * Synchronous. 'superseded' = something else already ended this run (Cancel, Stop watching, a
   * failed check) and has said so itself. A CancelReason = the gate refuses, for that reason.
   */
  private gate(ticket: CommitTicket, outcome: PollOutcome | null): 'pass' | 'superseded' | CancelReason {
    const sameRun = this.commit === ticket && (this.countdown?.id ?? null) === ticket.countdownId;
    if (!this.armed || !sameRun || this.cancelCounter !== ticket.cancelCounter || this.handingOver) {
      return 'superseded';
    }
    this.refreshStop();
    if (this.stop.present) return { id: 'emergencyStop' };
    const evidence = this.evidenceProblem(ticket, outcome);
    if (evidence !== null) return evidence;
    if (this.ticker.jumped()) return { id: 'timeJump' };
    if (!saysYes(() => this.deps.stillLeader())) return { id: 'leaderChanged' };
    if (ticket.action !== 'notify' && this.capabilities.get(ticket.action)?.ok !== true) {
      return { id: 'checkFailed', check: 'actionAllowed' };
    }
    return 'pass';
  }

  /** The scan must have STARTED after the countdown ended, under the current rules, and be clear. */
  private evidenceProblem(ticket: CommitTicket, outcome: PollOutcome | null): CancelReason | null {
    if (outcome === null || outcome.scan === null) return { id: 'checkFailed', check: 'scanner' };
    if (outcome.verdict.allClear !== true) {
      return cancelReasonFor(outcome.verdict, outcome.scan, this.isScanStale());
    }
    if (outcome.verdict.ok !== true) return { id: 'checkFailed', check: 'confirmed' };
    const fresh =
      Number.isFinite(outcome.startedMono) &&
      outcome.startedMono >= ticket.startedMono &&
      outcome.generation === this.generation;
    return fresh ? null : { id: 'checkFailed', check: 'scanner' };
  }

  private execute(ticket: CommitTicket): void {
    const contract = this.contract;
    const realm = this.contractRealm ?? this.deps.leader.realm;
    this.clearCountdown();
    this.phase = 'executing';
    if (contract === null) {
      // Unreachable while armed; without the frozen rules nothing may run.
      this.stopWatching();
      this.publish();
      return;
    }
    if (ticket.kind === 'test') {
      this.finishTestRun(ticket.action);
      return;
    }
    // Watching ends before the command runs, but until it returns every window must show the
    // rules of THIS run, not the leader's own settings (which may be a test run, or another action).
    this.inProgress = { contract, realm };
    this.detach('running the action', this.runAction(ticket.action, contract.forceCloseApps));
  }

  private finishTestRun(action: PowerAction): void {
    const result: LastResult = {
      kind: 'testPassed',
      atMs: this.clock.now(),
      action,
      armedAtMs: this.armedAtMs,
      lastSessionFinishedAtMs: this.lastSessionFinishedAtMs(),
      allClearAtMs: this.allClearSinceMs,
      heldUpBy: this.journal.heldUpBy(),
    };
    this.note('info', `Test run passed: this PC would ${ACTION_VERB[action]} now. Nothing was done.`);
    this.stopWatching();
    this.results.record(result);
    this.syncTimers();
    this.publish();
  }

  private async runAction(action: PowerAction, force: boolean): Promise<void> {
    const startedWall = this.clock.now();
    const done: DoneResult = { kind: 'done', atMs: startedWall, action, resumedAtMs: null, confirmed: null };
    // On disk BEFORE the command: a shutdown leaves no time to write anything afterwards, and
    // this PC must not come back up believing it is still watching.
    this.note('info', `Every check passed. This PC will now ${ACTION_VERB[action]}.`);
    this.results.record(done);
    this.stopWatching();
    this.phase = 'executing';
    const running = this.callExecute(action, force);
    this.syncTimers();
    this.publish();

    const result = await running;
    const now = this.clock.now();
    if (!result.ok) {
      this.note('error', `The action failed and this PC is still on: ${result.detail}`);
      this.results.record({ kind: 'failed', atMs: now, action, message: result.detail });
    } else if (result.confirmed === false) {
      this.note('warn', `The command to ${ACTION_VERB[action]} was sent, but it could not be confirmed that it happened: ${result.detail}`);
      this.results.record({ ...done, confirmed: false });
    } else {
      this.note('info', `Done: ${result.detail}`);
      this.recordDone(done, result.confirmed, now, now - startedWall);
    }
    this.phase = 'off';
    this.inProgress = null;
    this.syncTimers();
    this.publish();
  }

  /** The action worked (or nothing says it did not): keep what is known about how it went. */
  private recordDone(done: DoneResult, confirmed: boolean | null, now: number, elapsedWallMs: number): void {
    const suspends = done.action === 'sleep' || done.action === 'hibernate';
    if (suspends && (confirmed === true || elapsedWallMs > RESUME_GAP_MS)) {
      this.results.record({ ...done, resumedAtMs: now, confirmed });
    } else if (confirmed === true) {
      this.results.record({ ...done, confirmed });
    } else if (done.action === 'shutdown') {
      this.expectShutdown(done);
    }
  }

  /** Calls platform.execute synchronously (before the first await) and never rejects. */
  private async callExecute(action: PowerAction, force: boolean): Promise<ActionResult> {
    try {
      const result: unknown = await this.deps.platform.execute(action, { force });
      const source = result !== null && typeof result === 'object' ? (result as Partial<ActionResult>) : {};
      const ok = source.ok === true;
      return {
        ok,
        detail: typeof source.detail === 'string' && source.detail !== '' ? source.detail : 'no details were reported',
        command: typeof source.command === 'string' ? source.command : null,
        exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
        confirmed: ok && typeof source.confirmed === 'boolean' ? source.confirmed : null,
      };
    } catch (error) {
      return { ok: false, detail: errorText(error), command: null, exitCode: null, confirmed: null };
    }
  }

  /** A shutdown command that "worked" while this code still runs two minutes later did not work. */
  private expectShutdown(done: DoneResult): void {
    if (this.disposed) return;
    this.shutdownCheckTimer = this.clock.setTimeout(() => {
      this.shutdownCheckTimer = null;
      if (this.disposed || this.results.latest !== done) return;
      this.note('error', 'The shut down command was sent two minutes ago, but this PC is still on.');
      this.results.record({ ...done, confirmed: false });
      this.publish();
    }, SHUTDOWN_CONFIRM_MS);
  }

  // -------------------------------------------------------------------------------------------
  // Watchdog
  // -------------------------------------------------------------------------------------------

  private watchdog(): void {
    this.watchdogTimer = null;
    if (this.disposed) return;
    try {
      if (!this.engineActive()) return;
      const stopChanged = this.refreshStop();
      const wentStale = this.isScanStale() && !this.staleReported;
      if (wentStale) {
        this.staleReported = true;
        this.note('warn', 'The checks stopped answering. Until they answer again, nothing can be confirmed and this PC stays on.');
      }
      if (wentStale || stopChanged) {
        this.reevaluate();
        this.publish();
      }
      if (this.loop.idle) this.loop.scanNow();
      // Half the heartbeat: with a 5 s watchdog that keeps every gap between publishes under 10 s.
      if (this.clock.mono() - this.lastPublishMono >= HEARTBEAT_MS / 2) this.publish();
    } catch (error) {
      this.note('error', `The watchdog failed: ${errorText(error)}`);
    } finally {
      this.syncTimers();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Platform courtesies: capability preview, keep-awake, the OS alert, the brake
  // -------------------------------------------------------------------------------------------

  /** While not watching: fill in all five actions in the background for the plan's action select. */
  private fillCapabilities(): void {
    if (this.fillingCapabilities || !this.engineActive()) return;
    this.fillingCapabilities = true;
    const fill = this.capabilities
      .refresh(POWER_ACTIONS, () => this.disposed)
      .then((asked) => {
        if (asked) this.publish();
      })
      .finally(() => {
        this.fillingCapabilities = false;
      });
    this.detach('checking what this PC can do', fill);
  }

  private syncKeepAwake(): void {
    this.keepAwake.want(this.armed && !this.disposed && this.config().keepAwake);
  }

  private keepAwakeSettled(held: boolean): void {
    if (this.disposed) return;
    if (!held) this.note('warn', "Couldn't stop this PC from going to sleep by itself while watching.");
    this.publish();
  }

  private startAlert(countdown: Countdown): void {
    const config = this.config();
    if (!config.countdownAlert) return;
    try {
      const text = this.alertText(countdown);
      const alert = this.deps.platform.startCountdownAlert({
        seconds: this.alertSecondsLeft(countdown),
        kind: countdown.kind,
        title: text.title,
        body: text.body,
        cancelLabel: text.cancelLabel,
        sound: config.countdownSound,
      });
      this.alert = alert;
      alert.onCancel(() => this.alertCancelled(countdown));
    } catch (error) {
      this.note('warn', `Couldn't show the countdown warning on screen: ${errorText(error)}`);
    }
  }

  /** Whole seconds left at this moment, minus the guard band: the alert never shows more than remains. */
  private alertSecondsLeft(countdown: Countdown): number {
    const ms = countdown.deadlineMono - this.clock.mono() - GUARD_BAND_MS;
    return Math.max(1, Math.floor(ms / 1000));
  }

  private alertCancelled(countdown: Countdown): void {
    // A press on an alert whose countdown already ended (an automatic cancel got there first) is
    // still a person saying "keep this PC on": while watching it stops watching. While not
    // watching it must not end a later preview.
    if (this.disposed || (this.countdown?.id !== countdown.id && !this.armed)) return;
    try {
      this.cancel('osAlert');
    } catch (error) {
      this.note('error', `Cancel from the countdown warning failed: ${errorText(error)}`);
    }
  }

  private alertText(countdown: Countdown): { title: string; body: string; cancelLabel: string } {
    try {
      const text = this.deps.alertText?.(this.buildState());
      if (
        text !== undefined &&
        typeof text.title === 'string' &&
        typeof text.body === 'string' &&
        typeof text.cancelLabel === 'string'
      ) {
        return text;
      }
    } catch {
      // fall back to the built-in wording
    }
    return builtInAlertText(countdown.kind, countdown.action);
  }

  private stopAlert(): void {
    const alert = this.alert;
    this.alert = null;
    try {
      alert?.stop();
    } catch {
      // the alert is best effort; a window that will not close does not stop the controller
    }
  }

  /** Re-reads Emergency stop. Returns whether it changed. An unreadable folder counts as set. */
  private refreshStop(): boolean {
    let next: StopStatus;
    try {
      next = this.deps.stateDir.stopStatus();
    } catch {
      next = { present: true, auto: false, file: null };
    }
    const changed = next.present !== this.stop.present || next.auto !== this.stop.auto;
    this.stop = next;
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Ignores and remote windows
  // -------------------------------------------------------------------------------------------

  private remoteWindows(): RemoteWindow[] {
    return remoteWindowNames(() => this.deps.getRemoteWindows()).map((name) => {
      const ignoreKey = remoteIgnoreKey(name);
      return { name, ignoreKey, ignored: this.ignores.has(ignoreKey), covered: this.coveredByScan(name) };
    });
  }

  /** A remote window is covered when the scan reads that environment's own Claude folder. */
  private coveredByScan(name: string): boolean {
    return this.scan?.roots.some((root) => root.kind === 'foreign' && root.ok && root.label === name) === true;
  }

  private pruneRemoteIgnores(): void {
    const connected = new Set(this.remoteWindows().map((window) => window.ignoreKey));
    this.ignores.pruneRemote(connected, this.clock.mono());
  }

  private pruneIgnores(scan: ScanResult, mono: number): void {
    this.pruneRemoteIgnores();
    const voidedSessions = this.ignores.pruneAgainst(scan, mono);
    if (voidedSessions > 0 && this.armed) {
      this.note('info', 'A session that was not being waited for changed or closed, so it is no longer ignored.');
    }
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  private note(level: ActivityEntry['level'], text: string): void {
    this.activity.add(level, text);
  }

  private config(): Config {
    return this.deps.getConfig();
  }

  /** The frozen contract while watching or acting on it, else the leader's current settings. */
  private effectiveContract(): ArmContract {
    return this.contract ?? this.inProgress?.contract ?? toArmContract(this.config());
  }

  private leaderDigest(): string {
    return contractDigest(toArmContract(this.config()));
  }

  private isReal(): boolean {
    return this.contract !== null && !this.contract.testMode;
  }

  private cooldownRemainingMs(mono: number): number | null {
    if (!this.armed || this.cooldownEndMono === null || this.cooldownEndMono <= mono) return null;
    return Math.ceil(this.cooldownEndMono - mono);
  }

  private lastSessionFinishedAtMs(): number | null {
    let latest: number | null = null;
    for (const session of this.scan?.sessions ?? []) {
      const at = session.lastActivityMs;
      if (session.ignored || typeof at !== 'number' || !Number.isFinite(at)) continue;
      if (latest === null || at > latest) latest = at;
    }
    return latest;
  }

  private countdownState(mono: number): CountdownState | null {
    const countdown = this.countdown;
    if (countdown === null) return null;
    return {
      id: countdown.id,
      kind: countdown.kind,
      action: countdown.action,
      totalMs: countdown.totalMs,
      // Rounded down: whole ms on the wire, and never a fraction more than really remains.
      remainingMs: Math.max(0, Math.floor(countdown.deadlineMono - mono - GUARD_BAND_MS)),
    };
  }

  private buildState(): UiState {
    const mono = this.clock.mono();
    const contract = this.effectiveContract();
    const platform = this.deps.platform;
    const helper = helperStatusOf(platform);
    return {
      v: PROTOCOL_VERSION,
      seq: this.seq,
      epoch: this.epoch,
      leader: this.deps.leader,
      hostname: this.deps.hostname,

      phase: this.phase,
      armed: this.armed,
      armedAtMs: this.armedAtMs,
      armedBy: this.armedBy,
      contract,
      contractDigest: contractDigest(contract),
      contractRealm: this.contractRealm ?? this.inProgress?.realm ?? this.deps.leader.realm,

      confirm: {
        k: Math.min(this.stablePolls, contract.requiredPolls),
        n: contract.requiredPolls,
        nextCheckInMs: this.loop.nextScanInMs(),
      },
      countdown: this.countdownState(mono),
      cooldownRemainingMs: this.cooldownRemainingMs(mono),

      checks: this.verdict?.checks ?? [],
      sessions: this.scan?.sessions ?? [],
      // The coordinator trims rows for the wire and says how many; here every session is listed.
      sessionsOmitted: 0,
      strays: this.scan?.strays ?? null,
      remoteWindows: this.remoteWindows(),

      scan: {
        engineActive: this.engineActive(),
        lastCompletedAgoMs:
          this.lastScanCompletedMono === null ? null : Math.max(0, Math.floor(mono - this.lastScanCompletedMono)),
        stale: this.isScanStale(),
        errors: this.scan?.errors ?? [],
        roots: this.scan?.roots ?? [],
      },

      platform: {
        id: platform.id,
        osName: platform.osName,
        experimental: platform.experimental,
        helperTier: helper.tier,
        problem: environmentProblemOf(platform) ?? helper.problem ?? this.scan?.helperProblem ?? null,
        capability: this.capabilities.get(contract.action),
        capabilities: this.capabilities.all(),
        keepAwake: this.keepAwake.state,
      },

      stop: { present: this.stop.present, dir: this.deps.stateDir.dir, auto: this.stop.auto },

      lastResult: this.results.shown,
      testPassedOnce: this.results.testPassedOnce,
      activity: this.activity.entries(),
      logFile: this.deps.stateDir.logFile,
    };
  }

  private publish(): void {
    if (this.disposed) return;
    this.seq++;
    this.lastPublishMono = this.clock.mono();
    const state = this.buildState();
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch (error) {
        this.note('error', `A window could not be updated: ${errorText(error)}`);
      }
    }
  }

  /** Runs async work nobody awaits; a failure is logged instead of becoming an unhandled rejection. */
  private detach(what: string, work: Promise<unknown>): void {
    work.catch((error: unknown) => {
      this.note('error', `Something went wrong while ${what}: ${errorText(error)}`);
    });
  }
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
