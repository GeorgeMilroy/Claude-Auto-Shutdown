// Windows prove to each other that they run as the same user before either side trusts the other.
// The endpoint name is public (derived from the user name), so on a machine with several accounts
// another account could listen on it first, or connect to it, and hand this user's windows rules
// they never saw. Both proofs are keyed with the per-user secret from the state folder (0600 inside
// 0700), which no other account can read:
// - the hello proves the window knows the secret, for its own window id and a fresh nonce;
// - the welcome proves the leader knows it too, answering that very nonce (so it can't be replayed).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ClientMessage, ServerMessage } from '../shared/protocol';

/** The hello and the welcome as they go over the wire: the shared shapes plus their proofs. */
export type ProvenHello = Extract<ClientMessage, { t: 'hello' }> & { nonce: string; proof: string };
export type ProvenWelcome = Extract<ServerMessage, { t: 'welcome' }> & { proof: string };

const SECRET = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const PROOF = /^[0-9a-f]{64}$/;

/** Only a secret of the shape StateDir writes is used: anything else is no secret at all. */
export function isSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET.test(value);
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

/** A fresh challenge for one hello: 32 hex characters. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function helloProof(secret: string, windowId: string, nonce: string): string {
  return sign(secret, `cas-hello\n${windowId}\n${nonce}`);
}

export function welcomeProof(secret: string, epoch: string, nonce: string): string {
  return sign(secret, `cas-welcome\n${epoch}\n${nonce}`);
}

/** Constant-time comparison. Anything that is not shaped like a proof proves nothing. */
export function proofMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || !PROOF.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

function sign(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}
