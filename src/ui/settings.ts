// Settings bridge: the editor's configuration -> one validated Config.
//
// Only the USER value of each key is read (inspect().globalValue). A workspace must never be able
// to change what happens to this PC: a repository that ships `.vscode/settings.json` with
// `"testMode": false` would otherwise turn a test run into the real thing. Defaults contributed
// by other extensions are ignored for the same reason. Whatever is found goes through
// validateConfig(), so a broken value becomes the safe default and never "shut down".

import { CONFIG_KEYS, contractDigest, toArmContract, validateConfig } from '../shared/config';
import type { ArmContract, Config } from '../shared/config';

/** The slice of vscode.WorkspaceConfiguration that is used. */
export interface SettingsReader {
  inspect(key: string): { globalValue?: unknown } | undefined;
}

export interface SettingsChange {
  /** The validated settings differ from the previous ones. */
  changed: boolean;
  /** The part a user agrees to when they start watching differs (see ArmContract). */
  contractChanged: boolean;
}

/** The user's own values for our keys; a key the user has not set is absent. */
export function readUserValues(reader: SettingsReader): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = reader.inspect(key)?.globalValue;
    if (value !== undefined) values[key] = value;
  }
  return values;
}

function fingerprint(config: Config): string {
  return JSON.stringify(CONFIG_KEYS.map((key) => config[key]));
}

export class SettingsBridge {
  private readonly open: () => SettingsReader;
  private readonly warn: (message: string) => void;
  private config: Config;
  private contract: ArmContract;
  private contractDigest: string;
  private reportedWarnings = '';

  /** `open` returns the current configuration section; `warn` receives each problem once per change. */
  constructor(open: () => SettingsReader, warn: (message: string) => void) {
    this.open = open;
    this.warn = warn;
    this.config = this.load();
    this.contract = toArmContract(this.config);
    this.contractDigest = contractDigest(this.contract);
  }

  /** This window's validated settings. Treat as read-only. */
  get current(): Config {
    return this.config;
  }

  /** This window's settings as the contract "start" would send. */
  get plan(): ArmContract {
    return this.contract;
  }

  get digest(): string {
    return this.contractDigest;
  }

  /** Reads the settings again. Call when the editor says our section changed. */
  reload(): SettingsChange {
    const next = this.load();
    if (fingerprint(next) === fingerprint(this.config)) return { changed: false, contractChanged: false };
    const contract = toArmContract(next);
    const digest = contractDigest(contract);
    const contractChanged = digest !== this.contractDigest;
    this.config = next;
    this.contract = contract;
    this.contractDigest = digest;
    return { changed: true, contractChanged };
  }

  private load(): Config {
    const problems: string[] = [];
    let values: Record<string, unknown> = {};
    try {
      values = readUserValues(this.open());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`The settings couldn't be read (${reason}); using the defaults, which are a test run.`);
    }
    const { config, warnings } = validateConfig(values);
    this.report([...problems, ...warnings]);
    return config;
  }

  /** The same broken value is reported once, not on every unrelated settings change. */
  private report(warnings: string[]): void {
    const key = warnings.join('\n');
    if (key === this.reportedWarnings) return;
    this.reportedWarnings = key;
    for (const warning of warnings) this.warn(warning);
  }
}
