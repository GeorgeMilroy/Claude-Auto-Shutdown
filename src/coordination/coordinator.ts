// Several editor windows (each its own extension host, possibly different editors and extension
// versions) share one machine. Exactly one of them - the LEADER - may watch and act.
//
// Leadership = holding the listening end of one fixed local endpoint (Windows named pipe, POSIX
// unix socket). The kernel releases it when the process dies, so there are no heartbeats, no
// timestamps, no PID checks and nothing to steal. Every other window is a connected FOLLOWER that
// renders the state the leader pushes and sends commands over the same connection. The endpoint
// name is public, so both ends first prove they belong to the same user (auth.ts); a stranger
// holding the name is never followed, and leaves this window isolated.
//
// This class is the election and the routing between the two roles. The leader's end of the
// connection is leader.ts, a follower's is follower.ts, the OS part is endpoint.ts.

import type * as net from 'node:net';

import type {
  Command,
  CommandResult,
  HandoverPayload,
  LeaderInfo,
  Role,
  UiState,
  WindowHello,
} from '../shared/protocol';
import { isSecret } from './auth';
import { Emitter, type Disposable } from './emitter';
import { PipeClaimer, releaseClaim, retry, type Claim, type EndpointClaimer } from './endpoint';
import { FollowerLink } from './follower';
import { LeaderSide } from './leader';
import { SocketClaimer } from './posixEndpoint';
import { CLOSING, describeError, NOT_CONNECTED, OTHER_VERSION } from './replies';
import { PendingSafeCommands, type PendingSafeCommand } from './safeCommands';
import {
  between,
  HANDOVER_VALID_MS,
  ISOLATED_AFTER_ROUNDS,
  ISOLATED_RETRY_MS,
  REELECT_BEHIND_SUCCESSOR_MS,
  REELECT_JITTER_MS,
  RETRY_JITTER_MS,
  TimerSet,
  type Range,
  type TimerHandle,
} from './timing';
import { isSafeCommand } from './wire';

export type { Disposable } from './emitter';

export interface CoordinatorOptions {
  /** From resolveEndpoint(): pipe name (Windows) or socket path (POSIX). */
  endpoint: string;
  self: WindowHello;
  /** Protocol version spoken by this window (PROTOCOL_VERSION; tests inject others). */
  protocolVersion: number;
  /**
   * StateDir.secret(): what every window of this user proves it knows before the endpoint is
   * trusted in either direction (auth.ts). null = unreadable: this window stays isolated.
   */
  secret: string | null;
  /** level 'warn': why this window can't coordinate (watching is off in it), worth showing by default. */
  log(message: string, level?: 'warn'): void;
}

/** Seams for tests. Production code passes none of them. */
export interface CoordinatorInternals {
  /** How the endpoint is claimed. Default: a named pipe on Windows, a unix socket elsewhere. */
  claimer?: EndpointClaimer;
  /** Source of jitter, in [0, 1). */
  random?: () => number;
}

/** What the leader side needs from the controller. Set before start(). */
export interface LeaderHandlers {
  /** Run a command (from a follower, or from this window via send()). */
  handleCommand(command: Command, from: WindowHello): Promise<CommandResult>;
  /**
   * State for a follower that just connected, and for the keepalive while nothing else is
   * published. null = no controller is up in this window (yet): the follower is not welcomed.
   */
  currentState(): UiState | null;
  /**
   * Called once when this leader window is closing gracefully. Returns the armed state to offer
   * to a sibling window, or null when not watching. After it returns no more commands are passed
   * to handleCommand.
   */
  beginHandover(): HandoverPayload | null;
}

export interface RoleChange {
  role: Role;
  /**
   * Only when role === 'leader': armed state accepted from a sibling window that closed
   * gracefully a moment ago. null = start not watching.
   */
  handover: HandoverPayload | null;
  /**
   * Only when role === 'leader': the last state this window saw from the previous leader said
   * "watching", and that leader is gone without a handover. The UI must say so loudly.
   */
  previousLeaderWasWatching: boolean;
}

export interface RemoteState {
  /**
   * State pushed by the leader on the CURRENT connection; null while electing, reconnecting,
   * isolated, or when nothing has arrived for too long. Never a stale state.
   */
  state: UiState | null;
  leader: LeaderInfo | null;
  /** The leader speaks another protocol version: only phase / countdown / cancel / disarm work. */
  limited: boolean;
  /** performance.now() when `state` arrived (anchor for countdown.remainingMs). */
  receivedAtMono: number;
}

export interface Peer {
  hello: WindowHello;
  /** Its dashboard is visible. */
  viewVisible: boolean;
}

function createClaimer(endpoint: string): EndpointClaimer {
  return process.platform === 'win32' ? new PipeClaimer(endpoint) : new SocketClaimer(endpoint);
}

function notLeading(role: Exclude<Role, 'leader'>): RoleChange {
  return { role, handover: null, previousLeaderWasWatching: false };
}

const ROLE_SENTENCES: Record<Role, string> = {
  electing: 'Looking for the window in control.',
  leader: 'This window is now in control.',
  follower: 'Connected to the window in control.',
  isolated: "Can't reach the other windows. Watching is off in this window.",
};

const NO_SECRET = "Can't read or create the secret file in the state folder, so this window can't coordinate.";

export class Coordinator {
  private readonly options: CoordinatorOptions;
  /** null = no usable secret: this window never claims, follows or leads anything. */
  private readonly secret: string | null;
  private readonly claimer: EndpointClaimer;
  private readonly random: () => number;
  private readonly timers = new TimerSet();
  private readonly safeCommands: PendingSafeCommands;

  private readonly roleChanges: Emitter<RoleChange>;
  private readonly remoteStates: Emitter<RemoteState>;
  private readonly peerChanges: Emitter<void>;
  private readonly stuckSafeCommands: Emitter<Command>;
  private readonly deliveredSafeCommands: Emitter<void>;

  private handlers: LeaderHandlers | null = null;
  private currentRole: Role = 'electing';
  private started = false;
  private closing = false;
  private disposal: Promise<{ handedOver: boolean }> | null = null;

  /** The election round in flight. A round that is no longer this one has lost its claim. */
  private round: AbortController | null = null;
  private roundTimer: TimerHandle | null = null;
  private failedRounds = 0;
  private leader: LeaderSide | null = null;
  private link: FollowerLink | null = null;

  /** Armed state accepted from a closing leader. Good for the next election only, if won. */
  private heldHandover: { payload: HandoverPayload; expiry: TimerHandle | null } | null = null;
  /** The last state received from the leader this window followed last said "watching". */
  private previousLeaderWasArmed = false;
  private viewVisible = false;

  constructor(options: CoordinatorOptions, internals: CoordinatorInternals = {}) {
    this.options = options;
    this.secret = isSecret(options.secret) ? options.secret : null;
    this.claimer = internals.claimer ?? createClaimer(options.endpoint);
    this.random = internals.random ?? Math.random;

    const onListenerError = (error: unknown): void => this.log(`A listener failed: ${describeError(error)}`);
    this.roleChanges = new Emitter(onListenerError);
    this.remoteStates = new Emitter(onListenerError);
    this.peerChanges = new Emitter(onListenerError);
    this.stuckSafeCommands = new Emitter(onListenerError);
    this.deliveredSafeCommands = new Emitter(onListenerError);
    this.safeCommands = new PendingSafeCommands({
      stuck: (command) => this.stuckSafeCommands.emit(command),
      delivered: () => this.deliveredSafeCommands.emit(),
    });
  }

  setLeaderHandlers(handlers: LeaderHandlers): void {
    this.handlers = handlers;
  }

  /** Begin electing. Role changes arrive through onRole. */
  start(): void {
    this.requireHandlers();
    if (this.started || this.closing) return;
    this.started = true;
    if (this.secret === null) {
      // Without it no window can be told from a stranger, so none is trusted: not even to lead.
      this.log(NO_SECRET, 'warn');
      this.setRole(notLeading('isolated'));
      return;
    }
    this.startRound();
  }

  get role(): Role {
    return this.currentRole;
  }

  onRole(listener: (change: RoleChange) => void): Disposable {
    return this.roleChanges.on(listener);
  }

  /** Follower side: state from the leader (see RemoteState). */
  onRemoteState(listener: (remote: RemoteState) => void): Disposable {
    return this.remoteStates.on(listener);
  }

  /** Leader side: connected follower windows (this window is not included). */
  peers(): Peer[] {
    return this.leader?.peers() ?? [];
  }

  onPeersChanged(listener: () => void): Disposable {
    return this.peerChanges.on(listener);
  }

  /** Leader side: push state to every follower. Cheap to call often; a no-op for followers. */
  publish(state: UiState): void {
    this.leader?.publish(state);
  }

  /**
   * Send a command to whoever leads (this window's own handlers when it is the leader).
   * Resolves with the leader's answer. Never rejects: unreachable = { ok: false, error }.
   * 'disarm' and 'cancel' are kept pending and re-sent to a new leader until acknowledged;
   * everything else is never retried.
   */
  send(command: Command): Promise<CommandResult> {
    if (this.closing) {
      // A Stop or Cancel is never dropped silently: nobody will confirm this one, so it is stuck.
      if (isSafeCommand(command)) this.stuckSafeCommands.emit(command);
      return Promise.resolve({ ok: false, error: CLOSING });
    }
    if (isSafeCommand(command)) return this.sendSafe(command);
    if (this.leader !== null) return this.leader.runLocal(command);
    if (this.link === null || !this.link.welcomed) return Promise.resolve({ ok: false, error: NOT_CONNECTED });
    if (this.link.limited) return Promise.resolve({ ok: false, error: OTHER_VERSION });
    return this.link.request(command);
  }

  /**
   * A 'disarm' / 'cancel' sent from this window has not been acknowledged for 2 s (or this window
   * is closing with one pending). The caller sets Emergency stop on the user's behalf.
   */
  onSafeCommandStuck(listener: (command: Command) => void): Disposable {
    return this.stuckSafeCommands.on(listener);
  }

  /** Every pending 'disarm' / 'cancel' from this window has now been acknowledged. */
  onSafeCommandsDelivered(listener: () => void): Disposable {
    return this.deliveredSafeCommands.on(listener);
  }

  /** Follower side: tell the leader whether this window's dashboard is visible. */
  setViewVisible(visible: boolean): void {
    if (this.viewVisible === visible) return;
    this.viewVisible = visible;
    if (this.link?.welcomed) this.link.sendView(visible);
  }

  /** Leader side: this process still holds the endpoint (final gate before a power action). */
  stillOwnsEndpoint(): boolean {
    // A leader that has started its goodbye is about to release the endpoint: it must not act.
    return !this.closing && this.leader !== null && this.leader.ownsEndpoint();
  }

  /**
   * Graceful exit (window closing, <= 1 s): as leader, stop taking commands, offer armed state to
   * a connected sibling, say goodbye, destroy every socket and close the server. As follower,
   * close the connection. Resolves with whether armed state was handed over.
   */
  dispose(): Promise<{ handedOver: boolean }> {
    if (this.disposal === null) {
      this.closing = true;
      this.disposal = this.shutDown();
    }
    return this.disposal;
  }

  // ----- election ------------------------------------------------------------------------------

  private startRound(): void {
    void this.runRound().catch((error: unknown) => {
      this.log(`The election failed unexpectedly: ${describeError(error)}`);
    });
  }

  private scheduleRound(delayMs: number): void {
    this.timers.clear(this.roundTimer);
    this.roundTimer = null;
    if (this.closing) return;
    if (delayMs <= 0) {
      this.startRound();
      return;
    }
    this.roundTimer = this.timers.set(() => {
      this.roundTimer = null;
      this.startRound();
    }, delayMs);
  }

  private async runRound(): Promise<void> {
    const { secret } = this;
    if (secret === null) return;
    const round = new AbortController();
    this.round = round;
    let claim: Claim;
    try {
      claim = await this.claimer.attempt(round.signal);
    } catch (error) {
      claim = retry(describeError(error));
    }
    if (this.round !== round) {
      releaseClaim(claim);
      return;
    }
    this.round = null;
    if (claim.kind === 'leader') this.becomeLeader(claim.server, claim.stillOwned, secret);
    else if (claim.kind === 'follower') this.greet(claim.socket, secret);
    else this.roundFailed(claim.reason, claim.delayMs);
  }

  /** Ten rounds without a role: say so (arming is off in an isolated window) and keep trying, slowly. */
  private roundFailed(reason: string, delayMs: Range = RETRY_JITTER_MS): void {
    this.failedRounds += 1;
    if (this.failedRounds < ISOLATED_AFTER_ROUNDS) {
      this.scheduleRound(between(delayMs, this.random));
      return;
    }
    this.isolate(reason);
  }

  /** Until a round succeeds, every further failure waits the slow 5 s as well. */
  private isolate(reason: string): void {
    if (this.currentRole !== 'isolated') {
      this.log(`This window can neither reach a leader nor become one: ${reason}.`, 'warn');
    }
    this.failedRounds = Math.max(this.failedRounds, ISOLATED_AFTER_ROUNDS);
    this.setRole(notLeading('isolated'));
    this.scheduleRound(ISOLATED_RETRY_MS);
  }

  private setRole(change: RoleChange): void {
    if (change.role === this.currentRole) return;
    this.currentRole = change.role;
    this.log(ROLE_SENTENCES[change.role]);
    this.roleChanges.emit(change);
  }

  // ----- leading -------------------------------------------------------------------------------

  private becomeLeader(server: net.Server, stillOwned: () => boolean, secret: string): void {
    const offered = this.takeHeldHandover();
    // A Stop or Cancel from this window that nobody confirmed outranks armed state offered to it.
    const handover = this.safeCommands.size === 0 ? offered : null;
    if (offered !== null && handover === null) {
      this.log('Not taking over watching: a Stop or Cancel from this window was still unconfirmed.');
    }
    const previousLeaderWasWatching = handover === null && this.previousLeaderWasArmed;
    this.previousLeaderWasArmed = false;
    this.failedRounds = 0;
    this.leader = new LeaderSide({
      server,
      stillOwned,
      self: this.options.self,
      protocolVersion: this.options.protocolVersion,
      secret,
      handlers: this.requireHandlers(),
      log: (message) => this.log(message),
      onPeersChanged: () => {
        if (!this.closing) this.peerChanges.emit();
      },
      onEndpointLost: () => this.stepDown(),
    });
    this.setRole({ role: 'leader', handover, previousLeaderWasWatching });
    // This window is the "new leader" its own unconfirmed Stop / Cancel was waiting for.
    for (const pending of this.safeCommands.pending()) this.dispatchSafe(pending);
  }

  /** A window never acts as leader without holding the endpoint. */
  private stepDown(): void {
    if (this.closing || this.leader === null) return;
    this.leader.close();
    this.leader = null;
    this.log('This window lost the leadership endpoint and is stepping down.');
    this.failedRounds = 0;
    this.setRole(notLeading('electing'));
    this.scheduleRound(between(RETRY_JITTER_MS, this.random));
  }

  private requireHandlers(): LeaderHandlers {
    if (this.handlers === null) throw new Error('Coordinator: call setLeaderHandlers() before start()');
    return this.handlers;
  }

  // ----- following -----------------------------------------------------------------------------

  private greet(socket: net.Socket, secret: string): void {
    this.link = new FollowerLink({
      socket,
      self: this.options.self,
      protocolVersion: this.options.protocolVersion,
      secret,
      log: (message) => this.log(message),
      events: {
        welcomed: (link) => this.onWelcomed(link),
        remoteChanged: (remote) => this.remoteStates.emit(remote),
        handoverOffered: (payload) => this.acceptHandover(payload),
        leaderLeaving: (successor) => this.onLeaderLeaving(successor),
        answered: (id, result) => this.safeCommands.answered(id, result),
        closed: (link) => this.onLinkClosed(link),
      },
    });
  }

  private onWelcomed(link: FollowerLink): void {
    if (this.link !== link) return;
    this.dropHeldHandover('another window became the leader');
    this.failedRounds = 0;
    this.setRole(notLeading('follower'));
    if (this.link !== link) return;
    if (this.viewVisible) link.sendView(true);
    for (const pending of this.safeCommands.pending()) link.sendCommand(pending.id, pending.command);
  }

  private onLinkClosed(link: FollowerLink): void {
    if (this.link !== link) return;
    this.link = null;
    // Whoever holds the endpoint keeps the name taken, so this window can't lead either.
    if (link.distrusted !== null) {
      this.isolate(`the window holding the endpoint is not trusted (${link.distrusted})`);
      return;
    }
    if (!link.welcomed) {
      this.roundFailed('the leader did not welcome this window');
      return;
    }
    this.previousLeaderWasArmed = link.leaderWasArmed;
    // Reconnecting: from this moment the last leader's state is history and must not be shown.
    this.remoteStates.emit({ state: null, leader: null, limited: false, receivedAtMono: performance.now() });
    this.failedRounds = 0;
    this.setRole(notLeading('electing'));
    this.scheduleRound(this.reelectionDelay(link.namedSuccessor));
  }

  /**
   * The window that took the armed state goes first, everybody else gives it a head start, and
   * after a crash a little jitter spreads the survivors out.
   */
  private reelectionDelay(namedSuccessor: string | null | undefined): number {
    if (this.heldHandover !== null || namedSuccessor === this.options.self.windowId) return 0;
    if (typeof namedSuccessor === 'string') return between(REELECT_BEHIND_SUCCESSOR_MS, this.random);
    return between(REELECT_JITTER_MS, this.random);
  }

  // ----- handover (receiving side) -------------------------------------------------------------

  private acceptHandover(payload: HandoverPayload): boolean {
    if (this.closing || this.safeCommands.size > 0) return false;
    this.dropHeldHandover(null);
    const expiry = this.timers.set(
      () => this.dropHeldHandover('the closing window did not release control in time'),
      HANDOVER_VALID_MS,
    );
    this.heldHandover = { payload, expiry };
    return true;
  }

  private onLeaderLeaving(successor: string | null): void {
    if (successor !== this.options.self.windowId) this.dropHeldHandover('the closing window chose another successor');
  }

  /** An accepted handover that is not used at once is dropped: armed state must never resurface later. */
  private dropHeldHandover(reason: string | null): void {
    if (this.heldHandover === null) return;
    this.timers.clear(this.heldHandover.expiry);
    this.heldHandover = null;
    if (reason !== null) this.log(`Discarding the watching state offered by a closing window: ${reason}.`);
  }

  private takeHeldHandover(): HandoverPayload | null {
    const payload = this.heldHandover?.payload ?? null;
    this.dropHeldHandover(null);
    return payload;
  }

  // ----- commands ------------------------------------------------------------------------------

  private sendSafe(command: Command): Promise<CommandResult> {
    const { pending, answer } = this.safeCommands.add(command);
    this.dispatchSafe(pending);
    return answer;
  }

  /** With nobody to tell (electing, isolated) the command just stays pending for the next leader. */
  private dispatchSafe(pending: PendingSafeCommand): void {
    if (this.leader !== null) {
      void this.leader.runLocal(pending.command).then((result) => this.safeCommands.answered(pending.id, result));
    } else if (this.link?.welcomed) {
      this.link.sendCommand(pending.id, pending.command);
    }
  }

  // ----- exit ----------------------------------------------------------------------------------

  private async shutDown(): Promise<{ handedOver: boolean }> {
    this.round?.abort();
    this.round = null;
    this.timers.dispose();
    this.heldHandover = null;
    // Synchronously, before the goodbye: the caller sets Emergency stop for what is still unconfirmed.
    this.safeCommands.abandon(CLOSING);
    this.link?.close();
    this.link = null;

    const leader = this.leader;
    if (leader === null) return { handedOver: false };
    try {
      return await leader.leave();
    } catch (error) {
      this.log(`The goodbye failed: ${describeError(error)}`);
      leader.close();
      return { handedOver: false };
    } finally {
      this.leader = null;
    }
  }

  private log(message: string, level?: 'warn'): void {
    try {
      this.options.log(message, level);
    } catch {
      // a broken log sink must not break coordination
    }
  }
}
