// The leader's end of the endpoint: it accepts the other windows, pushes state to them, runs their
// commands through the controller, and says goodbye properly when its own window closes.

import type * as net from 'node:net';

import type { Command, CommandResult, HandoverPayload, UiState, WindowHello } from '../shared/protocol';
import { helloProof, proofMatches, welcomeProof } from './auth';
import type { LeaderHandlers, Peer } from './coordinator';
import { encodeLine, readObjects, type OutgoingMessage, type WireObject } from './framing';
import { CLOSING, describeError, HANDLER_FAILED, OTHER_VERSION, REFUSED, UNREADABLE_COMMAND } from './replies';
import {
  CONGESTED_BYTES,
  HANDOVER_BUDGET_MS,
  HANDOVER_OFFER_MS,
  HELLO_TIMEOUT_MS,
  KEEPALIVE_MS,
  LEAVING_FLUSH_MS,
  RECENT_COMMANDS,
  TimerSet,
  type TimerHandle,
} from './timing';
import { MAX_STATE_BYTES, trimForWire } from './trimState';
import { isSafeCommand, leaderInfoOf, readClientFrame, readCommand, type ClientFrame } from './wire';

export interface LeaderSideOptions {
  server: net.Server;
  /** Transport-specific re-check that the endpoint is still this process's (see endpoint.ts). */
  stillOwned(): boolean;
  self: WindowHello;
  protocolVersion: number;
  /** The per-user secret (see auth.ts): a connection that can't prove it knows it is dropped. */
  secret: string;
  handlers: LeaderHandlers;
  log(message: string): void;
  onPeersChanged(): void;
  /** The endpoint is gone or no longer ours: this window must stop acting as leader. */
  onEndpointLost(): void;
}

interface Connection {
  readonly socket: net.Socket;
  /** Set by the hello. Nothing else a connection sends counts before it. */
  hello: WindowHello | null;
  version: number | null;
  viewVisible: boolean;
  helloTimer: TimerHandle | null;
  /** Newest state held back while this socket is congested; sent when it drains. */
  heldState: string | null;
  reportedIgnoredMessage: boolean;
}

type Follower = Connection & { hello: WindowHello };

type HelloFrame = Extract<ClientFrame, { t: 'hello' }>;

/** How the last state went out: whole, trimmed to fit, or not at all. */
type StateFit = 'whole' | 'trimmed' | 'tooLarge';

const STATE_FIT_SENTENCES: Record<Exclude<StateFit, 'whole'>, string> = {
  trimmed:
    'The state is larger than one message between windows (256 KB): the other windows get it with detail left out.',
  tooLarge: "The state is too large to send to the other windows even trimmed; they will show that they can't tell.",
};

function isFollower(connection: Connection): connection is Follower {
  return connection.hello !== null;
}

const ignoreSocketError = (): void => undefined;

export class LeaderSide {
  private readonly options: LeaderSideOptions;
  /** Insertion order = connection order, which is the order a handover is offered in. */
  private readonly connections = new Set<Connection>();
  private readonly timers = new TimerSet();
  /** Answers by `<window>\n<command id>`, so a command that is sent twice runs once. */
  private readonly recentCommands = new Map<string, Promise<CommandResult>>();
  private keepalive: TimerHandle | null = null;
  private offer: { to: Connection; settle(accepted: boolean): void } | null = null;
  /** The handover has begun: commands are no longer run or answered. */
  private frozen = false;
  private closed = false;
  private endpointLost = false;
  private stateFit: StateFit = 'whole';

  constructor(options: LeaderSideOptions) {
    this.options = options;
    const { server } = options;
    server.on('connection', (socket) => this.accept(socket));
    server.on('error', (error) => {
      options.log(`The leadership endpoint failed: ${error.message}`);
      this.reportEndpointLost();
    });
    server.on('close', () => this.reportEndpointLost());
  }

  /** Connected follower windows, oldest connection first. */
  peers(): Peer[] {
    return this.followers().map(({ hello, viewVisible }) => ({ hello, viewVisible }));
  }

  /**
   * Final-gate check. A leader that finds the endpoint gone (server closed, or on POSIX the
   * socket file replaced) answers "no" and steps down right after.
   */
  ownsEndpoint(): boolean {
    if (this.closed || this.endpointLost) return false;
    if (this.options.server.listening && this.options.stillOwned()) return true;
    this.options.log('This window no longer holds the leadership endpoint.');
    this.reportEndpointLost();
    return false;
  }

  /** Called every engine cycle, which makes it the periodic ownership re-check as well. */
  publish(state: UiState): void {
    if (this.closed || !this.ownsEndpoint()) return;
    const followers = this.followers();
    if (followers.length === 0) return;
    const line = this.encodeState(state, (wire) => ({ t: 'state', state: wire }));
    if (line !== null) for (const follower of followers) this.pushState(follower, line);
    this.restartKeepalive();
  }

  /** A command from this window itself. */
  runLocal(command: Command): Promise<CommandResult> {
    if (this.frozen) return Promise.resolve({ ok: false, error: CLOSING });
    return this.execute(command, this.options.self);
  }

  /**
   * Graceful exit: stop taking commands, offer the armed state to a sibling, tell everybody who
   * (if anybody) took it, release the endpoint.
   */
  async leave(): Promise<{ handedOver: boolean }> {
    this.frozen = true;
    this.stopKeepalive();
    const payload = this.beginHandover();
    const successor = payload === null ? null : await this.offerHandover(payload);
    if (payload !== null && successor === null) {
      this.options.log('armed-dropped: this window was watching and no other window took over.');
    }
    await this.announceLeaving(successor === null ? null : successor.hello.windowId);
    this.close(successor);
    return { handedOver: successor !== null };
  }

  /** Releases the endpoint at once, without a goodbye. */
  close(successor: Connection | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.offer?.settle(false);
    this.timers.dispose();
    const connections = [...this.connections];
    this.connections.clear();
    // Windows keeps a pipe name taken while any accepted connection is open, so closing the server
    // is not enough. The server goes first so nobody can connect to a leader that is leaving.
    this.options.server.close();
    for (const connection of connections) {
      if (connection !== successor) connection.socket.destroy();
    }
    // Last, so the endpoint is already free when the successor notices and tries to listen.
    successor?.socket.destroy();
  }

  private followers(): Follower[] {
    return [...this.connections].filter(isFollower);
  }

  private reportEndpointLost(): void {
    if (this.closed || this.endpointLost) return;
    this.endpointLost = true;
    // Deferred: this can be reached from inside the controller's final gate.
    queueMicrotask(() => {
      if (!this.closed) this.options.onEndpointLost();
    });
  }

  // ----- connections ---------------------------------------------------------------------------

  private accept(socket: net.Socket): void {
    socket.on('error', ignoreSocketError);
    if (this.closed || this.frozen) {
      socket.destroy();
      return;
    }
    const connection: Connection = {
      socket,
      hello: null,
      version: null,
      viewVisible: false,
      helloTimer: null,
      heldState: null,
      reportedIgnoredMessage: false,
    };
    connection.helloTimer = this.timers.set(
      () => this.drop(connection, 'it did not say hello within 2 s'),
      HELLO_TIMEOUT_MS,
    );
    this.connections.add(connection);
    readObjects(
      socket,
      (frame) => this.onFrame(connection, frame),
      (reason) => this.drop(connection, `it sent ${reason}`),
    );
    socket.on('drain', () => this.sendHeldState(connection));
    socket.on('close', () => this.forget(connection));
  }

  private drop(connection: Connection, reason: string): void {
    this.options.log(`Closing a connection from ${describeConnection(connection)}: ${reason}.`);
    this.forget(connection);
    connection.socket.destroy();
  }

  private forget(connection: Connection): void {
    this.timers.clear(connection.helloTimer);
    connection.helloTimer = null;
    if (!this.connections.delete(connection)) return;
    if (this.offer?.to === connection) this.offer.settle(false);
    if (!isFollower(connection)) return;
    if (this.followers().length === 0) this.stopKeepalive();
    this.options.onPeersChanged();
  }

  private onFrame(connection: Connection, frame: WireObject): void {
    // A connection that was dropped stays dropped, whatever still arrives on it.
    if (!this.connections.has(connection)) return;
    const message = readClientFrame(frame);
    if (message === null) {
      this.reportIgnoredMessage(connection, frame);
      return;
    }
    if (!isFollower(connection)) {
      if (message.t === 'hello') this.welcome(connection, message);
      return;
    }
    switch (message.t) {
      case 'hello':
        return; // one hello per connection
      case 'view':
        this.setViewVisible(connection, message.visible);
        return;
      case 'cmd':
        this.onCommand(connection, message.id, message.cmd);
        return;
      case 'handoverAck':
        if (this.offer?.to === connection) this.offer.settle(message.ok);
        return;
    }
  }

  /** Other versions may send messages this one does not know. Say so once, not once per message. */
  private reportIgnoredMessage(connection: Connection, frame: WireObject): void {
    if (connection.reportedIgnoredMessage) return;
    connection.reportedIgnoredMessage = true;
    const type = typeof frame.t === 'string' ? frame.t.slice(0, 40) : 'no type';
    this.options.log(`Ignoring messages this version can't use from ${describeConnection(connection)} (${type}).`);
  }

  private welcome(connection: Connection, frame: HelloFrame): void {
    if (!this.provesSecret(frame)) {
      this.drop(connection, "it could not prove that it runs as this user, so it is not one of this user's windows");
      return;
    }
    const { hello, nonce } = frame;
    if (hello.windowId === this.options.self.windowId) {
      this.drop(connection, 'it claims to be this window');
      return;
    }
    const line = this.welcomeLine(nonce);
    if (line === null) {
      this.drop(connection, 'there is no state it could be welcomed with');
      return;
    }
    // A window that reconnects before its old connection was seen closing must not count twice.
    for (const other of this.followers()) {
      if (other.hello.windowId === hello.windowId) this.drop(other, 'the same window connected again');
    }
    this.timers.clear(connection.helloTimer);
    connection.helloTimer = null;
    connection.hello = hello;
    connection.version = frame.v;
    connection.socket.write(line);
    // Only when none is running: a new window must not postpone the next sign of life for the others.
    if (this.keepalive === null) this.restartKeepalive();
    this.options.onPeersChanged();
  }

  private provesSecret(frame: HelloFrame): frame is HelloFrame & { nonce: string } {
    const { hello, nonce, proof } = frame;
    return nonce !== null && proofMatches(helloProof(this.options.secret, hello.windowId, nonce), proof);
  }

  /** The welcome answers the hello's nonce, which proves to the window that this leader is genuine. */
  private welcomeLine(nonce: string): string | null {
    const { protocolVersion, self, secret } = this.options;
    const state = this.currentState();
    if (state === null) return null;
    const { epoch } = state;
    const leader = leaderInfoOf(self);
    const proof = welcomeProof(secret, epoch, nonce);
    return this.encodeState(state, (wire) => ({ t: 'welcome', v: protocolVersion, epoch, leader, state: wire, proof }));
  }

  /** The controller's state, or null when it has none to give right now (the reason is logged). */
  private currentState(): UiState | null {
    try {
      const state = this.options.handlers.currentState();
      if (state !== null && typeof state === 'object') return state;
      this.options.log('The controller has no state to share yet.');
    } catch (error) {
      this.options.log(`Can't read the current state: ${describeError(error)}`);
    }
    return null;
  }

  private setViewVisible(follower: Follower, visible: boolean): void {
    if (follower.viewVisible === visible) return;
    follower.viewVisible = visible;
    this.options.onPeersChanged();
  }

  // ----- state ---------------------------------------------------------------------------------

  /**
   * A follower whose extension host is stalled (a debugger, a busy extension) stops reading. States
   * are snapshots, so instead of queueing every one in memory only the newest is kept for it.
   */
  private pushState(follower: Follower, line: string): void {
    if (follower.socket.writableLength > CONGESTED_BYTES) {
      follower.heldState = line;
      return;
    }
    follower.heldState = null;
    follower.socket.write(line);
  }

  private sendHeldState(connection: Connection): void {
    const line = connection.heldState;
    if (line === null || connection.socket.destroyed) return;
    connection.heldState = null;
    connection.socket.write(line);
  }

  /**
   * One line carrying `state`, trimmed for the wire (trimState.ts) when the whole state would not
   * fit. null = not even the trimmed state fits.
   */
  private encodeState(state: UiState, message: (state: UiState) => OutgoingMessage): string | null {
    const whole = encodeLine(message(state));
    if (whole !== null) {
      this.reportStateFit('whole');
      return whole;
    }
    const trimmed = encodeLine(message(trimForWire(state, MAX_STATE_BYTES)));
    this.reportStateFit(trimmed === null ? 'tooLarge' : 'trimmed');
    return trimmed;
  }

  /** Said when it changes, not once per publish. */
  private reportStateFit(fit: StateFit): void {
    if (fit === this.stateFit) return;
    this.stateFit = fit;
    if (fit !== 'whole') this.options.log(STATE_FIT_SENTENCES[fit]);
  }

  /**
   * Followers treat silence as "the leader stopped answering". The controller only publishes
   * while its engine runs, so with followers connected the leader sends the current state itself
   * whenever nothing went out for 10 s. No followers, no timer.
   */
  private restartKeepalive(): void {
    this.stopKeepalive();
    if (this.frozen || this.followers().length === 0) return;
    this.keepalive = this.timers.set(() => this.sendKeepalive(), KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    this.timers.clear(this.keepalive);
    this.keepalive = null;
  }

  private sendKeepalive(): void {
    this.keepalive = null;
    const state = this.currentState();
    if (state === null) this.restartKeepalive();
    else this.publish(state);
  }

  // ----- commands ------------------------------------------------------------------------------

  private onCommand(from: Follower, id: string, raw: unknown): void {
    // Once the handover has begun this leader's word no longer counts. No answer either: a Cancel
    // or Stop then stays pending in its window and goes to the next leader.
    if (this.frozen) return;
    const command = readCommand(raw);
    if (command === null) {
      this.acknowledge(from, id, { ok: false, error: UNREADABLE_COMMAND });
      return;
    }
    if (from.version !== this.options.protocolVersion && !isSafeCommand(command)) {
      this.acknowledge(from, id, { ok: false, error: OTHER_VERSION });
      return;
    }
    const key = `${from.hello.windowId}\n${id}`;
    let outcome = this.recentCommands.get(key);
    if (outcome === undefined) {
      outcome = this.execute(command, from.hello);
      this.remember(key, outcome);
    }
    void outcome.then((result) => this.acknowledge(from, id, result));
  }

  private remember(key: string, outcome: Promise<CommandResult>): void {
    this.recentCommands.set(key, outcome);
    if (this.recentCommands.size <= RECENT_COMMANDS) return;
    for (const oldest of this.recentCommands.keys()) {
      this.recentCommands.delete(oldest);
      break;
    }
  }

  /** Never rejects: a controller that throws is a refusal, not a crash of the connection. */
  private async execute(command: Command, from: WindowHello): Promise<CommandResult> {
    try {
      const result = await this.options.handlers.handleCommand(command, from);
      if (result.ok === true) return { ok: true };
      return { ok: false, error: typeof result.error === 'string' && result.error ? result.error : REFUSED };
    } catch (error) {
      this.options.log(`Command '${command.name}' failed: ${describeError(error)}`);
      return { ok: false, error: HANDLER_FAILED };
    }
  }

  private acknowledge(to: Connection, id: string, result: CommandResult): void {
    if (to.socket.destroyed) return;
    const line = encodeLine(result.ok ? { t: 'ack', id, ok: true } : { t: 'ack', id, ok: false, error: result.error });
    if (line !== null) to.socket.write(line);
  }

  // ----- handover ------------------------------------------------------------------------------

  private beginHandover(): HandoverPayload | null {
    try {
      return this.options.handlers.beginHandover();
    } catch (error) {
      this.options.log(`Can't prepare the handover: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * Oldest connection first, 300 ms each, the first "yes" wins. Only windows of this version are
   * asked: another version may read the armed state differently.
   */
  private async offerHandover(payload: HandoverPayload): Promise<Follower | null> {
    const line = encodeLine({ t: 'handover', payload });
    if (line === null) return null;
    const deadline = performance.now() + HANDOVER_BUDGET_MS;
    const candidates = this.followers().filter((follower) => follower.version === this.options.protocolVersion);
    for (const candidate of candidates) {
      const waitMs = Math.min(HANDOVER_OFFER_MS, deadline - performance.now());
      if (waitMs <= 0 || this.closed) break;
      if (!this.connections.has(candidate)) continue;
      if (await this.offerTo(candidate, line, waitMs)) return candidate;
    }
    return null;
  }

  private offerTo(candidate: Follower, line: string, waitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (accepted: boolean): void => {
        this.timers.clear(timer);
        this.offer = null;
        resolve(accepted);
      };
      const timer = this.timers.set(() => settle(false), waitMs);
      this.offer = { to: candidate, settle };
      candidate.socket.write(line);
    });
  }

  /** Resolves once the goodbye left this process for every follower, or after 100 ms. */
  private announceLeaving(successor: string | null): Promise<void> {
    const followers = this.followers();
    const line = encodeLine({ t: 'leaving', successor });
    if (line === null || followers.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let unflushed = followers.length;
      const timer = this.timers.set(resolve, LEAVING_FLUSH_MS);
      const flushed = (): void => {
        unflushed -= 1;
        if (unflushed > 0) return;
        this.timers.clear(timer);
        resolve();
      };
      for (const follower of followers) follower.socket.write(line, flushed);
    });
  }
}

function describeConnection(connection: Connection): string {
  return connection.hello === null ? 'an unknown window' : `"${connection.hello.label}"`;
}
