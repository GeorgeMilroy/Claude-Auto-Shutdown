// Everything that reaches the controller from another window arrives as JSON over a local socket,
// possibly from another editor or another version of this extension. The TypeScript types on the
// wire are a promise, not a fact: commands and handover payloads are re-checked here before the
// controller acts on them.

import { parseArmContract } from '../shared/config';
import type { ArmContract } from '../shared/config';
import type { Command, HandoverPayload } from '../shared/protocol';
import { MAX_IGNORES, isIgnoreKey } from './ignores';
import { asObject, parseCancelVia } from './records';

/** After a cancel nobody asked for, no new countdown starts for this long. */
export const COOLDOWN_MS = 60_000;

/**
 * null = not a command this version understands. 'cancel' and 'disarm' are recognised by name
 * alone, whatever else the message carries: a request that makes things safer is never refused
 * over its shape. The contract of an 'arm' is passed through unchecked - the controller runs it
 * through parseArmContract and compares the digest before it trusts a single field.
 */
export function parseCommand(raw: unknown): Command | null {
  const source = asObject(raw);
  if (source === null) return null;
  const name = source.name;
  switch (name) {
    case 'disarm':
    case 'refresh':
    case 'preview':
    case 'dismissResult':
      return { name };
    case 'cancel':
      return { name, via: parseCancelVia(source.via) };
    case 'arm':
      if (typeof source.digest !== 'string' || typeof source.epoch !== 'string' || typeof source.realm !== 'string') {
        return null;
      }
      return {
        name,
        contract: source.contract as ArmContract,
        digest: source.digest,
        epoch: source.epoch,
        realm: source.realm,
      };
    case 'ignore':
      return typeof source.key === 'string' && typeof source.on === 'boolean'
        ? { name, key: source.key, on: source.on }
        : null;
    case 'settingsChanged':
      return typeof source.realm === 'string' && typeof source.digest === 'string'
        ? { name, realm: source.realm, digest: source.digest }
        : null;
    default:
      return null;
  }
}

/**
 * null = the payload cannot be trusted, so watching is NOT taken over (this PC then simply stays
 * on, and the next start says why). Fields that only make the new leader more careful fall back
 * to the careful value instead of voiding the handover.
 */
export function parseHandover(raw: unknown): HandoverPayload | null {
  const source = asObject(raw);
  if (source === null) return null;
  const contract = parseArmContract(source.contract);
  const armedAtMs = source.armedAtMs;
  if (contract === null || typeof source.contractRealm !== 'string') return null;
  if (typeof armedAtMs !== 'number' || !Number.isFinite(armedAtMs)) return null;

  const since = source.sinceLastSessionMs;
  const cooldown = source.cooldownRemainingMs;
  const ignores = Array.isArray(source.ignores) ? source.ignores.filter(isIgnoreKey).slice(0, MAX_IGNORES) : [];
  return {
    contract,
    contractRealm: source.contractRealm,
    armedAtMs,
    sawAnySession: source.sawAnySession === true,
    sinceLastSessionMs: typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : null,
    // An unreadable cooldown is treated as a full one: never a countdown sooner than intended.
    cooldownRemainingMs:
      typeof cooldown === 'number' && Number.isFinite(cooldown) ? Math.max(0, Math.min(cooldown, COOLDOWN_MS)) : COOLDOWN_MS,
    ignores,
  };
}
