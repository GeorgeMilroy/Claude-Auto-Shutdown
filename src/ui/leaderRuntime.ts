// The leader-only machinery, assembled: platform backend + scanner + controller. One of these
// exists per machine - in the window that holds the leadership endpoint - and it is the only
// thing that can ever run a power action. windowSession.ts decides when it is built and when it
// is torn down.

import { Controller, systemClock } from '../controller/controller';
import { evaluate } from '../core/evaluate';
import { Scanner } from '../core/scanner';
import type { ScanResult, Verdict } from '../core/types';
import { createPlatform } from '../platform/index';
import type { Platform } from '../platform/types';
import type { Config } from '../shared/config';
import type { LeaderInfo, WindowHello } from '../shared/protocol';
import type { StateDir } from '../shared/stateDir';
import { countdownAlertText, describeCheck } from '../shared/text';
import type { LeaderRuntime, LeaderStart } from './windowSession';

export interface LeaderEnvironment {
  /** Absolute path of the installed extension (the helper scripts live in its resources folder). */
  extensionPath: string;
  stateDir: StateDir;
  self: WindowHello;
  hostname: string;
  /** This window's validated settings, read at the moment they are needed. */
  getConfig(): Config;
  /** Human names of the remote windows that are open (this one included). */
  getRemoteWindows(): string[];
  /** A dashboard is visible in this or any connected window. */
  hasViewers(): boolean;
  /** This process still holds the leadership endpoint. */
  stillLeader(): boolean;
  /** Stand-in for the user's home folder. Tests only; never set in production. */
  homeDir?: string;
  log(message: string): void;
}

function leaderInfoOf(self: WindowHello): LeaderInfo {
  return { windowId: self.windowId, label: self.label, app: self.app, ext: self.ext, pid: self.pid, realm: self.realm };
}

/**
 * The activity log's answer to "why is this PC still on": every unmet check in the words the
 * dashboard uses. `confirmed` is left out - it is the re-check counter, not a reason.
 */
function describeBlockers(verdict: Verdict, scan: ScanResult | null, controller: Controller, osName: string): string {
  const context = { contract: controller.getState().contract, osName, sessions: scan?.sessions ?? [] };
  return verdict.checks
    .filter((check) => check.id !== 'confirmed' && check.state !== 'pass')
    .map((check) => {
      const text = describeCheck(check, context);
      return `${text.label}: ${text.detail}`;
    })
    .join(' | ');
}

function release(platform: Platform, log: (message: string) => void): Promise<void> {
  return platform.dispose().catch((error: unknown) => {
    log(`The platform helper could not be stopped cleanly: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Builds the machinery and starts the controller. Throws only after releasing what it had built. */
export function createLeaderRuntime(environment: LeaderEnvironment, start: LeaderStart): LeaderRuntime {
  const platform = createPlatform({
    extensionPath: environment.extensionPath,
    log: (message) => environment.log(`platform: ${message}`),
  });
  try {
    const scanner = new Scanner({ platform, homeDir: environment.homeDir });
    const controller: Controller = new Controller({
      platform,
      scanner,
      evaluate,
      stateDir: environment.stateDir,
      clock: systemClock,
      getConfig: environment.getConfig,
      leader: leaderInfoOf(environment.self),
      hostname: environment.hostname,
      getRemoteWindows: environment.getRemoteWindows,
      hasViewers: environment.hasViewers,
      stillLeader: environment.stillLeader,
      describeBlockers: (verdict, scan) => describeBlockers(verdict, scan, controller, platform.osName),
      alertText: countdownAlertText,
    });
    const subscription = controller.onState(start.onState);
    controller.start({
      handover: start.handover,
      previousLeaderWasWatching: start.previousLeaderWasWatching,
      freshStart: start.freshStart,
    });
    return {
      getState: () => controller.getState(),
      handleCommand: (command, from) => controller.handleCommand(command, from),
      beginHandover: () => controller.beginHandover(),
      configChanged: () => controller.configChanged(),
      peersChanged: () => controller.peersChanged(),
      dispose: async (options) => {
        subscription.dispose();
        try {
          // Runs before the first await, so the "watching stopped" record is on disk by the time
          // dispose() returns its promise - a closing window may not get to finish the rest.
          controller.dispose(options);
        } finally {
          await release(platform, environment.log);
        }
      },
    };
  } catch (error) {
    void release(platform, environment.log);
    throw error;
  }
}
