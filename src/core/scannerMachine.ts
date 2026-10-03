// The platform's answers in the form the scanner uses. They cross a module boundary (and, on
// Windows, a process boundary before that), so every field is checked once more here: a value of
// the wrong type becomes null ("could not read"), never 0 / '' / "not running".

import type { ProcDetail, ProcRow, ProcState } from '../platform/types';
import { isRecord, type Problems } from './scannerSupport';

export interface Machine {
  /** Every running process; null = the list could not be read. */
  processes: ProcRow[] | null;
  /** Detail per PID for what was asked for. A PID that is absent is unknown, not gone. */
  details: Map<number, ProcDetail>;
  /** Seconds since the last mouse / keyboard input; null = can't tell. */
  idleSeconds: number | null;
}

const PROC_STATES: ReadonlySet<string> = new Set<ProcState>(['ok', 'partial', 'denied', 'exited', 'gone']);

export function unseenMachine(): Machine {
  return { processes: null, details: new Map(), idleSeconds: null };
}

function asPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function readDetail(value: unknown): ProcDetail | null {
  if (!isRecord(value) || typeof value.state !== 'string' || !PROC_STATES.has(value.state)) return null;
  return {
    state: value.state as ProcState,
    path: typeof value.path === 'string' && value.path !== '' ? value.path : null,
    startRaw: typeof value.startRaw === 'string' && /^\d{1,20}$/.test(value.startRaw) ? value.startRaw : null,
    startEpochMs: finite(value.startEpochMs),
    cpuSeconds: nonNegative(value.cpuSeconds),
    ioBytes: nonNegative(value.ioBytes),
  };
}

/** Detail keyed by PID (a snapshot's `details`, or a probe reply). Unusable entries are left out. */
export function readDetails(raw: unknown): Map<number, ProcDetail> {
  const details = new Map<number, ProcDetail>();
  if (!isRecord(raw)) return details;
  for (const [key, value] of Object.entries(raw)) {
    const pid = /^\d+$/.test(key) ? asPid(Number(key)) : null;
    const detail = readDetail(value);
    if (pid !== null && detail !== null) details.set(pid, detail);
  }
  return details;
}

function imageName(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -'.exe'.length) : lower;
}

/**
 * null when the list is not a list, is empty (this very process is always running, so an empty
 * list is a failed query) or holds a row that cannot be understood: such a list may be hiding
 * exactly the process that matters.
 */
function readProcesses(raw: unknown): ProcRow[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: ProcRow[] = [];
  for (const row of raw as unknown[]) {
    const pid = isRecord(row) ? asPid(row.pid) : null;
    if (!isRecord(row) || pid === null || typeof row.name !== 'string') return null;
    rows.push({ pid, ppid: asPid(row.ppid), name: imageName(row.name) });
  }
  return rows;
}

/** A platform snapshot, checked. What makes it incomplete goes to `problems`. */
export function readSnapshot(raw: unknown, problems: Problems): Machine {
  if (!isRecord(raw)) {
    problems.add("The list of running programs came back in a form that couldn't be understood.");
    return unseenMachine();
  }
  if (typeof raw.problem === 'string' && raw.problem !== '') problems.add(raw.problem);
  const processes = raw.processes === null ? null : readProcesses(raw.processes);
  if (raw.processes !== null && processes === null) {
    const empty = Array.isArray(raw.processes) && raw.processes.length === 0;
    problems.add(
      empty
        ? 'The list of running programs came back empty.'
        : "The list of running programs held entries that couldn't be understood.",
    );
  }
  return { processes, details: readDetails(raw.details), idleSeconds: nonNegative(raw.idleSeconds) };
}
