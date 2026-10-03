// This window's part in the group of editor windows: which role it has, what it may show, and
// what it sends to whoever leads.
//
// - The controller, the scanner and the platform helper exist ONLY while this window is the
//   leader. They are built when the role arrives and torn down when it leaves, so there is one
//   helper process and one decision maker per machine.
// - A follower shows the state the leader pushed on the current connection, and nothing else.
//   Every role change starts from "no state": what was on screen under the previous role is
//   history and must not be shown as the present.
// - A Stop or Cancel from this window that no leader confirms becomes an Emergency stop file.
//
// No vscode import: the role switching runs in unit tests against fakes.

import type { Coordinator, RemoteState, RoleChange } from '../coordination/coordinator';
import type { Command, CommandResult, HandoverPayload, UiState, WindowHello } from '../shared/protocol';
import type { StateDir } from '../shared/stateDir';
import { copy } from './copy';
import type { WindowSnapshot } from './snapshot';

/** What the session needs of the leader-only machinery (controller + scanner + platform). */
export interface LeaderRuntime {
  getState(): UiState;
  handleCommand(command: Command, from: WindowHello): Promise<CommandResult>;
  beginHandover(): HandoverPayload | null;
  /** This window's settings changed. */
  configChanged(): void;
  /** Viewers or connected windows changed. */
  peersChanged(): void;
  /**
   * Stops the controller synchronously (it writes its records before this returns); the promise
   * settles once the platform helper has been released. Never rejects.
   */
  dispose(options: LeaderDisposal): Promise<void>;
}

/**
 * Why the leader-only machinery stops. handedOver = a sibling took the armed state; cause
 * 'lostControl' = this window stays open but lost its leadership (its endpoint went away), which
 * is recorded as such rather than as a closed window.
 */
export interface LeaderDisposal {
  handedOver: boolean;
  cause?: 'lostControl';
}

export interface LeaderStart {
  /** Armed state accepted from a window that just closed; null = start not watching. */
  handover: HandoverPayload | null;
  previousLeaderWasWatching: boolean;
  /** This window led from its very first election: the editor has just started. */
  freshStart: boolean;
  /** Receives every state the controller publishes, including those published while it starts. */
  onState(state: UiState): void;
}

export type WindowCoordinator = Pick<
  Coordinator,
  | 'setLeaderHandlers'
  | 'start'
  | 'onRole'
  | 'onRemoteState'
  | 'onPeersChanged'
  | 'publish'
  | 'send'
  | 'onSafeCommandStuck'
  | 'onSafeCommandsDelivered'
  | 'setViewVisible'
  | 'dispose'
>;

export type SafeCommand = Extract<Command, { name: 'disarm' | 'cancel' }>;

/**
 * What became of Emergency stop after a Stop / Cancel went unconfirmed:
 * set = this extension created the STOP file; alreadySet = one was there already;
 * failed = none could be created; cleared = the command got through and our file is gone again.
 */
export type AutoStopOutcome = 'set' | 'alreadySet' | 'failed' | 'cleared';

export interface WindowSessionOptions {
  coordinator: WindowCoordinator;
  stateDir: Pick<StateDir, 'createAutoStop' | 'clearAutoStop' | 'stopStatus'>;
  self: WindowHello;
  /** Builds and starts the leader-only machinery. Called only when this window becomes the leader. */
  createLeader(start: LeaderStart): LeaderRuntime;
  log(message: string): void;
}

interface Subscription {
  dispose(): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WindowSession {
  private readonly options: WindowSessionOptions;
  private readonly subscriptions: Subscription[] = [];
  private readonly changeListeners = new Set<() => void>();
  private readonly autoStopListeners = new Set<(outcome: AutoStopOutcome) => void>();

  private snapshot: WindowSnapshot = { role: 'electing', state: null, limited: false, receivedAtMono: performance.now() };
  private leader: LeaderRuntime | null = null;
  private roleSeen = false;
  private dashboardVisible = false;
  /** Stop / Cancel requests sent from this window that no leader has answered yet, oldest first. */
  private readonly unconfirmed: SafeCommand['name'][] = [];
  private autoStop: Exclude<AutoStopOutcome, 'cleared'> | null = null;
  /** Digest of a plan change that no leader has been told about yet. */
  private untoldPlanDigest: string | null = null;
  private disposal: Promise<void> | null = null;

  constructor(options: WindowSessionOptions) {
    this.options = options;
  }

  /** Begin electing. Role and state changes arrive through onChange. */
  start(): void {
    const { coordinator } = this.options;
    coordinator.setLeaderHandlers({
      handleCommand: (command, from) =>
        this.leader?.handleCommand(command, from) ?? Promise.resolve({ ok: false, error: copy.controllerNotReady }),
      currentState: () => this.leader?.getState() ?? null,
      beginHandover: () => this.leader?.beginHandover() ?? null,
    });
    this.subscriptions.push(
      coordinator.onRole((change) => this.onRole(change)),
      coordinator.onRemoteState((remote) => this.onRemoteState(remote)),
      coordinator.onPeersChanged(() => this.leader?.peersChanged()),
      coordinator.onSafeCommandStuck(() => this.onSafeCommandStuck()),
      coordinator.onSafeCommandsDelivered(() => this.onSafeCommandsDelivered()),
    );
    coordinator.start();
  }

  /** What this window may show right now. */
  get current(): WindowSnapshot {
    return this.snapshot;
  }

  /** A Stop or Cancel sent from this window is still unconfirmed. */
  get pending(): 'cancel' | 'disarm' | null {
    return this.unconfirmed[this.unconfirmed.length - 1] ?? null;
  }

  /** The Emergency stop file in place was created because such a request stayed unconfirmed. */
  get autoStopSet(): boolean {
    return this.autoStop === 'set';
  }

  get viewVisible(): boolean {
    return this.dashboardVisible;
  }

  /** Fires after every change of `current`, `pending` or `autoStopSet`. */
  onChange(listener: () => void): Subscription {
    this.changeListeners.add(listener);
    return { dispose: () => void this.changeListeners.delete(listener) };
  }

  onAutoStop(listener: (outcome: AutoStopOutcome) => void): Subscription {
    this.autoStopListeners.add(listener);
    return { dispose: () => void this.autoStopListeners.delete(listener) };
  }

  /** Send a command to whoever leads. Never rejects; never retried. */
  send(command: Command): Promise<CommandResult> {
    return this.options.coordinator.send(command);
  }

  /**
   * Stop watching / cancel the countdown. The coordinator keeps the request until a leader
   * confirms it; until then `pending` says so, and after 2 s Emergency stop is set instead.
   */
  async sendSafe(command: SafeCommand): Promise<CommandResult> {
    this.unconfirmed.push(command.name);
    this.changed();
    try {
      return await this.options.coordinator.send(command);
    } finally {
      const index = this.unconfirmed.indexOf(command.name);
      if (index >= 0) this.unconfirmed.splice(index, 1);
      this.changed();
    }
  }

  /** This window's dashboard was shown or hidden (the engine only scans while somebody looks). */
  setViewVisible(visible: boolean): void {
    if (visible === this.dashboardVisible) return;
    this.dashboardVisible = visible;
    this.options.coordinator.setViewVisible(visible);
    this.leader?.peersChanged();
  }

  /** This window's validated settings changed. `digest` is that of its new plan. */
  settingsChanged(change: { contractChanged: boolean; digest: string }): void {
    if (this.leader !== null) {
      this.leader.configChanged();
      return;
    }
    // The leader may be watching under THIS window's plan (it can belong to another editor, whose
    // settings the leader cannot see). A plan that changed is no longer the one that was agreed to.
    if (change.contractChanged) void this.tellLeaderAboutPlan(change.digest);
  }

  /**
   * The window is closing: say goodbye (offering the armed state to a sibling), then stop the
   * controller and release the helper. Resolves when all of that is done.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.shutDown();
    return this.disposal;
  }

  // ----- roles ---------------------------------------------------------------------------------

  private onRole(change: RoleChange): void {
    if (this.disposal !== null) return;
    const freshStart = !this.roleSeen;
    this.roleSeen = true;
    // Whatever this window did and showed belongs to the role it has just left.
    this.retireLeader();
    this.snapshot = { role: change.role, state: null, limited: false, receivedAtMono: performance.now() };
    if (change.role === 'leader') this.lead(change, freshStart);
    this.deliverUntoldPlanChange();
    this.changed();
  }

  /**
   * A plan change made while no leader could be told (between two leaders, say) still has to end
   * a watch that was agreed under the old plan - also one this window has just taken over.
   */
  private deliverUntoldPlanChange(): void {
    if (this.untoldPlanDigest === null) return;
    if (this.leader !== null) {
      this.untoldPlanDigest = null;
      this.leader.configChanged();
    } else {
      void this.tellLeaderAboutPlan(this.untoldPlanDigest);
    }
  }

  private async tellLeaderAboutPlan(digest: string): Promise<void> {
    this.untoldPlanDigest = digest;
    if (this.snapshot.role !== 'follower') return;
    const result = await this.options.coordinator.send({ name: 'settingsChanged', realm: this.options.self.realm, digest });
    if (result.ok && this.untoldPlanDigest === digest) this.untoldPlanDigest = null;
  }

  private lead(change: RoleChange, freshStart: boolean): void {
    try {
      const leader = this.options.createLeader({
        handover: change.handover,
        previousLeaderWasWatching: change.previousLeaderWasWatching,
        freshStart,
        onState: (state) => this.onLeaderState(state),
      });
      this.leader = leader;
      this.snapshot = { role: 'leader', state: leader.getState(), limited: false, receivedAtMono: performance.now() };
    } catch (error) {
      // A leader in name only: every command is refused and no state is claimed.
      this.options.log(`The controller could not be started: ${describe(error)}`);
    }
  }

  private onLeaderState(state: UiState): void {
    if (this.snapshot.role !== 'leader' || this.disposal !== null) return;
    this.options.coordinator.publish(state);
    this.snapshot = { role: 'leader', state, limited: false, receivedAtMono: performance.now() };
    this.changed();
  }

  /**
   * Stepping down while this window stays open (closing goes through shutDown): nobody was offered
   * the armed state, so watching ends here - because control was lost, not because a window closed.
   */
  private retireLeader(): void {
    const leader = this.leader;
    if (leader === null) return;
    this.leader = null;
    void this.release(leader, { handedOver: false, cause: 'lostControl' });
  }

  private async release(leader: LeaderRuntime, disposal: LeaderDisposal): Promise<void> {
    try {
      await leader.dispose(disposal);
    } catch (error) {
      this.options.log(`The controller could not be stopped cleanly: ${describe(error)}`);
    }
  }

  private onRemoteState(remote: RemoteState): void {
    // A leader shows its own controller's state, never one that came over the wire.
    if (this.snapshot.role === 'leader' || this.disposal !== null) return;
    this.snapshot = {
      role: this.snapshot.role,
      state: remote.state,
      limited: remote.limited === true,
      receivedAtMono: remote.receivedAtMono,
    };
    this.changed();
  }

  // ----- Stop / Cancel that nobody confirmed ---------------------------------------------------

  /** The user asked for "this PC stays on" and no leader said "done": the brake says it instead. */
  private onSafeCommandStuck(): void {
    const { stateDir, self } = this.options;
    const inPlace = stateDir.createAutoStop(self.windowId);
    const outcome = !inPlace ? 'failed' : stateDir.stopStatus().auto ? 'set' : 'alreadySet';
    if (outcome === this.autoStop) return;
    this.autoStop = outcome;
    this.options.log(
      outcome === 'failed'
        ? 'A Stop or Cancel from this window was not confirmed, and Emergency stop could not be set.'
        : 'A Stop or Cancel from this window was not confirmed. Emergency stop is set.',
    );
    this.announce(outcome);
    this.changed();
  }

  private onSafeCommandsDelivered(): void {
    if (this.autoStop === null) return;
    const { stateDir, self } = this.options;
    const wasOurs = this.autoStop === 'set';
    // Removes the file only when this window wrote it; a STOP somebody else created stays.
    stateDir.clearAutoStop(self.windowId);
    this.autoStop = null;
    if (wasOurs && !stateDir.stopStatus().present) {
      this.options.log('The Stop or Cancel was confirmed. The Emergency stop this window had set is removed.');
      this.announce('cleared');
    }
    this.changed();
  }

  // ----- exit ----------------------------------------------------------------------------------

  private async shutDown(): Promise<void> {
    let handedOver = false;
    try {
      // The listeners stay attached: a Stop or Cancel that is still unconfirmed is reported as
      // stuck from inside this call, and must still become an Emergency stop file.
      ({ handedOver } = await this.options.coordinator.dispose());
    } catch (error) {
      this.options.log(`The goodbye to the other windows failed: ${describe(error)}`);
    }
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changeListeners.clear();
    this.autoStopListeners.clear();
    const leader = this.leader;
    this.leader = null;
    if (leader !== null) await this.release(leader, { handedOver });
  }

  // ----- listeners -----------------------------------------------------------------------------

  private changed(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch (error) {
        this.options.log(`A surface could not be updated: ${describe(error)}`);
      }
    }
  }

  private announce(outcome: AutoStopOutcome): void {
    for (const listener of [...this.autoStopListeners]) {
      try {
        listener(outcome);
      } catch (error) {
        this.options.log(`The Emergency stop notice could not be shown: ${describe(error)}`);
      }
    }
  }
}
