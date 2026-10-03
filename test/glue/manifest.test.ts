// package.json is the extension's other half: the editor reads commands, settings, menus and key
// bindings from it, the code reads them from src/. These tests keep the two in step.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONFIG_KEYS, DEFAULT_CONFIG, INT_BOUNDS, POWER_ACTIONS } from '../../src/shared/config';
import type { Config } from '../../src/shared/config';
import {
  COMMAND_IDS,
  CONTEXT_KEYS,
  DASHBOARD_VIEW_ID,
  DISPLAY_NAME,
  INTERNAL_COMMAND_IDS,
  SETTINGS_SECTION,
  WALKTHROUGH_ID,
} from '../../src/ui/ids';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface SettingSchema {
  scope?: string;
  ignoreSync?: boolean;
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumDescriptions?: string[];
  enumItemLabels?: string[];
  items?: { type?: string };
  markdownDescription?: string;
  order?: number;
}

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}

interface Manifest {
  icon?: string;
  contributes: {
    commands: { command: string; title: string; category?: string; icon?: string }[];
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    views: Record<string, { type?: string; id: string; name: string; icon?: string }[]>;
    menus: Record<string, MenuEntry[]>;
    keybindings: { command: string; key: string; when?: string }[];
    configurationDefaults?: Record<string, unknown>;
    configuration: { title: string; properties: Record<string, SettingSchema> };
    walkthroughs: {
      id: string;
      title: string;
      steps: { id: string; title: string; description: string; media: { markdown: string }; completionEvents: string[] }[];
    }[];
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const extensionSource = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const { contributes } = manifest;
const contributedCommands = contributes.commands.map((command) => command.command);
const settings = contributes.configuration.properties;

function setting(key: keyof Config): SettingSchema {
  const schema = settings[`${SETTINGS_SECTION}.${key}`];
  if (schema === undefined) throw new Error(`setting ${key} is not contributed`);
  return schema;
}

function expectedType(key: keyof Config): string {
  const value = DEFAULT_CONFIG[key];
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'integer';
  return Array.isArray(value) ? 'array' : 'string';
}

/** Identifiers that look like one of our context keys inside a when-clause. */
function contextKeysIn(when: string): string[] {
  return when.match(/claudeAutoShutdown\.[A-Za-z]+/g) ?? [];
}

describe('settings', () => {
  it('contributes every key of the settings model, and nothing else', () => {
    const contributed = Object.keys(settings).sort();
    const expected = CONFIG_KEYS.map((key) => `${SETTINGS_SECTION}.${key}`).sort();
    expect(contributed).toEqual(expected);
  });

  it.each(CONFIG_KEYS)('%s has the default of the settings model', (key) => {
    expect(setting(key).default).toEqual(DEFAULT_CONFIG[key]);
  });

  it.each(CONFIG_KEYS)('%s has the type of the settings model', (key) => {
    expect(setting(key).type).toBe(expectedType(key));
    if (expectedType(key) === 'array') expect(setting(key).items?.type).toBe('string');
  });

  // application: only user settings, read locally even in WSL / SSH windows, so a workspace or a
  // remote can never change the rules. ignoreSync: another machine's settings never arrive here.
  it.each(CONFIG_KEYS)('%s is application-scoped and never synced', (key) => {
    expect(setting(key).scope).toBe('application');
    expect(setting(key).ignoreSync).toBe(true);
  });

  it.each(CONFIG_KEYS)('%s is described', (key) => {
    expect((setting(key).markdownDescription ?? '').length).toBeGreaterThan(15);
  });

  it.each(Object.keys(INT_BOUNDS) as (keyof typeof INT_BOUNDS)[])('%s has the bounds of the settings model', (key) => {
    const [minimum, maximum] = INT_BOUNDS[key];
    expect(setting(key).minimum).toBe(minimum);
    expect(setting(key).maximum).toBe(maximum);
  });

  it('gives bounds to no setting the model does not bound', () => {
    const bounded = CONFIG_KEYS.filter((key) => setting(key).minimum !== undefined || setting(key).maximum !== undefined);
    expect([...bounded].sort()).toEqual(Object.keys(INT_BOUNDS).sort());
  });

  it('offers exactly the actions of the settings model, each with a label and a description', () => {
    const action = setting('action');
    expect(action.enum).toEqual([...POWER_ACTIONS]);
    expect(action.enumDescriptions).toHaveLength(POWER_ACTIONS.length);
    expect(action.enumItemLabels).toHaveLength(POWER_ACTIONS.length);
  });

  it('lists the settings in the order of the settings model', () => {
    expect(CONFIG_KEYS.map((key) => setting(key).order)).toEqual(CONFIG_KEYS.map((_key, index) => index));
  });

  it('starts out as a test run', () => {
    expect(setting('testMode').default).toBe(true);
    expect(setting('watchOnStartup').default).toBe(false);
  });
});

describe('commands', () => {
  it('contributes exactly the commands the code knows', () => {
    expect([...contributedCommands].sort()).toEqual([...COMMAND_IDS].sort());
  });

  it.each(contributedCommands)('%s is registered in src/extension.ts', (id) => {
    expect(extensionSource).toContain(`'${id}'`);
  });

  it.each([...INTERNAL_COMMAND_IDS])('%s (not in the palette) is registered in src/extension.ts', (id) => {
    expect(extensionSource).toContain(`'${id}'`);
    expect(contributedCommands).not.toContain(id);
  });

  it('puts every command in the same category and gives it a title', () => {
    for (const command of contributes.commands) {
      expect(command.category).toBe(DISPLAY_NAME);
      expect(command.title.trim()).not.toBe('');
    }
  });

  it('has no command that skips or shortens a countdown', () => {
    const ids = [...contributedCommands, ...INTERNAL_COMMAND_IDS].join(' ').toLowerCase();
    expect(ids).not.toMatch(/skip|executenow|accelerate/);
  });

  it('registers commands that take no arguments', () => {
    // The one registration wrapper drops whatever a caller passes.
    expect(extensionSource).toMatch(/registerCommand\(id, async \(\) =>/);
    expect(extensionSource.match(/registerCommand\(/g)).toHaveLength(1);
  });
});

describe('menus and keys', () => {
  const menuEntries = Object.values(contributes.menus).flat();

  it('only refers to commands that exist', () => {
    const known = new Set<string>([...COMMAND_IDS, ...INTERNAL_COMMAND_IDS]);
    const referenced = [...menuEntries.map((entry) => entry.command), ...contributes.keybindings.map((binding) => binding.command)];
    for (const id of referenced) expect(known.has(id), id).toBe(true);
  });

  it('only uses context keys the code sets', () => {
    const known = new Set<string>(Object.values(CONTEXT_KEYS));
    const conditions = [...menuEntries.map((entry) => entry.when ?? ''), ...contributes.keybindings.map((binding) => binding.when ?? '')];
    for (const key of conditions.flatMap(contextKeysIn)) {
      if (key === DASHBOARD_VIEW_ID) continue;
      expect(known.has(key), key).toBe(true);
    }
  });

  it('binds Escape to cancel, and only while a countdown is running', () => {
    expect(contributes.keybindings).toEqual([
      { command: 'claudeAutoShutdown.cancelCountdownWithEscape', key: 'escape', when: CONTEXT_KEYS.countdownActive },
    ]);
  });

  // The integrated terminal hands a key to the editor only when the command it resolves to is in
  // terminal.integrated.commandsToSkipShell; otherwise Esc goes to the shell (often Claude Code
  // itself) and the countdown runs on. The when-clause keeps Esc in the shell outside a countdown.
  it('lets Escape reach the cancel while the terminal has the focus, and changes no other default', () => {
    expect(contributes.configurationDefaults).toEqual({
      'terminal.integrated.commandsToSkipShell': ['claudeAutoShutdown.cancelCountdownWithEscape'],
    });
    const [binding] = contributes.keybindings;
    expect(contributes.configurationDefaults?.['terminal.integrated.commandsToSkipShell']).toEqual([binding?.command]);
  });

  it('says in the README how to keep Escape working with a commandsToSkipShell of your own', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('terminal.integrated.commandsToSkipShell');
    expect(readme).toContain('claudeAutoShutdown.cancelCountdownWithEscape');
  });

  it('offers Start only while not watching, Stop only while watching, Cancel only during a countdown', () => {
    const palette = new Map(contributes.menus.commandPalette?.map((entry) => [entry.command, entry.when]));
    expect(palette.get('claudeAutoShutdown.start')).toBe(`!${CONTEXT_KEYS.watching}`);
    expect(palette.get('claudeAutoShutdown.preview')).toBe(`!${CONTEXT_KEYS.watching}`);
    expect(palette.get('claudeAutoShutdown.stop')).toBe(CONTEXT_KEYS.watching);
    expect(palette.get('claudeAutoShutdown.cancelCountdown')).toBe(CONTEXT_KEYS.countdownActive);
  });

  it('puts refresh, open-in-editor and settings in the view title, the rest in its overflow', () => {
    const title = contributes.menus['view/title'] ?? [];
    for (const entry of title) expect(entry.when).toContain(`view == ${DASHBOARD_VIEW_ID}`);
    const inline = title.filter((entry) => entry.group?.startsWith('navigation')).map((entry) => entry.command);
    const overflow = title.filter((entry) => !entry.group?.startsWith('navigation')).map((entry) => entry.command);
    expect(inline).toEqual(['claudeAutoShutdown.refresh', 'claudeAutoShutdown.openInEditor', 'claudeAutoShutdown.openSettings']);
    expect(overflow).toEqual(['claudeAutoShutdown.showLog', 'claudeAutoShutdown.lastRun', 'claudeAutoShutdown.preview']);
    for (const id of inline) expect(contributes.commands.find((command) => command.command === id)?.icon).toMatch(/^\$\(.+\)$/);
  });
});

describe('view and walkthrough', () => {
  it('contributes the dashboard as a webview view in its own activity bar container', () => {
    const [container] = contributes.viewsContainers.activitybar;
    expect(container).toBeDefined();
    const views = contributes.views[container?.id ?? ''] ?? [];
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ type: 'webview', id: DASHBOARD_VIEW_ID });
  });

  it('uses a monochrome SVG as the activity bar icon', () => {
    const [container] = contributes.viewsContainers.activitybar;
    const file = path.join(root, container?.icon ?? 'missing');
    expect(path.extname(file)).toBe('.svg');
    const svg = fs.readFileSync(file, 'utf8');
    const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1]);
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(['none', 'currentColor']).toContain(colour);
    expect(svg).not.toMatch(/<image|<style|url\(/);
  });

  it('has one walkthrough whose steps have a Markdown file and a completion event', () => {
    expect(contributes.walkthroughs.map((walkthrough) => walkthrough.id)).toEqual([WALKTHROUGH_ID]);
    const steps = contributes.walkthroughs[0]?.steps ?? [];
    expect(steps.length).toBe(4);
    for (const step of steps) {
      expect(fs.existsSync(path.join(root, step.media.markdown)), step.media.markdown).toBe(true);
      expect(step.completionEvents.length).toBeGreaterThan(0);
    }
  });

  it('only links walkthrough steps to contributed commands and to context keys the code sets', () => {
    const steps = contributes.walkthroughs[0]?.steps ?? [];
    const linked = steps.flatMap((step) => [...step.description.matchAll(/\(command:([^)]+)\)/g)].map((match) => match[1]));
    expect(linked.length).toBe(steps.length);
    for (const id of linked) expect(contributedCommands).toContain(id);

    const contextKeys = new Set<string>(Object.values(CONTEXT_KEYS));
    for (const event of steps.flatMap((step) => step.completionEvents)) {
      const [kind, target] = event.split(':');
      if (kind === 'onContext') expect(contextKeys.has(target ?? ''), event).toBe(true);
      if (kind === 'onCommand') expect(contributedCommands).toContain(target);
      if (kind === 'onView') expect(target).toBe(DASHBOARD_VIEW_ID);
    }
  });

  it('never opens the walkthrough by itself', () => {
    // The entry point reaches it in one place only: the handler of the "Get Started" command.
    expect(extensionSource.match(/openWalkthrough/g)).toHaveLength(1);
    expect(extensionSource).toContain("'claudeAutoShutdown.help': () => actions.openWalkthrough()");
  });
});

describe('extension icon', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('is a square PNG of at least 128 px (the Marketplace refuses SVG icons)', () => {
    expect(manifest.icon).toBe('resources/icon.png');
    const bytes = fs.readFileSync(path.join(root, manifest.icon ?? ''));
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // The IHDR chunk always comes first: width and height are big-endian at bytes 16 and 20.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(128);
  });
});
