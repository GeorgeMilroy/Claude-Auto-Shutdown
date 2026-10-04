// Settings model + validation. Pure (no vscode import) so the engine, the webview and the tests share it.
//
// VS Code hands extensions whatever settings.json contains regardless of the declared type, and
// JavaScript coerces silently ("false" is truthy, NaN < 300 is false). Every value therefore goes
// through validateConfig(); a broken value can only ever become the SAFE default, never "shut down".

export const POWER_ACTIONS = ['shutdown', 'hibernate', 'sleep', 'lock', 'notify'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

export interface Config {
  /** What happens to this PC once every Claude Code session has finished. */
  action: PowerAction;
  /** Test run: everything runs as normal, but instead of the action you get a message. */
  testMode: boolean;
  /** How long every session must have written nothing before it counts as finished. */
  quietSeconds: number;
  /** Seconds between checks. */
  pollSeconds: number;
  /** Checks in a row that must all agree. */
  requiredPolls: number;
  /** Length of the warning before the action. */
  countdownSeconds: number;
  /** Only act when the user hasn't touched mouse or keyboard. Unknown idle time = stays on. */
  requireUserIdle: boolean;
  userIdleSeconds: number;
  /** Allow the action when no Claude session was ever seen. */
  allowWhenNoSessions: boolean;
  /** Shut down only: close other apps without asking. */
  forceCloseApps: boolean;
  /** Keep-on list: process names / globs / regexes that keep this PC on while running. */
  guardProcesses: string[];
  /** Start watching when the editor starts, using the mode above. */
  watchOnStartup: boolean;
  /** Sound when the countdown starts and in its last 5 s. */
  countdownSound: boolean;
  /** Show an always-on-top OS warning during the countdown. */
  countdownAlert: boolean;
  /** While watching, stop the OS from going to sleep by itself before Claude finishes. */
  keepAwake: boolean;
  /** Stay on while a command started by a session is still doing work (CPU or I/O). */
  waitForChildProcesses: boolean;
  /** Stay on while Claude Code says a session waits for the user's answer (a permission prompt, a question). */
  waitForAnswers: boolean;
  /** Extra Claude config directories to watch besides ~/.claude and $CLAUDE_CONFIG_DIR. */
  extraClaudeDirs: string[];
  /** Windows: also look for Claude sessions inside running WSL distros. */
  scanWsl: boolean;
  showStatusBar: boolean;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  action: 'shutdown',
  testMode: true,
  quietSeconds: 300,
  pollSeconds: 10,
  requiredPolls: 3,
  countdownSeconds: 90,
  requireUserIdle: true,
  userIdleSeconds: 600,
  allowWhenNoSessions: false,
  forceCloseApps: true,
  guardProcesses: [],
  watchOnStartup: false,
  countdownSound: true,
  countdownAlert: true,
  keepAwake: true,
  waitForChildProcesses: true,
  waitForAnswers: true,
  extraClaudeDirs: [],
  scanWsl: true,
  showStatusBar: true,
});

/** [min, max]. The lower bounds are safety floors, not cosmetics. */
export const INT_BOUNDS = {
  quietSeconds: [30, 3600],
  pollSeconds: [5, 60],
  requiredPolls: [2, 10],
  countdownSeconds: [15, 600],
  userIdleSeconds: [30, 7200],
} as const satisfies Partial<Record<keyof Config, readonly [number, number]>>;

type IntKey = keyof typeof INT_BOUNDS;
type BoolKey = {
  [K in keyof Config]: Config[K] extends boolean ? K : never;
}[keyof Config];
type ListKey = 'guardProcesses' | 'extraClaudeDirs';

const INT_KEYS = Object.keys(INT_BOUNDS) as IntKey[];
const BOOL_KEYS: BoolKey[] = [
  'testMode',
  'requireUserIdle',
  'allowWhenNoSessions',
  'forceCloseApps',
  'watchOnStartup',
  'countdownSound',
  'countdownAlert',
  'keepAwake',
  'waitForChildProcesses',
  'waitForAnswers',
  'scanWsl',
  'showStatusBar',
];
const LIST_KEYS: ListKey[] = ['guardProcesses', 'extraClaudeDirs'];

/** Every setting id, in the order they appear in the Settings UI. */
export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0', '']);

function coerceBool(key: BoolKey, value: unknown, warnings: string[]): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  warnings.push(`${key}: can't understand ${JSON.stringify(value)}, using the default (${DEFAULT_CONFIG[key]})`);
  return DEFAULT_CONFIG[key];
}

function coerceInt(key: IntKey, value: unknown, warnings: string[]): number {
  const [lo, hi] = INT_BOUNDS[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    warnings.push(`${key}: ${JSON.stringify(value)} is not a number, using the default (${DEFAULT_CONFIG[key]})`);
    return DEFAULT_CONFIG[key];
  }
  const whole = Math.trunc(number);
  if (whole < lo || whole > hi) {
    warnings.push(`${key}: ${whole} is outside ${lo}-${hi}, clamped`);
  }
  return Math.max(lo, Math.min(whole, hi));
}

function coerceList(key: ListKey, value: unknown, warnings: string[]): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean);
  }
  warnings.push(`${key}: expected a list, ignoring ${JSON.stringify(value)}`);
  return [];
}

/**
 * Turns anything into a safe Config. Never throws.
 * Keys that are absent (or undefined) take the default without a warning.
 * An unknown action becomes 'notify' - it must never silently turn into "shut down".
 */
export function validateConfig(raw: unknown): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && source !== raw) {
    warnings.push('settings are not an object, using the defaults');
  }
  const config: Config = { ...DEFAULT_CONFIG, guardProcesses: [], extraClaudeDirs: [] };

  for (const key of BOOL_KEYS) {
    if (source[key] !== undefined) config[key] = coerceBool(key, source[key], warnings);
  }
  for (const key of INT_KEYS) {
    if (source[key] !== undefined) config[key] = coerceInt(key, source[key], warnings);
  }
  for (const key of LIST_KEYS) {
    if (source[key] !== undefined) config[key] = coerceList(key, source[key], warnings);
  }
  if (source.action !== undefined) {
    if (typeof source.action === 'string' && (POWER_ACTIONS as readonly string[]).includes(source.action)) {
      config.action = source.action as PowerAction;
    } else {
      warnings.push(`action: unknown value ${JSON.stringify(source.action)}, switching to 'notify'`);
      config.action = 'notify';
    }
  }
  return { config, warnings };
}

/**
 * The part of the settings a user agrees to when they start watching. It is frozen at that moment
 * (the "arm contract") and is the only config the leader uses until watching stops.
 */
export type ArmContract = Readonly<
  Pick<
    Config,
    | 'action'
    | 'testMode'
    | 'quietSeconds'
    | 'pollSeconds'
    | 'requiredPolls'
    | 'countdownSeconds'
    | 'requireUserIdle'
    | 'userIdleSeconds'
    | 'allowWhenNoSessions'
    | 'forceCloseApps'
    | 'guardProcesses'
    | 'waitForChildProcesses'
    | 'waitForAnswers'
    | 'extraClaudeDirs'
    | 'scanWsl'
  >
>;

const CONTRACT_KEYS = [
  'action',
  'testMode',
  'quietSeconds',
  'pollSeconds',
  'requiredPolls',
  'countdownSeconds',
  'requireUserIdle',
  'userIdleSeconds',
  'allowWhenNoSessions',
  'forceCloseApps',
  'guardProcesses',
  'waitForChildProcesses',
  'waitForAnswers',
  'extraClaudeDirs',
  'scanWsl',
] as const satisfies readonly (keyof ArmContract)[];

export function toArmContract(config: Config): ArmContract {
  const out: Record<string, unknown> = {};
  for (const key of CONTRACT_KEYS) {
    const value = config[key];
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return Object.freeze(out) as unknown as ArmContract;
}

/**
 * Stable fingerprint of a contract. Two windows compare digests to make sure the settings a user
 * confirmed are exactly the settings the leader will run with. Not cryptographic.
 */
export function contractDigest(contract: ArmContract): string {
  const text = CONTRACT_KEYS.map((key) => `${key}=${JSON.stringify(contract[key])}`).join(';');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** A contract received from another window is untrusted input: re-validate it field by field. */
export function parseArmContract(raw: unknown): ArmContract | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  for (const key of CONTRACT_KEYS) {
    if (source[key] === undefined) return null;
  }
  const { config, warnings } = validateConfig(source);
  // Any coercion or clamp means the sender and this window disagree about the rules: refuse.
  if (warnings.length > 0) return null;
  return toArmContract(config);
}
