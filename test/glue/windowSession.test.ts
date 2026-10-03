// Role switching, with a fake coordinator and a fake leader runtime: no pipe, no helper process,
// no scan. The only real thing is a StateDir in a temp folder (for the Emergency stop file).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LeaderHandlers, RemoteState, RoleChange } from '../../src/coordination/coordinator';
import type { Command, CommandResult, HandoverPayload, Role, UiState, WindowHello } from '../../src/shared/protocol';
import { StateDir } from '../../src/shared/stateDir';
import { WindowSession } from '../../src/ui/windowSession';
import type { AutoStopOutcome, LeaderDisposal, LeaderRuntime, LeaderStart, WindowCoordinator } from '../../src/ui/windowSession';
import { REALM, contract, uiState, watching } from './fixtures';

const SELF: WindowHello = {
  windowId: 'window-under-test',
  pid: 1234,
  app: 'Visual Studio Code',
  ext: '0.1.0',
  realm: REALM,
  label: 'api-refactor',
  remote: null,
};

class Listeners<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void) {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  get size(): number {
    return this.listeners.size;
  }
}

class FakeCoordinator implements WindowCoordinator {
  readonly roles = new Listeners<RoleChange>();
  readonly remotes = new Listeners<RemoteState>();
  readonly peersChanged = new Listeners<void>();
  readonly stuck = new Listeners<Command>();
  readonly delivered = new Listeners<void>();
  readonly published: UiState[] = [];
  readonly sent: Command[] = [];
  readonly visibility: boolean[] = [];
  readonly calls: string[] = [];
  handlers: LeaderHandlers | null = null;
  handedOver = false;
  /** What happens inside dispose() before it resolves (e.g. an unconfirmed Cancel is reported stuck). */
  whileDisposing: () => void = () => undefined;
  /** Answers for send(); a command without one stays unanswered until answer() is called. */
  private readonly waiting: ((result: CommandResult) => void)[] = [];
  autoAnswer: CommandResult | null = { ok: true };

  setLeaderHandlers(handlers: LeaderHandlers): void {
    this.handlers = handlers;
  }

  start(): void {
    this.calls.push('start');
  }

  onRole(listener: (change: RoleChange) => void) {
    return this.roles.on(listener);
  }

  onRemoteState(listener: (remote: RemoteState) => void) {
    return this.remotes.on(listener);
  }

  onPeersChanged(listener: () => void) {
    return this.peersChanged.on(listener);
  }

  onSafeCommandStuck(listener: (command: Command) => void) {
    return this.stuck.on(listener);
  }

  onSafeCommandsDelivered(listener: () => void) {
    return this.delivered.on(listener);
  }

  publish(state: UiState): void {
    this.published.push(state);
  }

  send(command: Command): Promise<CommandResult> {
    this.sent.push(command);
    if (this.autoAnswer !== null) return Promise.resolve(this.autoAnswer);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  answer(result: CommandResult): void {
    this.waiting.shift()?.(result);
  }

  setViewVisible(visible: boolean): void {
    this.visibility.push(visible);
  }

  dispose(): Promise<{ handedOver: boolean }> {
    this.calls.push('dispose');
    this.whileDisposing();
    return Promise.resolve({ handedOver: this.handedOver });
  }

  becomes(role: Role, extra: Partial<RoleChange> = {}): void {
    this.roles.emit({ role, handover: null, previousLeaderWasWatching: false, ...extra });
  }

  receives(state: UiState | null, limited = false, receivedAtMono = 5_000): void {
    this.remotes.emit({ state, leader: state?.leader ?? null, limited, receivedAtMono });
  }
}

class FakeLeader implements LeaderRuntime {
  readonly calls: string[] = [];
  readonly commands: Command[] = [];
  disposedWith: LeaderDisposal | null = null;
  state: UiState = uiState({ epoch: 'own-epoch' });

  constructor(readonly start: LeaderStart) {}

  getState(): UiState {
    return this.state;
  }

  handleCommand(command: Command): Promise<CommandResult> {
    this.commands.push(command);
    return Promise.resolve({ ok: true });
  }

  beginHandover(): HandoverPayload | null {
    this.calls.push('beginHandover');
    return null;
  }

  configChanged(): void {
    this.calls.push('configChanged');
  }

  peersChanged(): void {
    this.calls.push('peersChanged');
  }

  dispose(options: LeaderDisposal): Promise<void> {
    this.disposedWith = options;
    return Promise.resolve();
  }

  /** The controller publishes a new state. */
  publishes(state: UiState): void {
    this.state = state;
    this.start.onState(state);
  }
}

let dir: string;
let stateDir: StateDir;
let coordinator: FakeCoordinator;
let leaders: FakeLeader[];
let logged: string[];

function createSession(createLeader?: (start: LeaderStart) => LeaderRuntime): WindowSession {
  const session = new WindowSession({
    coordinator,
    stateDir,
    self: SELF,
    log: (message) => logged.push(message),
    createLeader:
      createLeader ??
      ((start) => {
        const leader = new FakeLeader(start);
        leaders.push(leader);
        return leader;
      }),
  });
  session.start();
  return session;
}

function stopFile(): string | null {
  return stateDir.stopStatus().file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  stateDir = new StateDir(dir);
  coordinator = new FakeCoordinator();
  leaders = [];
  logged = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('leader-only machinery', () => {
  it('builds nothing while electing or following', () => {
    const session = createSession();
    expect(coordinator.calls).toEqual(['start']);
    expect(session.current).toMatchObject({ role: 'electing', state: null });
    coordinator.becomes('follower');
    coordinator.becomes('electing');
    coordinator.becomes('isolated');
    expect(leaders).toHaveLength(0);
  });

  it('builds it when this window becomes the leader, and shows its state', () => {
    const session = createSession();
    coordinator.becomes('leader');
    expect(leaders).toHaveLength(1);
    expect(session.current).toMatchObject({ role: 'leader', limited: false });
    expect(session.current.state?.epoch).toBe('own-epoch');
  });

  it('tears it down when this window stops leading, without handing anything over', () => {
    const session = createSession();
    coordinator.becomes('leader');
    coordinator.becomes('electing');
    // The window is still open: watching ended because control was lost, not because it closed.
    expect(leaders[0]?.disposedWith).toEqual({ handedOver: false, cause: 'lostControl' });
    expect(session.current).toMatchObject({ role: 'electing', state: null });
    coordinator.becomes('leader');
    expect(leaders).toHaveLength(2);
    expect(leaders[1]?.disposedWith).toBeNull();
  });

  it('passes on what the coordinator knows about the takeover', () => {
    createSession();
    const handover = { contract: contract(), contractRealm: REALM, armedAtMs: 1, sawAnySession: true, sinceLastSessionMs: 5, cooldownRemainingMs: 0, ignores: [] };
    coordinator.becomes('follower');
    coordinator.becomes('electing');
    coordinator.becomes('leader', { handover, previousLeaderWasWatching: false });
    expect(leaders[0]?.start.handover).toBe(handover);
    expect(leaders[0]?.start.freshStart).toBe(false);
  });

  it('calls it a fresh start only when this window led from its very first election', () => {
    createSession();
    coordinator.becomes('leader');
    expect(leaders[0]?.start.freshStart).toBe(true);
    coordinator.becomes('electing');
    coordinator.becomes('leader', { previousLeaderWasWatching: true });
    expect(leaders[1]?.start).toMatchObject({ freshStart: false, previousLeaderWasWatching: true });
  });

  it('publishes every controller state to the other windows and shows it', () => {
    const session = createSession();
    coordinator.becomes('leader');
    const next = watching({ epoch: 'own-epoch', seq: 2 });
    leaders[0]?.publishes(next);
    expect(coordinator.published).toEqual([next]);
    expect(session.current.state).toBe(next);
  });

  it('also takes the states the controller publishes while it is still starting', () => {
    const early = uiState({ epoch: 'own-epoch', seq: 1 });
    const session = createSession((start) => {
      start.onState(early);
      const leader = new FakeLeader(start);
      leaders.push(leader);
      return leader;
    });
    coordinator.becomes('leader');
    expect(coordinator.published).toEqual([early]);
    expect(session.current.role).toBe('leader');
  });

  it('ignores a state from a controller it has already retired', () => {
    const session = createSession();
    coordinator.becomes('leader');
    coordinator.becomes('follower');
    leaders[0]?.publishes(watching());
    expect(coordinator.published).toEqual([]);
    expect(session.current.state).toBeNull();
  });

  it('answers for the controller only while there is one', async () => {
    createSession();
    const disarm: Command = { name: 'disarm' };
    await expect(coordinator.handlers?.handleCommand(disarm, SELF)).resolves.toMatchObject({ ok: false });
    expect(coordinator.handlers?.currentState()).toBeNull();
    expect(coordinator.handlers?.beginHandover()).toBeNull();

    coordinator.becomes('leader');
    await expect(coordinator.handlers?.handleCommand(disarm, SELF)).resolves.toEqual({ ok: true });
    expect(leaders[0]?.commands).toEqual([disarm]);
    expect(coordinator.handlers?.currentState()?.epoch).toBe('own-epoch');
  });

  it('is a leader in name only when the machinery cannot be built: no state, every command refused', async () => {
    const session = createSession(() => {
      throw new Error('helper script missing');
    });
    coordinator.becomes('leader');
    expect(session.current).toMatchObject({ role: 'leader', state: null });
    expect(logged.join('\n')).toContain('helper script missing');
    await expect(coordinator.handlers?.handleCommand({ name: 'refresh' }, SELF)).resolves.toMatchObject({ ok: false });
  });
});

describe('what a window shows', () => {
  it('shows the state the leader pushed, with its arrival time', () => {
    const session = createSession();
    coordinator.becomes('follower');
    const state = watching();
    coordinator.receives(state, false, 7_500);
    expect(session.current).toEqual({ role: 'follower', state, limited: false, receivedAtMono: 7_500 });
  });

  it('never keeps a state across a role change', () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.receives(watching());
    for (const role of ['electing', 'isolated', 'follower'] as const) {
      coordinator.becomes(role);
      expect(session.current).toMatchObject({ role, state: null });
      coordinator.becomes('follower');
      coordinator.receives(watching());
    }
  });

  it('shows "no state" as soon as the leader goes quiet or the connection drops', () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.receives(watching());
    coordinator.receives(null);
    expect(session.current).toMatchObject({ role: 'follower', state: null });
  });

  it('marks a state from another version as limited', () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.receives(watching(), true);
    expect(session.current.limited).toBe(true);
    coordinator.becomes('electing');
    expect(session.current.limited).toBe(false);
  });

  it('as leader, shows its own controller and nothing that came over the wire', () => {
    const session = createSession();
    coordinator.becomes('leader');
    coordinator.receives(watching({ epoch: 'somebody-else' }));
    expect(session.current.state?.epoch).toBe('own-epoch');
  });

  it('tells its listeners about every change', () => {
    const session = createSession();
    let changes = 0;
    const subscription = session.onChange(() => {
      changes += 1;
    });
    coordinator.becomes('follower');
    coordinator.receives(uiState());
    expect(changes).toBe(2);
    subscription.dispose();
    coordinator.receives(watching());
    expect(changes).toBe(2);
  });

  it('keeps going when one listener throws', () => {
    const session = createSession();
    let reached = false;
    session.onChange(() => {
      throw new Error('status bar is gone');
    });
    session.onChange(() => {
      reached = true;
    });
    coordinator.becomes('follower');
    expect(reached).toBe(true);
    expect(logged.join('\n')).toContain('status bar is gone');
  });
});

describe('settings and viewers', () => {
  it('as leader, tells the controller about any settings change', () => {
    const session = createSession();
    coordinator.becomes('leader');
    session.settingsChanged({ contractChanged: false, digest: 'd1' });
    expect(leaders[0]?.calls).toEqual(['configChanged']);
    expect(coordinator.sent).toEqual([]);
  });

  it('as follower, tells the leader when the agreed rules changed - with its realm, so only its own watch stops', () => {
    const session = createSession();
    coordinator.becomes('follower');
    session.settingsChanged({ contractChanged: false, digest: 'd1' });
    expect(coordinator.sent).toEqual([]);
    session.settingsChanged({ contractChanged: true, digest: 'd2' });
    expect(coordinator.sent).toEqual([{ name: 'settingsChanged', realm: REALM, digest: 'd2' }]);
  });

  it('sends nothing while there is no leader to tell', () => {
    const session = createSession();
    session.settingsChanged({ contractChanged: true, digest: 'd1' });
    coordinator.becomes('isolated');
    session.settingsChanged({ contractChanged: true, digest: 'd1' });
    expect(coordinator.sent).toEqual([]);
  });

  it('tells the next leader about a change of the rules that no leader could be told at the time', () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.becomes('electing');
    session.settingsChanged({ contractChanged: true, digest: 'd1' });
    session.settingsChanged({ contractChanged: true, digest: 'd2' });
    coordinator.becomes('follower');
    expect(coordinator.sent).toEqual([{ name: 'settingsChanged', realm: REALM, digest: 'd2' }]);
  });

  it('tells its own controller when it becomes the leader itself with such a change untold', () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.becomes('electing');
    session.settingsChanged({ contractChanged: true, digest: 'd1' });
    coordinator.becomes('leader', { handover: null });
    expect(leaders[0]?.calls).toEqual(['configChanged']);
    coordinator.becomes('electing');
    coordinator.becomes('follower');
    expect(coordinator.sent).toEqual([]);
  });

  it('keeps trying with each new leader until one has taken the news', async () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.autoAnswer = { ok: false, error: 'The window in control closed before it answered.' };
    session.settingsChanged({ contractChanged: true, digest: 'd1' });
    await Promise.resolve();
    coordinator.autoAnswer = { ok: true };
    coordinator.becomes('electing');
    coordinator.becomes('follower');
    await Promise.resolve();
    coordinator.becomes('electing');
    coordinator.becomes('follower');
    expect(coordinator.sent).toHaveLength(2);
  });

  it('reports the dashboard being shown or hidden to the coordinator and to its own controller', () => {
    const session = createSession();
    coordinator.becomes('leader');
    session.setViewVisible(true);
    session.setViewVisible(true);
    session.setViewVisible(false);
    expect(coordinator.visibility).toEqual([true, false]);
    expect(leaders[0]?.calls).toEqual(['peersChanged', 'peersChanged']);
    expect(session.viewVisible).toBe(false);
  });

  it('passes a change of the connected windows on to the controller', () => {
    createSession();
    coordinator.becomes('leader');
    coordinator.peersChanged.emit();
    expect(leaders[0]?.calls).toEqual(['peersChanged']);
  });
});

describe('Stop and Cancel', () => {
  it('shows the request as pending until a leader confirms it', async () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.autoAnswer = null;
    const sending = session.sendSafe({ name: 'cancel', via: 'esc' });
    expect(session.pending).toBe('cancel');
    expect(coordinator.sent).toEqual([{ name: 'cancel', via: 'esc' }]);
    coordinator.answer({ ok: true });
    await expect(sending).resolves.toEqual({ ok: true });
    expect(session.pending).toBeNull();
  });

  it('keeps showing the newest request while several are unconfirmed', async () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.autoAnswer = null;
    const cancel = session.sendSafe({ name: 'cancel', via: 'button' });
    const stop = session.sendSafe({ name: 'disarm' });
    expect(session.pending).toBe('disarm');
    coordinator.answer({ ok: true });
    await cancel;
    expect(session.pending).toBe('disarm');
    coordinator.answer({ ok: true });
    await stop;
    expect(session.pending).toBeNull();
  });

  it('sets Emergency stop when a request stays unconfirmed, and says so once', () => {
    const session = createSession();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.becomes('follower');

    coordinator.stuck.emit({ name: 'cancel', via: 'button' });
    expect(stopFile()).toBe(path.join(dir, 'STOP'));
    expect(fs.readFileSync(path.join(dir, 'STOP'), 'utf8')).toBe(`auto:${SELF.windowId}\n`);
    expect(session.autoStopSet).toBe(true);

    coordinator.stuck.emit({ name: 'disarm' });
    expect(outcomes).toEqual(['set']);
  });

  it('removes its own Emergency stop once the request got through after all', () => {
    const session = createSession();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.becomes('follower');
    coordinator.stuck.emit({ name: 'cancel', via: 'button' });
    coordinator.delivered.emit();
    expect(stopFile()).toBeNull();
    expect(session.autoStopSet).toBe(false);
    expect(outcomes).toEqual(['set', 'cleared']);
  });

  it('never removes an Emergency stop the user created, and does not claim it as its own', () => {
    fs.writeFileSync(path.join(dir, 'STOP'), '');
    const session = createSession();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.becomes('follower');
    coordinator.stuck.emit({ name: 'disarm' });
    expect(session.autoStopSet).toBe(false);
    coordinator.delivered.emit();
    expect(fs.readFileSync(path.join(dir, 'STOP'), 'utf8')).toBe('');
    expect(outcomes).toEqual(['alreadySet']);
  });

  it("removes only its own file when the user's STOP.txt is there as well, and does not say the brake is off", () => {
    fs.writeFileSync(path.join(dir, 'STOP.txt'), '');
    const session = createSession();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.becomes('follower');
    coordinator.stuck.emit({ name: 'cancel', via: 'esc' });
    coordinator.delivered.emit();
    expect(fs.readdirSync(dir)).toEqual(['STOP.txt']);
    expect(outcomes).not.toContain('cleared');
  });

  it('leaves the Emergency stop of another window alone', () => {
    fs.writeFileSync(path.join(dir, 'STOP'), 'auto:another-window\n');
    const session = createSession();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.becomes('follower');
    coordinator.stuck.emit({ name: 'disarm' });
    coordinator.delivered.emit();
    expect(fs.readFileSync(path.join(dir, 'STOP'), 'utf8')).toBe('auto:another-window\n');
    expect(outcomes).toEqual(['set']);
  });

  it('says so when Emergency stop could not be set either', () => {
    const session = new WindowSession({
      coordinator,
      stateDir: { createAutoStop: () => false, clearAutoStop: () => undefined, stopStatus: () => ({ present: false, auto: false, file: null }) },
      self: SELF,
      log: (message) => logged.push(message),
      createLeader: () => {
        throw new Error('not used');
      },
    });
    session.start();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.stuck.emit({ name: 'cancel', via: 'esc' });
    expect(outcomes).toEqual(['failed']);
    expect(session.autoStopSet).toBe(false);
  });

  it('does nothing when requests are confirmed and nothing was ever stuck', () => {
    const session = createSession();
    const outcomes: AutoStopOutcome[] = [];
    session.onAutoStop((outcome) => outcomes.push(outcome));
    coordinator.delivered.emit();
    expect(outcomes).toEqual([]);
    expect(stopFile()).toBeNull();
  });
});

describe('closing the window', () => {
  it('says goodbye first, then stops the controller with what the goodbye achieved', async () => {
    const session = createSession();
    coordinator.becomes('leader');
    coordinator.handedOver = true;
    coordinator.whileDisposing = () => {
      // The coordinator asks for the armed state while the controller is still alive.
      expect(leaders[0]?.disposedWith).toBeNull();
      coordinator.handlers?.beginHandover();
    };
    await session.dispose();
    expect(leaders[0]?.calls).toEqual(['beginHandover']);
    expect(leaders[0]?.disposedWith).toEqual({ handedOver: true });
  });

  it('records "not handed over" when no sibling took the armed state', async () => {
    const session = createSession();
    coordinator.becomes('leader');
    await session.dispose();
    expect(leaders[0]?.disposedWith).toStrictEqual({ handedOver: false });
  });

  it('still turns a request that is unconfirmed at that moment into Emergency stop', async () => {
    const session = createSession();
    coordinator.becomes('follower');
    coordinator.whileDisposing = () => coordinator.stuck.emit({ name: 'cancel', via: 'button' });
    await session.dispose();
    expect(stopFile()).toBe(path.join(dir, 'STOP'));
  });

  it('closes once, and lets go of everything it listened to', async () => {
    const session = createSession();
    let changes = 0;
    session.onChange(() => {
      changes += 1;
    });
    await Promise.all([session.dispose(), session.dispose()]);
    expect(coordinator.calls.filter((call) => call === 'dispose')).toHaveLength(1);
    expect(coordinator.roles.size + coordinator.remotes.size + coordinator.stuck.size + coordinator.delivered.size).toBe(0);
    coordinator.becomes('leader');
    expect(leaders).toHaveLength(0);
    expect(changes).toBe(0);
  });

  it('closes even when the goodbye fails', async () => {
    const session = createSession();
    coordinator.becomes('leader');
    coordinator.dispose = () => Promise.reject(new Error('pipe is gone'));
    await session.dispose();
    expect(leaders[0]?.disposedWith).toEqual({ handedOver: false });
    expect(logged.join('\n')).toContain('pipe is gone');
  });
});
