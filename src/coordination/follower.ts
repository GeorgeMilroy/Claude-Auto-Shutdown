// A follower's connection to the leader, from "connected" until it closes. One instance per
// connection: nothing learned on an earlier connection is ever shown again.

import { randomUUID } from 'node:crypto';
import type * as net from 'node:net';

import type {
  ClientMessage,
  Command,
  CommandResult,
  HandoverPayload,
  LeaderInfo,
  UiState,
  WindowHello,
} from '../shared/protocol';
import { helloProof, newNonce, proofMatches, welcomeProof, type ProvenHello } from './auth';
import type { RemoteState } from './coordinator';
import { encodeLine, readObjects, type WireObject } from './framing';
import { LEADER_LOST, NO_ANSWER } from './replies';
import {
  ARMED_SILENCE_FLOOR_MS,
  COMMAND_ANSWER_TIMEOUT_MS,
  SILENCE_LIMIT_MS,
  TimerSet,
  WELCOME_TIMEOUT_MS,
  type TimerHandle,
} from './timing';
import {
  pollSecondsOf,
  readHandoverPayload,
  readLeaderInfo,
  readServerFrame,
  readState,
  type ServerFrame,
} from './wire';

export interface FollowerLinkEvents {
  /** The leader answered the hello: this window is now its follower. */
  welcomed(link: FollowerLink): void;
  /** What this window may render changed. */
  remoteChanged(remote: RemoteState): void;
  /** The leader's window is closing and offers its armed state. Return true to accept it. */
  handoverOffered(payload: HandoverPayload): boolean;
  /** The leader said goodbye and named who took its armed state, if anybody. */
  leaderLeaving(successor: string | null): void;
  /** An answer to a command sent with sendCommand(). */
  answered(id: string, result: CommandResult): void;
  /** The connection is gone (see `distrusted` for why a leader was refused). Not raised after close(). */
  closed(link: FollowerLink): void;
}

export interface FollowerLinkOptions {
  socket: net.Socket;
  self: WindowHello;
  protocolVersion: number;
  /** The per-user secret (see auth.ts): a leader that can't prove it knows it is never followed. */
  secret: string;
  log(message: string): void;
  events: FollowerLinkEvents;
}

interface Request {
  resolve(result: CommandResult): void;
  timer: TimerHandle | null;
}

export class FollowerLink {
  private readonly options: FollowerLinkOptions;
  private readonly timers = new TimerSet();
  private readonly requests = new Map<string, Request>();
  /** The challenge of this connection's hello; only a welcome that answers it is believed. */
  private readonly nonce = newNonce();
  private welcomeTimer: TimerHandle | null = null;
  private silenceTimer: TimerHandle | null = null;
  private isWelcomed = false;
  private isLimited = false;
  private leader: LeaderInfo | null = null;
  /** What this window may render right now; null = can't tell. */
  private state: UiState | null = null;
  private lastStateArmed = false;
  private lastStatePollSeconds: number | null = null;
  /** Who the leader named in its goodbye; undefined = it has not said goodbye. */
  private goodbyeSuccessor: string | null | undefined = undefined;
  private detached = false;
  /** The first remote state of this connection has been raised (even a null one is news then). */
  private announced = false;
  private reportedIgnoredMessage = false;
  private distrust: string | null = null;

  constructor(options: FollowerLinkOptions) {
    this.options = options;
    const { socket, self, protocolVersion, secret } = options;
    readObjects(
      socket,
      (frame) => this.onFrame(frame),
      (reason) => this.abort(`the leader sent ${reason}`),
    );
    socket.on('close', () => this.onSocketClosed());
    const proof = helloProof(secret, self.windowId, this.nonce);
    this.write({ t: 'hello', v: protocolVersion, ...self, nonce: this.nonce, proof });
    this.welcomeTimer = this.timers.set(
      () => this.abort('the leader did not answer the hello within 2 s'),
      WELCOME_TIMEOUT_MS,
    );
  }

  get welcomed(): boolean {
    return this.isWelcomed;
  }

  /** The leader speaks another protocol version: only Cancel and Stop watching may be sent. */
  get limited(): boolean {
    return this.isLimited;
  }

  /** The last state this leader sent said "watching" - even if it has gone quiet since. */
  get leaderWasArmed(): boolean {
    return this.lastStateArmed;
  }

  /** Who the leader named in its goodbye: undefined = it never said goodbye. */
  get namedSuccessor(): string | null | undefined {
    return this.goodbyeSuccessor;
  }

  /** Why whoever holds the endpoint was not trusted as the leader; null = it was not refused. */
  get distrusted(): string | null {
    return this.distrust;
  }

  /** Send a command and wait for the leader's answer. Never retried: a lost leader is a "no". */
  request(command: Command): Promise<CommandResult> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = this.timers.set(() => this.settle(id, { ok: false, error: NO_ANSWER }), COMMAND_ANSWER_TIMEOUT_MS);
      this.requests.set(id, { resolve, timer });
      this.sendCommand(id, command);
    });
  }

  /** Send a command whose answer the caller tracks itself (reported through `answered`). */
  sendCommand(id: string, command: Command): void {
    this.write({ t: 'cmd', id, cmd: command });
  }

  sendView(visible: boolean): void {
    this.write({ t: 'view', visible });
  }

  /** Drop the connection from this side. Raises no further events. */
  close(): void {
    if (this.detached) return;
    this.detached = true;
    this.release();
    this.options.socket.destroy();
  }

  private write(message: ClientMessage | ProvenHello): void {
    const { socket } = this.options;
    if (socket.destroyed) return;
    const line = encodeLine(message);
    if (line !== null) socket.write(line);
  }

  private abort(reason: string): void {
    this.options.log(`Dropping the connection to the leader: ${reason}.`);
    this.options.socket.destroy();
  }

  private onSocketClosed(): void {
    if (this.detached) return;
    this.detached = true;
    this.release();
    this.options.events.closed(this);
  }

  private release(): void {
    this.timers.dispose();
    const unanswered = [...this.requests.values()];
    this.requests.clear();
    for (const request of unanswered) request.resolve({ ok: false, error: LEADER_LOST });
  }

  private settle(id: string, result: CommandResult): boolean {
    const request = this.requests.get(id);
    if (request === undefined) return false;
    this.requests.delete(id);
    this.timers.clear(request.timer);
    request.resolve(result);
    return true;
  }

  // ----- messages ------------------------------------------------------------------------------

  private onFrame(frame: WireObject): void {
    if (this.detached) return;
    const message = readServerFrame(frame);
    if (!this.isWelcomed) {
      if (message?.t === 'welcome') this.onWelcome(message);
      return;
    }
    if (message === null) this.reportIgnoredMessage(frame);
    else this.onMessage(message);
    // Any message, even one this version can't use, proves the leader's window is still running.
    this.restartSilenceTimer();
  }

  private onMessage(message: ServerFrame): void {
    switch (message.t) {
      case 'welcome':
        return; // one welcome per connection
      case 'state':
        this.onState(message.state);
        return;
      case 'ack':
        if (!this.settle(message.id, message.result)) this.options.events.answered(message.id, message.result);
        return;
      case 'handover':
        this.onHandover(message.payload);
        return;
      case 'leaving':
        this.goodbyeSuccessor = message.successor;
        this.options.events.leaderLeaving(message.successor);
        return;
    }
  }

  private reportIgnoredMessage(frame: WireObject): void {
    if (this.reportedIgnoredMessage) return;
    this.reportedIgnoredMessage = true;
    const type = typeof frame.t === 'string' ? frame.t.slice(0, 40) : 'no type';
    this.options.log(`Ignoring messages from the leader that this version can't use (${type}).`);
  }

  private onWelcome(welcome: Extract<ServerFrame, { t: 'welcome' }>): void {
    // Before anything in it is read: from any version, an unproven welcome is not a leader.
    if (!this.provesSecret(welcome)) {
      this.distrust = "it could not prove that it runs as this user, so it is not one of this user's windows";
      this.abort(`the window holding the endpoint is not trusted: ${this.distrust}`);
      return;
    }
    const limited = welcome.v !== this.options.protocolVersion;
    const leader = readLeaderInfo(welcome.leader);
    const state = readState(welcome.state, limited);
    // From the same version an unreadable welcome is a broken leader, not a leader to follow.
    if (!limited && (leader === null || state === null)) {
      this.abort('its welcome could not be read');
      return;
    }
    this.timers.clear(this.welcomeTimer);
    this.welcomeTimer = null;
    this.isWelcomed = true;
    this.isLimited = limited;
    this.leader = leader;
    this.options.events.welcomed(this);
    this.show(state);
    this.restartSilenceTimer();
  }

  private provesSecret({ epoch, proof }: Extract<ServerFrame, { t: 'welcome' }>): boolean {
    return epoch !== null && proofMatches(welcomeProof(this.options.secret, epoch, this.nonce), proof);
  }

  private onState(raw: unknown): void {
    const state = readState(raw, this.isLimited);
    if (state === null) this.options.log("The leader sent a state this window can't read.");
    // An unreadable state still replaces the previous one: showing that would be showing the past.
    this.show(state);
  }

  private show(state: UiState | null): void {
    if (this.detached || (state === null && this.state === null && this.announced)) return;
    this.announced = true;
    if (state !== null) {
      this.lastStateArmed = state.armed === true;
      this.lastStatePollSeconds = pollSecondsOf(state);
    }
    this.state = state;
    this.options.events.remoteChanged({
      state,
      leader: this.leader,
      limited: this.isLimited,
      receivedAtMono: performance.now(),
    });
  }

  private onHandover(raw: unknown): void {
    // A limited follower can't be sure it reads the payload the way the leader meant it.
    const payload = this.isLimited ? null : readHandoverPayload(raw);
    const accepted = payload !== null && this.options.events.handoverOffered(payload);
    this.write({ t: 'handoverAck', ok: accepted });
  }

  // ----- staleness -----------------------------------------------------------------------------

  /**
   * How long the leader may stay silent before its last state is no longer shown. While it was
   * watching: three poll intervals, at least 15 s. Never more than 30 s - the leader sends
   * something at least every 10 s.
   */
  private silenceLimitMs(): number {
    if (!this.lastStateArmed) return SILENCE_LIMIT_MS;
    const threePolls = this.lastStatePollSeconds === null ? 0 : this.lastStatePollSeconds * 3000;
    return Math.min(SILENCE_LIMIT_MS, Math.max(ARMED_SILENCE_FLOOR_MS, threePolls));
  }

  private restartSilenceTimer(): void {
    this.timers.clear(this.silenceTimer);
    this.silenceTimer = this.timers.set(() => this.onSilence(), this.silenceLimitMs());
  }

  private onSilence(): void {
    this.silenceTimer = null;
    if (this.state === null) return;
    const who = this.leader === null ? 'The window in control' : `The window in control ("${this.leader.label}")`;
    this.options.log(`${who} has stopped sending updates.`);
    this.show(null);
  }
}
