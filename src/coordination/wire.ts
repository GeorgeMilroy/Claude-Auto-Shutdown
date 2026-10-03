// What the objects on the wire mean. Everything a peer sends is untrusted until it went through
// one of these readers: other windows may run another editor, another version of this extension,
// or a bug. A reader returns null for "I can't use this"; it never guesses a value.

import { parseArmContract } from '../shared/config';
import {
  SAFE_COMMANDS,
  type CancelVia,
  type Command,
  type CommandResult,
  type HandoverPayload,
  type LeaderInfo,
  type Phase,
  type UiState,
  type WindowHello,
} from '../shared/protocol';
import { isNonce } from './auth';
import { isWireObject, type WireObject } from './framing';
import { REFUSED } from './replies';

const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 256;
const MAX_IGNORE_KEY_LENGTH = 1024;

const CANCEL_VIAS: readonly CancelVia[] = ['esc', 'button', 'statusBar', 'notification', 'osAlert', 'command'];
const PHASES: readonly Phase[] = ['off', 'watching', 'confirming', 'countdown', 'committing', 'executing'];

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Display text: any string, cut to a sane length. null = not a string. */
function label(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_LABEL_LENGTH) : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A proof is checked by its receiver; here it is only kept when it is text at all. */
function proofText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function isSafeCommand(command: Command): boolean {
  return SAFE_COMMANDS.includes(command.name);
}

interface WindowIdentity {
  windowId: string;
  pid: number;
  app: string;
  ext: string;
  realm: string;
  label: string;
}

/** The fields WindowHello and LeaderInfo share. */
function readIdentity(raw: WireObject): WindowIdentity | null {
  const { windowId, pid } = raw;
  const app = label(raw.app);
  const ext = label(raw.ext);
  const realm = label(raw.realm);
  const name = label(raw.label);
  if (!isId(windowId) || !isPid(pid)) return null;
  if (app === null || ext === null || realm === null || name === null) return null;
  return { windowId, pid, app, ext, realm, label: name };
}

// ---------------------------------------------------------------------------------------------
// Follower -> leader
// ---------------------------------------------------------------------------------------------

export type ClientFrame =
  /** `nonce` / `proof`: null when missing or malformed. The leader drops such a window. */
  | { t: 'hello'; v: number; hello: WindowHello; nonce: string | null; proof: string | null }
  /** `cmd` is still raw: the leader answers a command it cannot read instead of dropping it. */
  | { t: 'cmd'; id: string; cmd: unknown }
  | { t: 'view'; visible: boolean }
  | { t: 'handoverAck'; ok: boolean };

/**
 * `remote` is strict on purpose: a window connected to a remote machine blocks the action, so a
 * hello whose `remote` cannot be read must not be mistaken for a local window.
 */
function readHello(frame: WireObject): ClientFrame | null {
  const identity = readIdentity(frame);
  const remote = frame.remote === null ? null : label(frame.remote);
  if (identity === null || !isFiniteNumber(frame.v)) return null;
  if (remote === null && frame.remote !== null) return null;
  const nonce = isNonce(frame.nonce) ? frame.nonce : null;
  return { t: 'hello', v: frame.v, hello: { ...identity, remote }, nonce, proof: proofText(frame.proof) };
}

/** null = a message this version does not know, or one it cannot use: ignored by the caller. */
export function readClientFrame(frame: WireObject): ClientFrame | null {
  switch (frame.t) {
    case 'hello':
      return readHello(frame);
    case 'cmd':
      return isId(frame.id) ? { t: 'cmd', id: frame.id, cmd: frame.cmd } : null;
    case 'view':
      return typeof frame.visible === 'boolean' ? { t: 'view', visible: frame.visible } : null;
    case 'handoverAck':
      return typeof frame.ok === 'boolean' ? { t: 'handoverAck', ok: frame.ok } : null;
    default:
      return null;
  }
}

function readArm(raw: WireObject): Command | null {
  const { digest, epoch, realm } = raw;
  const contract = parseArmContract(raw.contract);
  if (contract === null) return null;
  // Compared for equality by the controller, so these are taken whole or not at all.
  if (typeof digest !== 'string' || typeof epoch !== 'string' || typeof realm !== 'string') return null;
  return { name: 'arm', contract, digest, epoch, realm };
}

/**
 * A command as the controller may see it: known name, fields of the right type, nothing else.
 * `cancel` and `disarm` cannot fail to parse once the name is right - they must get through from
 * any version of this extension.
 */
export function readCommand(raw: unknown): Command | null {
  if (!isWireObject(raw)) return null;
  switch (raw.name) {
    case 'disarm':
      return { name: 'disarm' };
    case 'cancel':
      return { name: 'cancel', via: CANCEL_VIAS.find((via) => via === raw.via) ?? 'command' };
    case 'refresh':
    case 'preview':
    case 'dismissResult':
      return { name: raw.name };
    case 'ignore':
      return typeof raw.key === 'string' && raw.key.length <= MAX_IGNORE_KEY_LENGTH && typeof raw.on === 'boolean'
        ? { name: 'ignore', key: raw.key, on: raw.on }
        : null;
    case 'settingsChanged':
      return typeof raw.realm === 'string' && typeof raw.digest === 'string'
        ? { name: 'settingsChanged', realm: raw.realm, digest: raw.digest }
        : null;
    case 'arm':
      return readArm(raw);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Leader -> follower
// ---------------------------------------------------------------------------------------------

export type ServerFrame =
  /**
   * `leader` and `state` stay raw until the follower knows which version it is talking to.
   * `epoch` / `proof`: null when not text; the follower then does not trust this leader.
   */
  | { t: 'welcome'; v: number; epoch: string | null; proof: string | null; leader: unknown; state: unknown }
  | { t: 'state'; state: unknown }
  | { t: 'ack'; id: string; result: CommandResult }
  | { t: 'handover'; payload: unknown }
  | { t: 'leaving'; successor: string | null };

function readAck(frame: WireObject): ServerFrame | null {
  // An ack without a boolean `ok` acknowledges nothing.
  if (!isId(frame.id) || typeof frame.ok !== 'boolean') return null;
  if (frame.ok) return { t: 'ack', id: frame.id, result: { ok: true } };
  const error = typeof frame.error === 'string' && frame.error.trim() ? frame.error : REFUSED;
  return { t: 'ack', id: frame.id, result: { ok: false, error } };
}

function readWelcome(frame: WireObject, v: number): ServerFrame {
  const epoch = typeof frame.epoch === 'string' ? frame.epoch : null;
  return { t: 'welcome', v, epoch, proof: proofText(frame.proof), leader: frame.leader, state: frame.state };
}

/** null = a message this version does not know, or one it cannot use: ignored by the caller. */
export function readServerFrame(frame: WireObject): ServerFrame | null {
  switch (frame.t) {
    case 'welcome':
      return isFiniteNumber(frame.v) ? readWelcome(frame, frame.v) : null;
    case 'state':
      return { t: 'state', state: frame.state };
    case 'ack':
      return readAck(frame);
    case 'handover':
      return { t: 'handover', payload: frame.payload };
    case 'leaving':
      // A goodbye that does not clearly name a successor names nobody.
      return { t: 'leaving', successor: isId(frame.successor) ? frame.successor : null };
    default:
      return null;
  }
}

export function readLeaderInfo(raw: unknown): LeaderInfo | null {
  return isWireObject(raw) ? readIdentity(raw) : null;
}

export function leaderInfoOf(hello: WindowHello): LeaderInfo {
  const { windowId, label: name, app, ext, pid, realm } = hello;
  return { windowId, label: name, app, ext, pid, realm };
}

function hasUiStateShape(state: WireObject): boolean {
  const { countdown, strays } = state;
  return (
    (PHASES as readonly unknown[]).includes(state.phase) &&
    typeof state.armed === 'boolean' &&
    isWireObject(state.contract) &&
    isWireObject(state.confirm) &&
    isWireObject(state.scan) &&
    isWireObject(state.platform) &&
    isWireObject(state.stop) &&
    isWireObject(state.leader) &&
    Array.isArray(state.checks) &&
    Array.isArray(state.sessions) &&
    isCount(state.sessionsOmitted) &&
    Array.isArray(state.remoteWindows) &&
    Array.isArray(state.activity) &&
    (strays === null || Array.isArray(strays)) &&
    (countdown === null || (isWireObject(countdown) && isFiniteNumber(countdown.remainingMs)))
  );
}

/**
 * A state the surfaces may render, or null.
 * Same version: every part a surface dereferences must be there. Another version (`limited`):
 * only `phase` is promised, and the surfaces show nothing but phase and countdown.
 */
export function readState(raw: unknown, limited: boolean): UiState | null {
  if (!isWireObject(raw) || typeof raw.phase !== 'string') return null;
  if (!limited && !hasUiStateShape(raw)) return null;
  return raw as unknown as UiState;
}

/** Poll interval of the contract in force, when the state carries a usable one. */
export function pollSecondsOf(state: UiState): number | null {
  const contract: unknown = state.contract;
  if (!isWireObject(contract)) return null;
  const { pollSeconds } = contract;
  return isFiniteNumber(pollSeconds) && pollSeconds > 0 ? pollSeconds : null;
}

/** Armed state offered by a closing leader. Anything doubtful means "no handover". */
export function readHandoverPayload(raw: unknown): HandoverPayload | null {
  if (!isWireObject(raw)) return null;
  const { contractRealm, armedAtMs, sawAnySession, sinceLastSessionMs, cooldownRemainingMs, ignores } = raw;
  const contract = parseArmContract(raw.contract);
  if (contract === null || typeof contractRealm !== 'string' || !isFiniteNumber(armedAtMs)) return null;
  if (typeof sawAnySession !== 'boolean' || !isNonNegative(cooldownRemainingMs)) return null;
  if (sinceLastSessionMs !== null && !isNonNegative(sinceLastSessionMs)) return null;
  if (!Array.isArray(ignores) || !ignores.every((key): key is string => typeof key === 'string')) return null;
  return {
    contract,
    contractRealm,
    armedAtMs,
    sawAnySession,
    sinceLastSessionMs,
    cooldownRemainingMs,
    ignores: [...ignores],
  };
}
