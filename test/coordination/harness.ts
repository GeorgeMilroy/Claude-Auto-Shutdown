// Shared test rig: real Coordinator instances on a real, per-test endpoint (a named pipe on
// Windows), plus scripted raw peers for the cases where the other side has to misbehave on cue.

import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  Coordinator,
  type LeaderHandlers,
  type RemoteState,
  type RoleChange,
} from '../../src/coordination/coordinator';
import { PipeClaimer, releaseClaim, type Claim, type EndpointClaimer } from '../../src/coordination/endpoint';
import { SocketClaimer } from '../../src/coordination/posixEndpoint';
import { contractDigest, DEFAULT_CONFIG, toArmContract, type ArmContract } from '../../src/shared/config';
import {
  PROTOCOL_VERSION,
  type Command,
  type CommandResult,
  type HandoverPayload,
  type UiState,
  type WindowHello,
} from '../../src/shared/protocol';

export const CONTRACT: ArmContract = toArmContract(DEFAULT_CONFIG);

/** The per-user secret every test window shares, unless a test gives one another. */
export const TEST_SECRET = 'a1'.repeat(32);

/**
 * The proofs written out from the spec rather than imported, so a change to how src/ computes
 * them shows up as a broken test instead of passing silently.
 */
function hmac(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export function helloProofFor(windowId: string, nonce: string, secret = TEST_SECRET): string {
  return hmac(secret, `cas-hello\n${windowId}\n${nonce}`);
}

export function welcomeProofFor(epoch: string, nonce: string, secret = TEST_SECRET): string {
  return hmac(secret, `cas-welcome\n${epoch}\n${nonce}`);
}

/** A hello as a well-behaved window of this user sends it. */
export function provenHello(hello: WindowHello, version = PROTOCOL_VERSION, secret = TEST_SECRET): Message {
  const nonce = randomBytes(16).toString('hex');
  return { t: 'hello', v: version, ...hello, nonce, proof: helloProofFor(hello.windowId, nonce, secret) };
}

const temporaryFolders: string[] = [];

/** A fresh endpoint nobody else uses: `\\.\pipe\cas-test-<random>` on Windows. */
export function uniqueEndpoint(): string {
  const id = randomBytes(8).toString('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\cas-test-${process.pid}-${id}`;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  fs.chmodSync(folder, 0o700);
  temporaryFolders.push(folder);
  return path.join(folder, 'leader.sock');
}

export function removeTemporaryFolders(): void {
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(what: string, condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(5);
  }
}

export function makeHello(label: string, overrides: Partial<WindowHello> = {}): WindowHello {
  return {
    windowId: `window-${label}-${randomBytes(4).toString('hex')}`,
    pid: process.pid,
    app: 'Visual Studio Code',
    ext: '0.1.0',
    realm: 'realm-a',
    label,
    remote: null,
    ...overrides,
  };
}

/** A complete UiState as a controller would publish it. */
export function makeState(overrides: Partial<UiState> = {}): UiState {
  return {
    v: PROTOCOL_VERSION,
    seq: 1,
    epoch: 'epoch-default',
    leader: {
      windowId: 'window-leader',
      label: 'leader',
      app: 'Visual Studio Code',
      ext: '0.1.0',
      pid: 1,
      realm: 'realm-a',
    },
    hostname: 'test-pc',
    phase: 'off',
    armed: false,
    armedAtMs: null,
    armedBy: null,
    contract: CONTRACT,
    contractDigest: contractDigest(CONTRACT),
    contractRealm: 'realm-a',
    confirm: { k: 0, n: CONTRACT.requiredPolls, nextCheckInMs: null },
    countdown: null,
    cooldownRemainingMs: null,
    checks: [],
    sessions: [],
    sessionsOmitted: 0,
    strays: [],
    remoteWindows: [],
    scan: { engineActive: false, lastCompletedAgoMs: null, stale: false, errors: [], roots: [] },
    platform: {
      id: 'windows',
      osName: 'Windows',
      experimental: false,
      helperTier: 'full',
      problem: null,
      capability: null,
      capabilities: {},
      keepAwake: 'off',
    },
    stop: { present: false, dir: 'C:\\state', auto: false },
    lastResult: null,
    testPassedOnce: false,
    activity: [],
    logFile: 'C:\\state\\activity.log',
    ...overrides,
  };
}

export function armedState(overrides: Partial<UiState> = {}): UiState {
  return makeState({ phase: 'watching', armed: true, armedAtMs: 1_700_000_000_000, armedBy: 'user', ...overrides });
}

export function makeHandover(overrides: Partial<HandoverPayload> = {}): HandoverPayload {
  return {
    contract: CONTRACT,
    contractRealm: 'realm-a',
    armedAtMs: 1_700_000_000_000,
    sawAnySession: true,
    sinceLastSessionMs: 4000,
    cooldownRemainingMs: 0,
    ignores: ['session:0:1:abc:10:20:0'],
    ...overrides,
  };
}

function createRealClaimer(endpoint: string): EndpointClaimer {
  return process.platform === 'win32' ? new PipeClaimer(endpoint) : new SocketClaimer(endpoint);
}

/**
 * Claims the endpoint for real, and remembers every handle so a test can take them away the way
 * a dying process does: no goodbye, and nothing the "dead" window tries afterwards happens.
 */
export class CrashableClaimer implements EndpointClaimer {
  private readonly inner: EndpointClaimer;
  private readonly servers = new Set<net.Server>();
  private readonly sockets = new Set<net.Socket>();
  private dead = false;

  constructor(endpoint: string) {
    this.inner = createRealClaimer(endpoint);
  }

  async attempt(signal: AbortSignal): Promise<Claim> {
    if (this.dead) return new Promise<Claim>(() => undefined);
    const claim = await this.inner.attempt(signal);
    if (this.dead) {
      releaseClaim(claim);
      return new Promise<Claim>(() => undefined);
    }
    if (claim.kind === 'leader') {
      this.servers.add(claim.server);
      claim.server.on('connection', (socket) => this.sockets.add(socket));
    } else if (claim.kind === 'follower') {
      this.sockets.add(claim.socket);
    }
    return claim;
  }

  /** The process is gone: every handle closes at once. */
  crash(): void {
    this.dead = true;
    this.closeHandles();
  }

  /** The endpoint is pulled away from a window that keeps running. */
  closeHandles(): void {
    for (const server of this.servers) server.close();
    for (const socket of this.sockets) socket.destroy();
    this.servers.clear();
    this.sockets.clear();
  }
}

export interface WindowOptions {
  version?: number;
  hello?: Partial<WindowHello>;
  random?: () => number;
  claimer?: EndpointClaimer;
  /** Default TEST_SECRET; null = the window could not read its secret file. */
  secret?: string | null;
}

/** One editor window: a Coordinator plus a scriptable stand-in for its controller. */
export class TestWindow {
  readonly hello: WindowHello;
  readonly coordinator: Coordinator;
  readonly roles: RoleChange[] = [];
  readonly remotes: RemoteState[] = [];
  readonly commands: { command: Command; from: WindowHello }[] = [];
  readonly stuck: Command[] = [];
  readonly logs: string[] = [];
  /** The lines logged at level 'warn' (also in logs). */
  readonly warnings: string[] = [];
  delivered = 0;
  peerChanges = 0;
  handoverCalls = 0;

  /** What currentState() answers while this window leads. */
  state: UiState;
  /** What beginHandover() answers. */
  handover: HandoverPayload | null = null;
  /** How this window's controller answers a command. */
  respond: (command: Command, from: WindowHello) => Promise<CommandResult> = async () => ({ ok: true });

  private readonly crashable: CrashableClaimer;

  constructor(endpoint: string, label: string, options: WindowOptions = {}) {
    this.hello = makeHello(label, options.hello);
    this.state = makeState({ epoch: `epoch-${label}` });
    this.crashable = new CrashableClaimer(endpoint);
    this.coordinator = new Coordinator(
      {
        endpoint,
        self: this.hello,
        protocolVersion: options.version ?? PROTOCOL_VERSION,
        secret: options.secret === undefined ? TEST_SECRET : options.secret,
        log: (message, level) => {
          this.logs.push(message);
          if (level === 'warn') this.warnings.push(message);
        },
      },
      { claimer: options.claimer ?? this.crashable, random: options.random },
    );
    const handlers: LeaderHandlers = {
      handleCommand: (command, from) => {
        this.commands.push({ command, from });
        return this.respond(command, from);
      },
      currentState: () => this.state,
      beginHandover: () => {
        this.handoverCalls += 1;
        return this.handover;
      },
    };
    this.coordinator.setLeaderHandlers(handlers);
    this.coordinator.onRole((change) => this.roles.push(change));
    this.coordinator.onRemoteState((remote) => this.remotes.push(remote));
    this.coordinator.onPeersChanged(() => (this.peerChanges += 1));
    this.coordinator.onSafeCommandStuck((command) => this.stuck.push(command));
    this.coordinator.onSafeCommandsDelivered(() => (this.delivered += 1));
  }

  get label(): string {
    return this.hello.label;
  }

  get role(): string {
    return this.coordinator.role;
  }

  get lastRole(): RoleChange | undefined {
    return this.roles[this.roles.length - 1];
  }

  get remote(): RemoteState | undefined {
    return this.remotes[this.remotes.length - 1];
  }

  commandNames(): string[] {
    return this.commands.map(({ command }) => command.name);
  }

  start(): this {
    this.coordinator.start();
    return this;
  }

  crash(): void {
    this.crashable.crash();
  }

  loseEndpoint(): void {
    this.crashable.closeHandles();
  }
}

type Message = Record<string, unknown>;

function collectMessages(socket: net.Socket, into: Message[]): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (text: string) => {
    buffered += text;
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end === -1) return;
      into.push(JSON.parse(buffered.slice(0, end)) as Message);
      buffered = buffered.slice(end + 1);
    }
  });
}

function sendMessage(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

/** A scripted follower: speaks whatever the test tells it to. */
export class RawClient {
  readonly received: Message[] = [];
  closed = false;

  private constructor(readonly socket: net.Socket) {
    socket.on('error', () => undefined);
    socket.on('close', () => (this.closed = true));
    collectMessages(socket, this.received);
  }

  static connect(endpoint: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new RawClient(socket));
      });
    });
  }

  /** Connect and say hello the way a well-behaved window does. */
  static async join(endpoint: string, label: string, version = PROTOCOL_VERSION): Promise<RawClient> {
    const client = await RawClient.connect(endpoint);
    client.send(provenHello(makeHello(label), version));
    await waitFor(`${label} is welcomed`, () => client.of('welcome').length === 1);
    return client;
  }

  send(message: unknown): void {
    sendMessage(this.socket, message);
  }

  sendRaw(data: string | Buffer): void {
    this.socket.write(data);
  }

  of(type: string): Message[] {
    return this.received.filter((message) => message.t === type);
  }
}

export interface RawConnection {
  socket: net.Socket;
  received: Message[];
  closed: boolean;
}

/** A scripted leader: holds the endpoint and answers only what the test tells it to. */
export class RawLeader {
  readonly connections: RawConnection[] = [];

  private constructor(private readonly server: net.Server) {
    server.on('connection', (socket) => {
      const connection: RawConnection = { socket, received: [], closed: false };
      socket.on('error', () => undefined);
      socket.on('close', () => (connection.closed = true));
      collectMessages(socket, connection.received);
      this.connections.push(connection);
    });
  }

  static listen(endpoint: string): Promise<RawLeader> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(endpoint, () => resolve(new RawLeader(server)));
    });
  }

  get latest(): RawConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error('nobody has connected');
    return connection;
  }

  async accepted(count: number): Promise<void> {
    await waitFor(`${count} connection(s) with a hello`, () => this.hellos().length >= count);
  }

  hellos(): Message[] {
    return this.connections.flatMap((connection) => connection.received.filter((message) => message.t === 'hello'));
  }

  /**
   * Welcome the window on `connection`, answering its hello's nonce with a proof made from
   * `proof.secret` (default TEST_SECRET); `proof: null` leaves the proof out altogether.
   */
  welcome(
    connection: RawConnection,
    state: unknown,
    version = PROTOCOL_VERSION,
    proof: { secret: string } | null = { secret: TEST_SECRET },
  ): void {
    const leader = {
      windowId: 'window-raw-leader',
      label: 'raw',
      app: 'Cursor',
      ext: '9.9.9',
      pid: 4242,
      realm: 'realm-b',
    };
    const epoch = 'epoch-raw';
    const message: Message = { t: 'welcome', v: version, epoch, leader, state };
    if (proof !== null) message.proof = welcomeProofFor(epoch, this.nonceOf(connection), proof.secret);
    sendMessage(connection.socket, message);
  }

  /** The nonce the window on `connection` sent with its hello. */
  nonceOf(connection: RawConnection): string {
    const hello = connection.received.find((message) => message.t === 'hello');
    if (typeof hello?.nonce !== 'string') throw new Error('that window has not sent a hello with a nonce');
    return hello.nonce;
  }

  send(connection: RawConnection, message: unknown): void {
    sendMessage(connection.socket, message);
  }

  /** Vanish like a crashed process. */
  close(): void {
    this.server.close();
    for (const connection of this.connections) connection.socket.destroy();
  }
}

/** Per-test bookkeeping so nothing outlives the test that created it. */
export class Rig {
  readonly endpoint = uniqueEndpoint();
  private readonly windows: TestWindow[] = [];
  private readonly rawClients: RawClient[] = [];
  private readonly rawLeaders: RawLeader[] = [];

  window(label: string, options: WindowOptions = {}): TestWindow {
    const window = new TestWindow(this.endpoint, label, options);
    this.windows.push(window);
    return window;
  }

  /** Start a window and wait until it has a role (leader or follower). */
  async join(label: string, options: WindowOptions = {}): Promise<TestWindow> {
    const window = this.window(label, options).start();
    await waitFor(`${label} has a role`, () => window.role === 'leader' || window.role === 'follower');
    return window;
  }

  async rawClient(label: string, version = PROTOCOL_VERSION): Promise<RawClient> {
    const client = await RawClient.join(this.endpoint, label, version);
    this.rawClients.push(client);
    return client;
  }

  async rawConnection(): Promise<RawClient> {
    const client = await RawClient.connect(this.endpoint);
    this.rawClients.push(client);
    return client;
  }

  async rawLeader(): Promise<RawLeader> {
    const leader = await RawLeader.listen(this.endpoint);
    this.rawLeaders.push(leader);
    return leader;
  }

  async dispose(): Promise<void> {
    for (const client of this.rawClients) client.socket.destroy();
    for (const leader of this.rawLeaders) leader.close();
    await Promise.all(this.windows.map((window) => window.coordinator.dispose()));
    removeTemporaryFolders();
  }
}
