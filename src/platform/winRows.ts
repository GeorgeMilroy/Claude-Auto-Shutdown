// Turns the Windows helper's JSON replies into the platform data model: process rows, idle time
// and the answer to "can this power action run here?". Pure: no I/O.
//
// The helper is our own script, but its replies still cross a process boundary, so every field is
// checked here. A field of the wrong type becomes null ("could not read"), never 0 / '' / "dead".

import type { PowerAction } from '../shared/config';
import type { Capability, ProcDetail, ProcRow, ProcState } from './types';

export type HelperBody = Record<string, unknown>;

/** Units of a Windows FILETIME (and of the registry's procStart) per second. */
export const FILETIME_UNITS_PER_SECOND = 10_000_000;

/** FILETIME of 1970-01-01T00:00:00Z. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const MAX_PID = 0xffff_ffff;

/** "<lead>: <reason>." with exactly one full stop, whatever the reason ends in. */
export function sentence(lead: string, reason: string): string {
  return `${lead}: ${reason.trim().replace(/[.\s]+$/, '')}.`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PID ? value : null;
}

/** 64-bit values travel as decimal strings (a FILETIME does not fit in a JS number). */
function asUnsignedDecimal(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null;
}

/** Lower-case image name without '.exe': 'Claude.EXE' -> 'claude'. */
export function normaliseProcessName(raw: string, stripExe = true): string {
  const lower = raw.toLowerCase();
  return stripExe && lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

/** Epoch ms of a FILETIME string; null when it is not a plausible process start time. */
export function filetimeToEpochMs(start: string): number | null {
  const filetime = asUnsignedDecimal(start);
  if (filetime === null || filetime <= FILETIME_UNIX_EPOCH) return null;
  const ms = Number((filetime - FILETIME_UNIX_EPOCH) / 10_000n);
  return Number.isSafeInteger(ms) ? ms : null;
}

function parseState(raw: unknown, listed: boolean): ProcState | null {
  switch (raw) {
    case 'ok':
    case 'partial':
    case 'denied':
    case 'exited':
    case 'gone':
      return raw;
    case 'error':
      // Windows refused to open it for a reason other than "access denied" / "no such process".
      // A process the system list contains exists; one it does not contain stays unknown.
      return listed ? 'denied' : null;
    default:
      return null;
  }
}

/** Detail of one helper row; null = the row says nothing usable about the process (unknown). */
export function parseDetail(row: Record<string, unknown>, listed: boolean): ProcDetail | null {
  let state = parseState(row.st, listed);
  if (state === null) return null;

  const path = typeof row.path === 'string' && row.path !== '' ? row.path : null;
  const startEpochMs = typeof row.start === 'string' ? filetimeToEpochMs(row.start) : null;
  const startRaw = startEpochMs !== null ? (row.start as string) : null;
  const cpu = asUnsignedDecimal(row.cpu);
  const io = asUnsignedDecimal(row.io);
  const cpuSeconds = cpu !== null ? Number(cpu) / FILETIME_UNITS_PER_SECOND : null;
  const ioBytes = io !== null ? Number(io) : null;

  // "ok" is a promise that path, start and CPU were read. If one is missing after validation the
  // row is merely alive. I/O counters are an extra and never part of that promise.
  if (state === 'ok' && (path === null || startRaw === null || cpuSeconds === null)) state = 'partial';
  return { state, path, startRaw, startEpochMs, cpuSeconds, ioBytes };
}

export interface MappedSnapshot {
  /** null = the list is missing, empty or contained rows that could not be understood. */
  processes: ProcRow[] | null;
  details: Record<number, ProcDetail>;
  idleSeconds: number | null;
}

export function mapIdleSeconds(body: HelperBody): number | null {
  const idleMs = body.idleMs;
  return typeof idleMs === 'number' && Number.isFinite(idleMs) && idleMs >= 0 ? idleMs / 1000 : null;
}

export function mapSnapshot(body: HelperBody): MappedSnapshot {
  const details: Record<number, ProcDetail> = {};
  const idleSeconds = mapIdleSeconds(body);
  if (!Array.isArray(body.processes)) return { processes: null, details, idleSeconds };

  // The cmdlet tier reports names without the extension, so a process really called
  // "tool.exe.exe" must not lose a second '.exe' there.
  const stripExe = body.nameStyle !== 'noext';
  const processes: ProcRow[] = [];
  let trustworthy = true;

  for (const row of body.processes as unknown[]) {
    const pid = isRecord(row) ? asPid(row.pid) : null;
    if (!isRecord(row) || pid === null) {
      trustworthy = false;
      continue;
    }
    const listed = row.listed !== false;
    if (listed) {
      if (typeof row.name !== 'string') {
        trustworthy = false;
        continue;
      }
      processes.push({ pid, ppid: asPid(row.ppid), name: normaliseProcessName(row.name, stripExe) });
    }
    if (row.st !== undefined) {
      const detail = parseDetail(row, listed);
      if (detail) details[pid] = detail;
    }
  }

  // An empty list is a failed query, not "nothing is running"; a list with unreadable rows may be
  // hiding the one process that matters. Both count as "the list could not be read".
  const usable = trustworthy && processes.length > 0;
  return { processes: usable ? processes : null, details, idleSeconds };
}

export function mapProbe(body: HelperBody): Record<number, ProcDetail> {
  const details: Record<number, ProcDetail> = {};
  if (!Array.isArray(body.processes)) return details;
  for (const row of body.processes as unknown[]) {
    if (!isRecord(row)) continue;
    const pid = asPid(row.pid);
    if (pid === null) continue;
    // A probed pid was never looked up in the system list, so an unexplained failure stays unknown.
    const detail = parseDetail(row, false);
    if (detail) details[pid] = detail;
  }
  return details;
}

/** Integer PIDs worth sending to the helper (it would coerce 1.5 to 2). Deduplicated, capped. */
export function cleanPids(pids: readonly unknown[], limit = 4096): number[] {
  const out = new Set<number>();
  for (const pid of pids) {
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID) out.add(pid);
    if (out.size >= limit) break;
  }
  return [...out];
}

/** Process names for the helper's detail filter: lower-case, no '.exe', no empty needles. */
export function cleanNames(names: readonly unknown[], limit = 64): string[] {
  const out = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const clean = normaliseProcessName(name.trim());
    if (clean !== '' && clean.length <= 260) out.add(clean);
    if (out.size >= limit) break;
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Power capability
// ---------------------------------------------------------------------------------------------

export type Privilege = 'present' | 'absent' | 'unknown';

/** What Windows reported about its power features. null inside = that fact is unknown. */
export interface PowerFacts {
  shutdownPrivilege: Privilege;
  hibernateAllowed: boolean | null;
  suspendAllowed: boolean | null;
  /** Classic sleep (S1 / S2 / S3) exists; null = the firmware's states were not reported. */
  classicSleep: boolean | null;
  modernStandby: boolean | null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function parsePowerFacts(body: HelperBody): PowerFacts {
  const privilege = body.shutdownPrivilege;
  const states = [asBool(body.s1), asBool(body.s2), asBool(body.s3)];
  const classicSleep = states.includes(true) ? true : states.every((state) => state === false) ? false : null;
  return {
    shutdownPrivilege: privilege === 'present' || privilege === 'absent' ? privilege : 'unknown',
    hibernateAllowed: asBool(body.hibernateAllowed),
    suspendAllowed: asBool(body.suspendAllowed),
    classicSleep,
    modernStandby: asBool(body.modernStandby),
  };
}

export interface CapabilityContext {
  /** null = Windows could not be asked; `problem` says why. */
  facts: PowerFacts | null;
  problem: string | null;
  /** The helper runs without its native code (locked-down PC): sleep states can't be read. */
  limited: boolean;
  /** The System32 tool each action needs exists. */
  tools: { shutdown: boolean; powershell: boolean; rundll32: boolean };
}

const yes = (detail: string): Capability => ({ ok: true, detail });
const no = (detail: string): Capability => ({ ok: false, detail });
const unknown = (detail: string): Capability => ({ ok: null, detail });

/**
 * Shutting down, hibernating and sleeping all need the "shut down the system" user right.
 * null = the right is there; otherwise the answer that blocks the action.
 */
function privilegeBlock(privilege: Privilege): Capability | null {
  if (privilege === 'absent') return no("This Windows account isn't allowed to turn off or suspend this PC.");
  if (privilege === 'unknown') return unknown("Couldn't check whether this Windows account may turn off or suspend this PC.");
  return null;
}

function sleepCapability(facts: PowerFacts, limited: boolean): Capability {
  if (limited) return no("Sleep isn't available because part of this extension's helper can't run on this PC. Use Hibernate instead.");
  if (facts.classicSleep === null) return unknown("Couldn't check which sleep states this PC has.");
  if (!facts.classicSleep) {
    return facts.modernStandby === true
      ? no("This PC uses Modern Standby, which a program can't start. Use Hibernate instead.")
      : no('This PC has no sleep state that a program can start. Use Hibernate instead.');
  }
  if (facts.suspendAllowed === false) return no('Sleep is turned off on this PC.');
  return privilegeBlock(facts.shutdownPrivilege) ?? yes('Allowed by Windows.');
}

function hibernateCapability(facts: PowerFacts): Capability {
  if (facts.hibernateAllowed === false) return no('Hibernation is turned off on this PC.');
  if (facts.hibernateAllowed === null) return unknown("Couldn't check whether hibernation is turned on.");
  return privilegeBlock(facts.shutdownPrivilege) ?? yes('Allowed by Windows.');
}

/** Can `action` run unattended? Pure: decides from facts gathered elsewhere. */
export function describeCapability(action: PowerAction, context: CapabilityContext): Capability {
  const missing = (tool: string) => no(`${tool} is missing from this PC's Windows folder.`);
  switch (action) {
    case 'notify':
      return yes('Nothing happens to this PC; you only get a message.');
    case 'lock':
      return context.tools.rundll32 ? yes('Allowed by Windows. Whether this PC really locked is checked afterwards.') : missing('rundll32.exe');
    case 'shutdown':
    case 'hibernate':
    case 'sleep':
      break;
    default:
      return unknown('Unknown action.');
  }

  if (action === 'sleep' ? !context.tools.powershell : !context.tools.shutdown) {
    return missing(action === 'sleep' ? 'powershell.exe' : 'shutdown.exe');
  }
  if (context.facts === null) {
    const lead = "Couldn't ask Windows whether this is allowed";
    return unknown(context.problem ? sentence(lead, context.problem) : `${lead}.`);
  }
  if (action === 'sleep') return sleepCapability(context.facts, context.limited);
  if (action === 'hibernate') return hibernateCapability(context.facts);
  return privilegeBlock(context.facts.shutdownPrivilege) ?? yes('Allowed by Windows.');
}
