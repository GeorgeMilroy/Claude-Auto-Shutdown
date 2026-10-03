// Windows backend of `Platform`.
//
// Everything that READS the machine goes through one long-lived PowerShell helper
// (resources/win-helper.ps1, see winHelper.ts). Everything that CHANGES it - shut down, hibernate,
// sleep, lock - is a separate one-shot system binary (winPower.ts). The helper has no power
// operation at all, so a bug in the read path can never turn the PC off.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { POWER_ACTIONS, type PowerAction } from '../shared/config';
import { run } from './exec';
import type { PlatformOptions } from './index';
import { AlertProcess, buildAlertLaunch, inertAlert, type AlertLaunch } from './winAlert';
import { buildHelperLaunch, WinHelper, type HelperLaunch, type WinHelperOptions } from './winHelper';
import { executePowerAction, powershellPath, system32Path, type PowerDeps, type RunFn } from './winPower';
import {
  cleanNames,
  cleanPids,
  describeCapability,
  FILETIME_UNITS_PER_SECOND,
  mapIdleSeconds,
  mapProbe,
  mapSnapshot,
  parsePowerFacts,
  sentence,
  type PowerFacts,
  type Privilege,
} from './winRows';
import { nodeWslFs, WslRootFinder, type WslFs } from './winWsl';
import type {
  ActionResult,
  Capability,
  CountdownAlert,
  CountdownAlertOptions,
  ForeignRoot,
  HelperStatus,
  Platform,
  ProcDetail,
  SnapshotRequest,
  SystemSnapshot,
} from './types';

/** Seams for tests. Production code passes none of these. */
export interface WindowsPlatformOverrides {
  /** %SystemRoot%; default: the environment's. */
  systemRoot?: string | null;
  /** Start this instead of the real helper (a fake that speaks the same protocol). */
  helperLaunch?: HelperLaunch;
  /** Extra arguments for the real helper script (-NoNative, -SimulateClm). */
  helperArgs?: string[];
  helperTimings?: Pick<WinHelperOptions, 'helloTimeoutMs' | 'requestTimeoutMs' | 'stopGraceMs' | 'restartBackoffMs'>;
  /** Runs power commands and wsl.exe. Default: the real process runner. */
  run?: RunFn;
  /** Start this instead of the real countdown window. `nowMs` = when the alert was asked for. */
  alertLaunch?(options: CountdownAlertOptions, nowMs: number): AlertLaunch | null;
  wslFs?: WslFs;
  delay?(ms: number): Promise<void>;
}

/** How old the last snapshot's name list may be to decide whether WSL is running. */
const NAMES_MAX_AGE_MS = 60_000;
/** `whoami` is asked again at most this often when it gave no answer. */
const WHOAMI_RETRY_MS = 10 * 60_000;

const KEEP_AWAKE_LIMITED = "Keep-awake isn't available because part of this extension's helper can't run on this PC.";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WindowsPlatform implements Platform {
  readonly id = 'windows' as const;
  readonly osName = 'Windows';
  readonly procStartUnitsPerSecond = FILETIME_UNITS_PER_SECOND;
  readonly experimental = false;

  private readonly systemRoot: string | null;
  private readonly environment: string | null;
  private readonly helper: WinHelper;
  private readonly runCommand: RunFn;
  private readonly wsl: WslRootFinder;
  private readonly alerts = new Set<AlertProcess>();
  private readonly delay: (ms: number) => Promise<void>;

  private lastNames: { names: ReadonlySet<string>; at: number } | null = null;
  /** What the controller asked for; re-applied when the helper that held it is replaced. */
  private keepAwakeWanted = false;
  /** Generation of the helper process that holds the power request, else null. */
  private keepAwakeHeldBy: number | null = null;
  private keepAwakeQueue: Promise<unknown> = Promise.resolve();
  /** The cmdlet tier cannot read the token; `whoami` can, and the answer never changes. */
  private whoamiPrivilege: Privilege = 'unknown';
  private whoamiNotBefore = 0;
  private disposed = false;

  constructor(
    private readonly options: PlatformOptions,
    private readonly overrides: WindowsPlatformOverrides = {},
  ) {
    this.systemRoot = overrides.systemRoot !== undefined ? overrides.systemRoot : process.env.SystemRoot || process.env.windir || null;
    this.runCommand = overrides.run ?? run;
    this.delay = overrides.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.environment = overrides.helperLaunch ? null : this.findEnvironmentProblem();
    this.helper = new WinHelper({
      launch: this.helperLaunch(),
      launchProblem: this.environment ?? undefined,
      log: options.log,
      ...overrides.helperTimings,
    });
    this.wsl = new WslRootFinder({
      wslExe: this.existingSystem32('wsl.exe'),
      run: this.runCommand,
      fs: overrides.wslFs ?? nodeWslFs,
      now: () => performance.now(),
    });
  }

  environmentProblem(): string | null {
    return this.environment;
  }

  helperStatus(): HelperStatus {
    return this.helper.status();
  }

  /** PID of the running helper process (diagnostics and tests). */
  helperPid(): number | null {
    return this.helper.pid;
  }

  async snapshot(request: SnapshotRequest): Promise<SystemSnapshot> {
    const failed = (problem: string): SystemSnapshot => ({ takenAtMs: Date.now(), idleSeconds: null, processes: null, details: {}, problem });
    try {
      const reply = await this.helper.call('snapshot', { pids: cleanPids(request.detailPids), detailNames: cleanNames(request.detailNames) });
      if (!reply.ok) {
        this.lastNames = null;
        return failed(sentence("The list of running programs couldn't be read", reply.error));
      }
      const mapped = mapSnapshot(reply.body);
      this.rememberNames(mapped.processes?.map((row) => row.name) ?? null);
      void this.syncKeepAwake();
      return {
        takenAtMs: Date.now(),
        idleSeconds: mapped.idleSeconds,
        processes: mapped.processes,
        details: mapped.details,
        problem: mapped.processes === null ? 'The process helper sent a list of running programs that could not be understood.' : null,
      };
    } catch (error) {
      this.lastNames = null;
      return failed(sentence("The list of running programs couldn't be read", describeError(error)));
    }
  }

  async probe(pids: number[]): Promise<Record<number, ProcDetail>> {
    try {
      const wanted = cleanPids(pids);
      if (wanted.length === 0) return {};
      const reply = await this.helper.call('probe', { pids: wanted });
      return reply.ok ? mapProbe(reply.body) : {};
    } catch {
      return {};
    }
  }

  async idleSeconds(): Promise<number | null> {
    try {
      const reply = await this.helper.call('idle');
      return reply.ok ? mapIdleSeconds(reply.body) : null;
    } catch {
      return null;
    }
  }

  async capability(action: PowerAction): Promise<Capability> {
    const tools = {
      shutdown: this.existingSystem32('shutdown.exe') !== null,
      rundll32: this.existingSystem32('rundll32.exe') !== null,
      powershell: this.existingSystem32('WindowsPowerShell', 'v1.0', 'powershell.exe') !== null,
    };
    if (!(POWER_ACTIONS as readonly string[]).includes(action) || action === 'notify' || action === 'lock') {
      return describeCapability(action, { facts: null, problem: null, limited: false, tools });
    }
    try {
      const { facts, problem } = await this.powerFacts();
      return describeCapability(action, { facts, problem, limited: this.isLimited(), tools });
    } catch (error) {
      return describeCapability(action, { facts: null, problem: describeError(error), limited: false, tools });
    }
  }

  execute(action: PowerAction, options: { force: boolean }): Promise<ActionResult> {
    return executePowerAction(action, options, this.powerDeps());
  }

  /**
   * What a power action is run with. Public only so that a test can check the wiring without
   * running an action: the kill switch always comes from the real environment.
   */
  powerDeps(): PowerDeps {
    return {
      env: process.env,
      systemRoot: this.systemRoot,
      run: this.runCommand,
      // A lock is confirmed by a process that appears AFTER the command: never from a cached list.
      processNames: () => this.processNames(0).then((names) => (names ? [...names] : null)),
      delay: this.delay,
    };
  }

  keepAwake(on: boolean): Promise<{ ok: boolean; detail: string }> {
    this.keepAwakeWanted = on === true;
    return this.inKeepAwakeOrder(() => this.applyKeepAwake());
  }

  startCountdownAlert(options: CountdownAlertOptions): CountdownAlert {
    // Taken first: `options.seconds` are the seconds left at this very moment.
    const nowMs = Date.now();
    if (this.disposed) return inertAlert();
    const launch = this.alertLaunch(options, nowMs);
    if (!launch) {
      this.options.log('The countdown warning window could not be started (unusable options, or the Windows folder is unknown).');
      return inertAlert();
    }
    const alert = new AlertProcess(launch, this.options.log);
    this.alerts.add(alert);
    void alert.exited.then(() => this.alerts.delete(alert));
    return alert;
  }

  async foreignRoots(): Promise<{ roots: ForeignRoot[]; problem: string | null }> {
    try {
      return await this.wsl.find(await this.processNames(NAMES_MAX_AGE_MS));
    } catch (error) {
      return { roots: [], problem: sentence("WSL couldn't be checked", describeError(error)) };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.keepAwakeWanted = false;
    for (const alert of this.alerts) alert.stop();
    this.alerts.clear();
    // Ending the helper also releases its keep-awake request: Windows ties it to the process.
    await this.helper.dispose();
    this.keepAwakeHeldBy = null;
  }

  private existingSystem32(...segments: string[]): string | null {
    if (!this.systemRoot) return null;
    const file = system32Path(this.systemRoot, ...segments);
    return fs.existsSync(file) ? file : null;
  }

  private findEnvironmentProblem(): string | null {
    if (!this.systemRoot) return "Windows didn't say where it is installed (SystemRoot is not set), so the programs running on this PC can't be checked.";
    if (!fs.existsSync(powershellPath(this.systemRoot))) {
      return "Windows PowerShell (powershell.exe) wasn't found on this PC, so the programs running on it can't be checked.";
    }
    if (!fs.existsSync(path.join(this.options.extensionPath, 'resources', 'win-helper.ps1'))) {
      return "A file of this extension is missing (resources\\win-helper.ps1), so the programs running on this PC can't be checked. Reinstall Claude Auto Shutdown.";
    }
    return null;
  }

  private helperLaunch(): HelperLaunch | null {
    if (this.overrides.helperLaunch) return this.overrides.helperLaunch;
    if (this.environment !== null || !this.systemRoot) return null;
    const launch = buildHelperLaunch(this.systemRoot, this.options.extensionPath, process.pid);
    return { ...launch, args: [...launch.args, ...(this.overrides.helperArgs ?? [])] };
  }

  private alertLaunch(options: CountdownAlertOptions, nowMs: number): AlertLaunch | null {
    if (this.overrides.alertLaunch) return this.overrides.alertLaunch(options, nowMs);
    return this.systemRoot ? buildAlertLaunch(this.systemRoot, this.options.extensionPath, options, process.pid, nowMs) : null;
  }

  /** The helper runs without its native code: no idle time, no keep-awake, no sleep states. */
  private isLimited(): boolean {
    return this.helper.native === false;
  }

  private rememberNames(names: string[] | null): void {
    this.lastNames = names ? { names: new Set(names), at: performance.now() } : null;
  }

  /**
   * Lower-case names of the running processes: the last snapshot's when it is younger than
   * `maxAgeMs`, else a new names-only snapshot (no process is opened). null = can't tell.
   */
  private async processNames(maxAgeMs: number): Promise<ReadonlySet<string> | null> {
    if (this.lastNames && performance.now() - this.lastNames.at < maxAgeMs) return this.lastNames.names;
    const reply = await this.helper.call('snapshot', { pids: [], detailNames: [] });
    const processes = reply.ok ? mapSnapshot(reply.body).processes : null;
    this.rememberNames(processes?.map((row) => row.name) ?? null);
    return this.lastNames?.names ?? null;
  }

  private async powerFacts(): Promise<{ facts: PowerFacts | null; problem: string | null }> {
    const reply = await this.helper.call('capability');
    if (!reply.ok) return { facts: null, problem: reply.error };
    const facts = parsePowerFacts(reply.body);
    if (facts.shutdownPrivilege !== 'unknown' || !this.isLimited()) return { facts, problem: null };
    return { facts: { ...facts, shutdownPrivilege: await this.privilegeFromWhoami() }, problem: null };
  }

  /**
   * Cmdlet tier only. `whoami /priv` started from PowerShell is something security tools watch
   * for, so it runs once: a token's privileges do not change while the process lives.
   */
  private async privilegeFromWhoami(): Promise<Privilege> {
    if (this.whoamiPrivilege !== 'unknown' || performance.now() < this.whoamiNotBefore) return this.whoamiPrivilege;
    const reply = await this.helper.call('capability', { allowWhoami: true });
    this.whoamiPrivilege = reply.ok ? parsePowerFacts(reply.body).shutdownPrivilege : 'unknown';
    if (this.whoamiPrivilege === 'unknown') this.whoamiNotBefore = performance.now() + WHOAMI_RETRY_MS;
    return this.whoamiPrivilege;
  }

  /** Keep-awake changes run one after another so that "on, off" can never end as "on". */
  private inKeepAwakeOrder<T>(task: () => Promise<T>): Promise<T> {
    const result = this.keepAwakeQueue.then(task);
    this.keepAwakeQueue = result.catch(() => undefined);
    return result;
  }

  /** After a snapshot: a helper that was restarted lost the power request; ask again. */
  private syncKeepAwake(): Promise<unknown> {
    if (!this.keepAwakeWanted || this.keepAwakeHeldBy === this.helper.generation) return Promise.resolve();
    return this.inKeepAwakeOrder(() => this.applyKeepAwake()).catch(() => undefined);
  }

  private async applyKeepAwake(): Promise<{ ok: boolean; detail: string }> {
    try {
      const heldByRunningHelper = this.keepAwakeHeldBy !== null && this.helper.running && this.keepAwakeHeldBy === this.helper.generation;
      if (!this.keepAwakeWanted) return await this.releaseKeepAwake(heldByRunningHelper);
      if (heldByRunningHelper) return { ok: true, detail: 'Windows is being kept awake.' };
      if (this.disposed) return { ok: false, detail: 'This window no longer controls the PC.' };
      if (this.isLimited()) return { ok: false, detail: KEEP_AWAKE_LIMITED };

      const reply = await this.helper.call('keepAwake', { on: true });
      if (reply.ok && reply.body.held === true) {
        this.keepAwakeHeldBy = reply.generation;
        return { ok: true, detail: 'Windows is being kept awake.' };
      }
      this.keepAwakeHeldBy = null;
      if (this.isLimited()) return { ok: false, detail: KEEP_AWAKE_LIMITED };
      return { ok: false, detail: sentence("Windows couldn't be asked to stay awake", reply.ok ? 'the helper did not confirm it' : reply.error) };
    } catch (error) {
      return { ok: false, detail: sentence('Keep-awake failed', describeError(error)) };
    }
  }

  private async releaseKeepAwake(heldByRunningHelper: boolean): Promise<{ ok: boolean; detail: string }> {
    // The request dies with the helper that made it: nothing to release, and no reason to start one.
    if (!heldByRunningHelper) {
      this.keepAwakeHeldBy = null;
      return { ok: true, detail: 'Windows may go to sleep by itself again.' };
    }
    const reply = await this.helper.call('keepAwake', { on: false });
    if ((reply.ok && reply.body.held === false) || !this.helper.running) {
      this.keepAwakeHeldBy = null;
      return { ok: true, detail: 'Windows may go to sleep by itself again.' };
    }
    return { ok: false, detail: sentence("The keep-awake request couldn't be released", reply.ok ? 'the helper still holds it' : reply.error) };
  }
}

export function createWindowsPlatform(options: PlatformOptions): Platform {
  return new WindowsPlatform(options);
}
