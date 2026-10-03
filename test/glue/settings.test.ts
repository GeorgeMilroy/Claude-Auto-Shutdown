import { describe, expect, it } from 'vitest';

import { CONFIG_KEYS, DEFAULT_CONFIG, contractDigest, toArmContract } from '../../src/shared/config';
import { SettingsBridge, readUserValues } from '../../src/ui/settings';
import type { SettingsReader } from '../../src/ui/settings';

interface Inspection {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** A stand-in for vscode.WorkspaceConfiguration: one inspection per key, changeable between reloads. */
function fakeSettings(initial: Record<string, Inspection> = {}) {
  const values: Record<string, Inspection> = { ...initial };
  const warnings: string[] = [];
  const reader: SettingsReader = { inspect: (key) => values[key] };
  const bridge = new SettingsBridge(
    () => reader,
    (warning) => warnings.push(warning),
  );
  return { bridge, values, warnings };
}

describe('readUserValues', () => {
  it('takes only the user value of each key', () => {
    const inspections: Record<string, Inspection> = {
      testMode: { defaultValue: true, workspaceValue: false },
      action: { defaultValue: 'shutdown', globalValue: 'sleep', workspaceValue: 'shutdown' },
      quietSeconds: { defaultValue: 30, workspaceFolderValue: 30 },
    };
    expect(readUserValues({ inspect: (key) => inspections[key] })).toEqual({ action: 'sleep' });
  });

  it('asks for the keys of the settings model and no others', () => {
    const asked: string[] = [];
    readUserValues({
      inspect: (key) => {
        asked.push(key);
        return undefined;
      },
    });
    expect(asked).toEqual([...CONFIG_KEYS]);
  });
});

describe('SettingsBridge', () => {
  it('starts from the defaults - a test run - when the user has set nothing', () => {
    const { bridge, warnings } = fakeSettings();
    expect(bridge.current).toEqual({ ...DEFAULT_CONFIG });
    expect(bridge.current.testMode).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('cannot be switched to a real run by a workspace', () => {
    const { bridge } = fakeSettings({
      testMode: { workspaceValue: false, workspaceFolderValue: false },
      quietSeconds: { workspaceValue: 30 },
      requireUserIdle: { workspaceValue: false },
      watchOnStartup: { workspaceValue: true },
    });
    expect(bridge.current).toEqual({ ...DEFAULT_CONFIG });
  });

  it("ignores a default another extension contributed for one of our keys", () => {
    const { bridge } = fakeSettings({ action: { defaultValue: 'hibernate' }, testMode: { defaultValue: false } });
    expect(bridge.current.action).toBe('shutdown');
    expect(bridge.current.testMode).toBe(true);
  });

  it('turns a broken value into the safe default and says so once', () => {
    const { bridge, values, warnings } = fakeSettings({
      action: { globalValue: 'poweroff' },
      quietSeconds: { globalValue: 'soon' },
      testMode: { globalValue: 'nope' },
    });
    expect(bridge.current.action).toBe('notify');
    expect(bridge.current.quietSeconds).toBe(DEFAULT_CONFIG.quietSeconds);
    expect(bridge.current.testMode).toBe(true);
    expect(warnings).toHaveLength(3);

    // An unrelated change: the same three problems are not reported again.
    values.showStatusBar = { globalValue: false };
    expect(bridge.reload()).toEqual({ changed: true, contractChanged: false });
    expect(warnings).toHaveLength(3);

    // One of them fixed: what is left is reported as the new situation.
    values.testMode = { globalValue: false };
    bridge.reload();
    expect(warnings).toHaveLength(5);
  });

  it('reports no change when the validated settings are the same', () => {
    const { bridge, values } = fakeSettings({ quietSeconds: { globalValue: 120 } });
    expect(bridge.reload()).toEqual({ changed: false, contractChanged: false });
    // Written differently, validated to the same value.
    values.quietSeconds = { globalValue: '120' };
    expect(bridge.reload()).toEqual({ changed: false, contractChanged: false });
    // Set explicitly to what the default already was.
    values.pollSeconds = { globalValue: DEFAULT_CONFIG.pollSeconds };
    expect(bridge.reload()).toEqual({ changed: false, contractChanged: false });
  });

  it('tells a change of the agreed rules from a change that is only about this window', () => {
    const { bridge, values } = fakeSettings();
    const before = bridge.digest;

    values.countdownSound = { globalValue: false };
    expect(bridge.reload()).toEqual({ changed: true, contractChanged: false });
    expect(bridge.digest).toBe(before);

    values.quietSeconds = { globalValue: 60 };
    expect(bridge.reload()).toEqual({ changed: true, contractChanged: true });
    expect(bridge.digest).not.toBe(before);
    expect(bridge.plan.quietSeconds).toBe(60);
  });

  it('keeps plan and digest in step with the settings', () => {
    const { bridge, values } = fakeSettings({ action: { globalValue: 'lock' } });
    values.guardProcesses = { globalValue: ['ffmpeg', ' render* '] };
    bridge.reload();
    expect(bridge.plan).toEqual(toArmContract(bridge.current));
    expect(bridge.digest).toBe(contractDigest(bridge.plan));
    expect(bridge.plan.guardProcesses).toEqual(['ffmpeg', 'render*']);
  });

  it('falls back to the defaults when the settings cannot be read at all', () => {
    const warnings: string[] = [];
    const bridge = new SettingsBridge(
      () => {
        throw new Error('configuration service is gone');
      },
      (warning) => warnings.push(warning),
    );
    expect(bridge.current).toEqual({ ...DEFAULT_CONFIG });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('configuration service is gone');
  });

  it('reads the settings again on every reload', () => {
    let opened = 0;
    const bridge = new SettingsBridge(
      () => {
        opened += 1;
        return { inspect: () => undefined };
      },
      () => undefined,
    );
    bridge.reload();
    bridge.reload();
    expect(opened).toBe(3);
  });
});
