// Picks the backend for this OS. The rest of the extension imports only this and ./types.
//   win32  -> createWindowsPlatform   (./windows.ts)
//   linux  -> createLinuxPlatform     (./linux.ts)
//   darwin -> createMacPlatform       (./macos.ts)
//   other  -> createUnsupportedPlatform (./unsupported.ts)

import { createLinuxPlatform } from './linux';
import { createMacPlatform } from './macos';
import type { Platform } from './types';
import { createUnsupportedPlatform } from './unsupported';
import { createWindowsPlatform } from './windows';

export interface PlatformOptions {
  /** Absolute path of the installed extension (helper scripts live in <extensionPath>/resources). */
  extensionPath: string;
  log(message: string): void;
}

/** The backend for `osPlatform` (a process.platform value). */
export function createPlatformFor(osPlatform: string, options: PlatformOptions): Platform {
  switch (osPlatform) {
    case 'win32':
      return createWindowsPlatform(options);
    case 'linux':
      return createLinuxPlatform(options);
    case 'darwin':
      return createMacPlatform(options);
    default:
      return createUnsupportedPlatform(osPlatform);
  }
}

export function createPlatform(options: PlatformOptions): Platform {
  return createPlatformFor(process.platform, options);
}

export type { Platform } from './types';
