// One scan = "what is every Claude Code session on this machine doing right now?".
// Reads the session registries, verifies the processes through the Platform, reads transcript
// tails, and returns plain data. It decides nothing about power; core/evaluate.ts does.
//
// The scanner's own rule: a session is left out only with proof that it is gone, and it counts as
// finished only when everything about it could be read. Whatever could not be looked at is said
// in `errors`, and a non-empty `errors` keeps the PC on.

import * as os from 'node:os';

import type { ForeignRoot, Platform, ProcDetail, ProcRow } from '../platform/types';
import { INT_BOUNDS } from '../shared/config';
import { findStrays, type StrayCandidate } from './claudeProcess';
import { CronJobs } from './cronJobs';
import { ChildActivity, busyChildren, descendantsOf, indexProcesses } from './processTree';
import { judgeLiveness, readRegistry, writtenByAnotherSystem, type RegistryEntry } from './registry';
import { addForeignRoots, configuredRoots, openRoot, type OpenRoot, type ScanRoot } from './roots';
import { GuardedFs, nodeFs, type FsApi } from './scannerFs';
import { guardHits } from './scannerGuards';
import { readDetails, readSnapshot, unseenMachine, type Machine } from './scannerMachine';
import {
  compareSessions,
  folderOf,
  judgeSession,
  latest,
  newestOf,
  pendingWakeupSeconds,
  sessionIgnoreKey,
  summariseSubagents,
  unknownTurn,
  withUniqueKeys,
  type SubagentSummary,
} from './scannerSession';
import { Problems, errorText, isMissing, isRecord, locationKey, mapLimit, notNull } from './scannerSupport';
import { TranscriptFinder, checkTranscript, listSubagentFiles, type TranscriptFile } from './scannerTranscripts';
import { TurnCache } from './transcript';
import type { ChildProcessInfo, Liveness, ScanResult, Session, SessionOrigin, StrayProcess, TurnInfo } from './types';
import { WideSweep, accountedStrays, adoptedQuietSeconds, planBackstop, type SweptTranscript } from './wideSweep';

export { isClaudeCodeProcess } from './claudeProcess';
export { guardPatternMatches } from './scannerGuards';

export interface ScanRequest {
  quietSeconds: number;
  guardPatterns: readonly string[];
  waitForChildProcesses: boolean;
  extraClaudeDirs: readonly string[];
  scanWsl: boolean;
  /** Ignore keys the user set ("don't wait for this"). */
  ignores: ReadonlySet<string>;
  /** Re-run the wide transcript sweep now instead of reusing the cached one (final gate). */
  forceWide: boolean;
}

export interface ScannerOptions {
  platform: Platform;
  /** Defaults to os.homedir(). */
  homeDir?: string;
  /** Defaults to process.env (CLAUDE_CONFIG_DIR is read from it). */
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to Date.now. */
  now?: () => number;
  /** Test seam; defaults to node:fs. Transcript tails are always read through node:fs. */
  fs?: FsApi;
  /** Test seam: how long one file operation in a foreign root may take. Default 3000 ms. */
  foreignFsTimeoutMs?: number;
}

const DEFAULT_FOREIGN_FS_TIMEOUT_MS = 3000;
/** Processes whose detail every snapshot carries, registered or not. */
const SESSION_PROCESS_NAMES = ['claude'];
const SESSION_CONCURRENCY = 4;
const MAX_LISTED_CHILDREN = 10;
/** Clocks of two file systems differ a little; beyond this a write time is from the future. */
const FUTURE_WRITE_TOLERANCE_MS = 60_000;

/** The request with every field checked. Anything unreadable takes the value that waits for more. */
interface Rules {
  quietSeconds: number;
  guardPatterns: string[];
  waitForChildProcesses: boolean;
  extraClaudeDirs: string[];
  scanWsl: boolean;
  ignores: ReadonlySet<string>;
  forceWide: boolean;
}

interface ScanContext {
  nowMs: number;
  rules: Rules;
  problems: Problems;
  /** Transcripts whose turn was read in this scan; every other one leaves the turn cache. */
  turnPaths: Set<string>;
  /** Transcripts that belong to a session of this scan (as location keys). */
  claimed: Set<string>;
}

interface Registered {
  root: OpenRoot;
  entry: RegistryEntry;
}

interface LiveSession extends Registered {
  liveness: Exclude<Liveness, 'none'>;
}

interface Families {
  /** PIDs of the live sessions of this system. */
  sessionPids: Set<number>;
  /** Every process below one of them. */
  descendants: Set<number>;
  /** Busy processes below each session PID; empty while that check is off. */
  busyChildren: Map<number, ChildProcessInfo[]>;
}

interface Processes {
  families: Families;
  /** Claude processes nobody registered; null = the process list could not be read. */
  strays: StrayCandidate[] | null;
  /** Busy processes below each stray; empty while that check is off. */
  strayChildren: Map<number, ChildProcessInfo[]>;
}

/** What is known about a session before its files are read. */
interface Subject {
  key: string;
  origin: SessionOrigin;
  liveness: Liveness;
  root: OpenRoot;
  pid: number | null;
  sessionId: string;
  name: string;
  cwd: string;
  folder: string;
  entrypoint: string;
  startedAtMs: number | null;
  transcripts: TranscriptFile[];
  children: ChildProcessInfo[];
  /** How long it has to be quiet to count as finished. */
  quietSeconds: number;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readRules(request: unknown, problems: Problems): Rules {
  const raw = isRecord(request) ? request : {};
  const quiet = raw.quietSeconds;
  // A quiet time below the settings' own floor can only come from a caller that skipped validation.
  const quietKnown = typeof quiet === 'number' && Number.isFinite(quiet) && quiet >= INT_BOUNDS.quietSeconds[0];
  if (!quietKnown) problems.add("The quiet time for this check is missing or too short, so no session can count as finished.");
  return {
    // Without a usable quiet time nothing has ever been quiet for long enough.
    quietSeconds: quietKnown ? quiet : Infinity,
    guardPatterns: strings(raw.guardPatterns),
    waitForChildProcesses: raw.waitForChildProcesses !== false,
    extraClaudeDirs: strings(raw.extraClaudeDirs),
    scanWsl: raw.scanWsl !== false,
    ignores: raw.ignores instanceof Set ? (raw.ignores as ReadonlySet<string>) : new Set<string>(),
    forceWide: raw.forceWide !== false,
  };
}

function isForeignRoot(value: unknown): value is ForeignRoot {
  return isRecord(value) && typeof value.path === 'string' && value.path !== '' && typeof value.label === 'string';
}

/**
 * Its PID belongs to another system: the entry sits in a foreign root, or was written by another
 * OS into a folder shared with this one.
 */
function isForeignEntry({ root, entry }: Registered, platform: Platform): boolean {
  return root.root.kind === 'foreign' || writtenByAnotherSystem(entry, platform.id);
}

/**
 * Drops the entries whose process is provably gone. Foreign entries are all kept: their PIDs
 * belong to another system, so no process here says anything about them.
 */
function keepLiving(registered: readonly Registered[], machine: Machine, platform: Platform): LiveSession[] {
  const names = new Map((machine.processes ?? []).map((row) => [row.pid, row.name]));
  const living: LiveSession[] = [];
  for (const session of registered) {
    const { root, entry } = session;
    if (isForeignEntry(session, platform)) {
      living.push({ root, entry, liveness: 'foreign' });
      continue;
    }
    const detail = machine.details.get(entry.pid) ?? null;
    const verdict = judgeLiveness(entry, detail, names.get(entry.pid) ?? null, platform.procStartUnitsPerSecond);
    if (verdict !== 'dead') living.push({ root, entry, liveness: verdict });
  }
  return living;
}

function toStrayProcess(stray: StrayCandidate, accounted: ReadonlySet<number>, children: ReadonlyMap<number, ChildProcessInfo[]>): StrayProcess {
  return {
    pid: stray.pid,
    name: stray.name,
    path: stray.path,
    accounted: accounted.has(stray.pid),
    ignoreKey: stray.ignoreKey,
    ignored: stray.ignored,
    children: (children.get(stray.pid) ?? []).slice(0, MAX_LISTED_CHILDREN),
  };
}

/** Per adopted path: does the session judged from it keep the PC on? */
function blockingByPath(files: readonly SweptTranscript[], sessions: readonly (Session | null)[]): Map<string, boolean> {
  const blocking = new Map<string, boolean>();
  files.forEach((file, index) => {
    const session = sessions[index];
    if (session !== null && session !== undefined) blocking.set(file.path, session.working && !session.ignored);
  });
  return blocking;
}

function earliest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

export class Scanner {
  private readonly platform: Platform;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly fsApi: FsApi;
  private readonly foreignFsTimeoutMs: number;

  private readonly turns = new TurnCache();
  private readonly cronJobs = new CronJobs();
  private readonly transcripts = new TranscriptFinder();
  private readonly sweep = new WideSweep();
  private readonly childActivity = new ChildActivity();
  /** Processes below a session or a stray in the previous scan: the next snapshot is asked for their detail. */
  private knownDescendants: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ScannerOptions) {
    this.platform = options.platform;
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.fsApi = options.fs ?? nodeFs;
    this.foreignFsTimeoutMs = options.foreignFsTimeoutMs ?? DEFAULT_FOREIGN_FS_TIMEOUT_MS;
  }

  /** Never rejects. Anything that went wrong is in result.errors (which blocks). */
  scan(request: ScanRequest): Promise<ScanResult> {
    // Scans share the caches and the CPU baselines, so they run one after another.
    const result = this.queue.then(() => this.scanSafely(request));
    this.queue = result;
    return result;
  }

  private async scanSafely(request: ScanRequest): Promise<ScanResult> {
    const startedAtMs = this.clock();
    try {
      return await this.runScan(request, startedAtMs);
    } catch (error) {
      // Every step reports its own failures, so this is a bug of ours. It must end in a result
      // that keeps the PC on, not in a rejection the caller may or may not handle.
      return {
        startedAtMs,
        completedAtMs: this.clock(),
        sessions: [],
        errors: [`The check for Claude sessions failed unexpectedly: ${errorText(error)}.`],
        roots: [],
        strays: null,
        unclaimedRecent: [],
        idleSeconds: null,
        guardHits: null,
        processListOk: false,
        helperProblem: this.helperProblem(),
      };
    }
  }

  /**
   * Every age in a scan is measured from its START: a file written while the scan runs then reads
   * as "just written" rather than as written in the future.
   */
  private async runScan(request: ScanRequest, nowMs: number): Promise<ScanResult> {
    const problems = new Problems();
    const scan: ScanContext = { nowMs, rules: readRules(request, problems), problems, turnPaths: new Set(), claimed: new Set() };

    const roots = await this.openRoots(scan);
    const registered = (await Promise.all(roots.map((root) => this.registeredIn(root, scan)))).flat();
    // The processes are looked at AFTER the registries were read: a session that starts in
    // between then shows up as a Claude process without an entry (which blocks), not as nothing.
    const machine = await this.inspectMachine(registered, scan);
    const living = keepLiving(registered, machine, this.platform);
    const { families, strays, strayChildren } = await this.inspectProcesses(living, machine, scan);
    const registeredSessions = await mapLimit(living, SESSION_CONCURRENCY, (session) => this.describeRegistered(session, families, scan));

    const swept = await this.sweep.transcripts(roots, scan.rules.forceWide, nowMs, problems);
    const unclaimed = swept.filter((file) => !scan.claimed.has(locationKey(file.path)));
    const backstop = planBackstop(unclaimed, strays, nowMs, scan.rules.quietSeconds);
    const adopted = await mapLimit(backstop.adopted, SESSION_CONCURRENCY, (file) => this.describeUnclaimed(file, roots, scan));
    const accounted = accountedStrays(backstop, blockingByPath(backstop.adopted, adopted));

    this.turns.prune(scan.turnPaths);
    this.cronJobs.forgetUnused(nowMs);
    this.transcripts.forgetUnused();
    return {
      startedAtMs: nowMs,
      completedAtMs: this.clock(),
      sessions: withUniqueKeys([...registeredSessions, ...adopted.filter(notNull)]).sort(compareSessions),
      errors: problems.list(),
      roots: roots.map((root) => root.status),
      strays: strays === null ? null : strays.map((stray) => toStrayProcess(stray, accounted, strayChildren)),
      unclaimedRecent: backstop.unclaimedRecent,
      idleSeconds: machine.idleSeconds,
      guardHits: guardHits(scan.rules.guardPatterns, machine.processes),
      processListOk: machine.processes !== null,
      helperProblem: this.helperProblem(),
    };
  }

  /** An injected clock that fails must not fail the scan. */
  private clock(): number {
    try {
      const value = this.now();
      if (Number.isFinite(value)) return value;
    } catch {
      // fall through to the system clock
    }
    return Date.now();
  }

  private helperProblem(): string | null {
    try {
      const problem: unknown = this.platform.helperStatus().problem;
      return typeof problem === 'string' && problem !== '' ? problem : null;
    } catch (error) {
      return `The process helper's status couldn't be read: ${errorText(error)}.`;
    }
  }

  // --- roots and registries ----------------------------------------------------------------------

  private async openRoots(scan: ScanContext): Promise<OpenRoot[]> {
    const plan = configuredRoots(this.homeDir, this.env, scan.rules.extraClaudeDirs);
    for (const problem of plan.problems) scan.problems.add(problem);
    if (scan.rules.scanWsl) addForeignRoots(plan.roots, await this.discoverForeignRoots(scan));
    return Promise.all(plan.roots.map((root, index) => this.inspectRoot(root, index, scan)));
  }

  private async discoverForeignRoots(scan: ScanContext): Promise<ForeignRoot[]> {
    try {
      const found: unknown = await this.platform.foreignRoots();
      if (!isRecord(found)) throw new Error('no usable answer');
      if (typeof found.problem === 'string' && found.problem !== '') scan.problems.add(found.problem);
      return Array.isArray(found.roots) ? found.roots.filter(isForeignRoot) : [];
    } catch (error) {
      scan.problems.add(`Couldn't look for Claude sessions in other systems on this PC (WSL): ${errorText(error)}.`);
      return [];
    }
  }

  private async inspectRoot(root: ScanRoot, index: number, scan: ScanContext): Promise<OpenRoot> {
    const fs = new GuardedFs(this.fsApi, root.kind === 'foreign' ? this.foreignFsTimeoutMs : null);
    const { open, problem } = await openRoot(root, index, fs);
    if (problem !== null) scan.problems.add(problem);
    return open;
  }

  private async registeredIn(root: OpenRoot, scan: ScanContext): Promise<Registered[]> {
    return (await readRegistry(root, scan.problems)).map((entry) => ({ root, entry }));
  }

  // --- processes ---------------------------------------------------------------------------------

  private async inspectMachine(registered: readonly Registered[], scan: ScanContext): Promise<Machine> {
    const sessionPids = registered.filter((session) => !isForeignEntry(session, this.platform)).map(({ entry }) => entry.pid);
    const detailPids = [...new Set([...sessionPids, ...this.knownDescendants])];
    try {
      return readSnapshot(await this.platform.snapshot({ detailPids, detailNames: [...SESSION_PROCESS_NAMES] }), scan.problems);
    } catch (error) {
      scan.problems.add(`The list of running programs couldn't be read: ${errorText(error)}.`);
      return unseenMachine();
    }
  }

  /** No answer leaves every child unknown, and a child nothing is known about counts as busy. */
  private async probe(pids: number[]): Promise<Map<number, ProcDetail>> {
    try {
      return readDetails(await this.platform.probe(pids));
    } catch {
      return new Map();
    }
  }

  /**
   * The processes below each session, the Claude processes nobody registered (strays), and the
   * processes below each stray. Descendants are found twice: first by parent PID alone (which is
   * what gets probed, and whose detail the next snapshot is asked for), then again with start
   * times, which removes the leftovers of reused parent PIDs. Which Claude processes are strays is
   * known only after the second pass, so every one that may turn out to be one has its children
   * probed in the same call.
   */
  private async inspectProcesses(living: readonly LiveSession[], machine: Machine, scan: ScanContext): Promise<Processes> {
    const families: Families = { sessionPids: new Set(), descendants: new Set(), busyChildren: new Map() };
    for (const { entry, liveness } of living) {
      if (liveness !== 'foreign') families.sessionPids.add(entry.pid);
    }
    const strayChildren = new Map<number, ChildProcessInfo[]>();
    const processes = machine.processes;
    if (processes === null) return { families, strays: null, strayChildren };

    const { waitForChildProcesses: measure, ignores } = scan.rules;
    const sessionPids = [...families.sessionPids];
    const maybeStrays = findStrays(processes, machine.details, families.sessionPids, ignores).map((stray) => stray.pid);
    const index = indexProcesses(processes);
    const candidates = [...sessionPids, ...maybeStrays].flatMap((pid) => descendantsOf(index, pid, families.sessionPids, () => null));
    this.knownDescendants = [...new Set(candidates.map((row) => row.pid))];

    const details = new Map(machine.details);
    if (measure && this.knownDescendants.length > 0) {
      for (const [pid, detail] of await this.probe(this.knownDescendants)) details.set(pid, detail);
    }
    const sampledAtMs = this.clock();
    const startOf = (pid: number): number | null => details.get(pid)?.startEpochMs ?? null;
    const busyAmong = (rows: ProcRow[]): ChildProcessInfo[] => busyChildren(rows, details, this.childActivity, sampledAtMs, ignores);
    for (const pid of sessionPids) {
      const below = descendantsOf(index, pid, families.sessionPids, startOf);
      for (const row of below) families.descendants.add(row.pid);
      if (measure) families.busyChildren.set(pid, busyAmong(below));
    }
    const strays = findStrays(processes, machine.details, new Set([...sessionPids, ...families.descendants]), ignores);
    // A process belongs to the nearest session or stray above it.
    const owners = new Set([...sessionPids, ...strays.map((stray) => stray.pid)]);
    for (const stray of strays) {
      if (measure) strayChildren.set(stray.pid, busyAmong(descendantsOf(index, stray.pid, owners, startOf)));
    }
    this.childActivity.forgetUnmeasured();

    // A list without a single parent PID (Windows, when the fallback query for them fails) has no
    // tree to walk: "no command is still running" would then be a guess.
    if (measure && owners.size > 0 && !processes.some((row) => row.ppid !== null)) {
      scan.problems.add(
        "Couldn't read which program started which, so commands started by Claude sessions can't be seen. " +
          'Turn off the "Wait For Child Processes" setting to watch without that check.',
      );
    }
    return { families, strays, strayChildren };
  }

  // --- sessions ----------------------------------------------------------------------------------

  private async describeRegistered(session: LiveSession, families: Families, scan: ScanContext): Promise<Session> {
    const { root, entry, liveness } = session;
    return this.describe(
      {
        key: `${root.index}:${entry.pid}:${entry.sessionId || entry.fileName}`,
        origin: 'registry',
        liveness,
        root,
        pid: entry.pid,
        sessionId: entry.sessionId,
        name: entry.name || entry.sessionId.slice(0, 8) || entry.fileName,
        cwd: entry.cwd,
        folder: folderOf(entry.cwd),
        entrypoint: entry.entrypoint,
        startedAtMs: entry.startedAtMs,
        transcripts: await this.transcripts.find(root, entry.sessionId, scan.nowMs, scan.problems),
        children: liveness === 'foreign' ? [] : (families.busyChildren.get(entry.pid) ?? []),
        quietSeconds: scan.rules.quietSeconds,
      },
      scan,
    );
  }

  /** A transcript nobody claims, judged like a session. null when it vanished since the sweep. */
  private async describeUnclaimed(swept: SweptTranscript, roots: readonly OpenRoot[], scan: ScanContext): Promise<Session | null> {
    const root = roots[swept.rootIndex];
    if (root === undefined) return null;
    // The sweep may be half a minute old; the session is judged on the file as it is now.
    const transcript = await checkTranscript(root.fs, swept.path, scan.problems);
    if (transcript === null) return null;
    return this.describe(
      {
        // The same file name can exist under two projects; here each file is a session of its own.
        key: `${root.index}:0:${swept.project}/${swept.sessionId}`,
        origin: 'transcript',
        liveness: 'none',
        root,
        pid: null,
        sessionId: swept.sessionId,
        name: swept.sessionId.slice(0, 8),
        cwd: '',
        folder: swept.project,
        entrypoint: '',
        startedAtMs: null,
        transcripts: [transcript],
        // Its stray's children are listed under the stray: which session they belong to is unknown.
        children: [],
        quietSeconds: adoptedQuietSeconds(scan.rules.quietSeconds),
      },
      scan,
    );
  }

  private async describe(subject: Subject, scan: ScanContext): Promise<Session> {
    const { root, transcripts } = subject;
    for (const file of transcripts) scan.claimed.add(locationKey(file.path));
    const newest = newestOf(transcripts);
    const turn = await this.turnOf(root, transcripts, newest, scan);
    const subagents = await this.subagentsOf(root, transcripts, subject.quietSeconds, scan);
    // A scheduled task lives in the session's process, so only a session with one can have it.
    const cronInSeconds = subject.origin === 'registry' ? await this.cronJobsOf(root, transcripts, scan) : null;
    const lastActivityMs = latest([...transcripts.map((file) => file.mtimeMs), subagents.newestMtimeMs, subject.startedAtMs]);
    const silenceSeconds = this.measureSilence(subject.name, lastActivityMs, scan);
    const judgement = judgeSession({
      turn: turn.state,
      activeSubagents: subagents.active,
      wakeupInSeconds: earliest(pendingWakeupSeconds(turn, newest, scan.nowMs), cronInSeconds),
      busyChild: subject.children.find((child) => !child.ignored) ?? null,
      silenceSeconds,
      quietSeconds: subject.quietSeconds,
    });
    const ignoreKey = sessionIgnoreKey(root.index, subject.pid, subject.sessionId, newest, subagents.newestMtimeMs);
    return {
      key: subject.key,
      origin: subject.origin,
      liveness: subject.liveness,
      pid: subject.pid,
      sessionId: subject.sessionId,
      name: subject.name,
      cwd: subject.cwd,
      folder: subject.folder,
      entrypoint: subject.entrypoint,
      rootLabel: root.root.label,
      startedAtMs: subject.startedAtMs,
      transcriptPath: newest?.path ?? null,
      lastActivityMs,
      silenceSeconds,
      turn: turn.state,
      turnReason: turn.reason,
      turnDetail: turn.detail,
      activeSubagents: subagents.active,
      subagents: subagents.subagents,
      children: subject.children.slice(0, MAX_LISTED_CHILDREN),
      ...judgement,
      ignoreKey,
      ignored: scan.rules.ignores.has(ignoreKey),
    };
  }

  private async turnOf(
    root: OpenRoot,
    transcripts: readonly TranscriptFile[],
    newest: TranscriptFile | null,
    scan: ScanContext,
  ): Promise<TurnInfo> {
    if (newest === null) return unknownTurn('noTranscript');
    const quietMs = scan.rules.quietSeconds * 1000;
    // One session id, two files that both changed lately: no telling which one is the conversation.
    const writtenLately = transcripts.filter((file) => !(scan.nowMs - file.mtimeMs > quietMs));
    if (writtenLately.length >= 2) return unknownTurn('ambiguousTranscripts');
    return this.readTurn(root, newest, true, scan);
  }

  /** `mainThread`: the session's own transcript rather than a subagent's. */
  private async readTurn(root: OpenRoot, file: TranscriptFile, mainThread: boolean, scan: ScanContext): Promise<TurnInfo> {
    scan.turnPaths.add(file.path);
    try {
      return await root.fs.guard(() => this.turns.get(file.path, file.size, file.mtimeMs, { mainThread }));
    } catch (error) {
      scan.problems.add(`Couldn't read the transcript ${file.path}: ${errorText(error)}.`);
      return unknownTurn('cannotRead', errorText(error));
    }
  }

  /** Subagents of every copy of the transcript: with duplicates there is no telling which one is live. */
  private async subagentsOf(
    root: OpenRoot,
    transcripts: readonly TranscriptFile[],
    quietSeconds: number,
    scan: ScanContext,
  ): Promise<SubagentSummary> {
    const files = (await Promise.all(transcripts.map((file) => listSubagentFiles(root.fs, file.path, scan.problems)))).flat();
    return summariseSubagents(files, (file) => this.readTurn(root, file, false, scan), scan.nowMs, quietSeconds);
  }

  /**
   * Seconds until the soonest CronCreate task of the session fires (0 = can't tell when), or null
   * when none is pending. Every copy of the transcript counts: there is no telling which is live.
   */
  private async cronJobsOf(root: OpenRoot, transcripts: readonly TranscriptFile[], scan: ScanContext): Promise<number | null> {
    let soonest: number | null = null;
    for (const file of transcripts) {
      try {
        const seconds = await root.fs.guard(() => this.cronJobs.pendingSeconds(file.path, file.size, file.mtimeMs, scan.nowMs));
        soonest = earliest(soonest, seconds);
      } catch (error) {
        // Removed since it was found: the turn reader says so already.
        if (!isMissing(error)) scan.problems.add(`Couldn't check the transcript ${file.path} for scheduled tasks: ${errorText(error)}.`);
      }
    }
    return soonest;
  }

  private measureSilence(name: string, lastActivityMs: number | null, scan: ScanContext): number | null {
    if (lastActivityMs === null) return null;
    if (lastActivityMs > scan.nowMs + FUTURE_WRITE_TOLERANCE_MS) {
      // Such a session reads as "written 0 s ago" for ever. Saying why is the least we can do.
      scan.problems.add(`The session "${name}" was last written at a time in the future. Check this PC's clock.`);
    }
    return Math.max(0, (scan.nowMs - lastActivityMs) / 1000);
  }
}
