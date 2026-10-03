import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPosixSystem, findTool, sanitiseToolEnv } from '../../src/platform/posixSystem';

describe('findTool', () => {
  const installed = (...files: string[]) => ({ exists: (file: string) => files.includes(file) });

  it('returns the absolute path from the first system directory that has the tool', () => {
    expect(findTool(installed('/usr/bin/systemctl', '/bin/systemctl'), 'systemctl')).toBe('/usr/bin/systemctl');
    expect(findTool(installed('/bin/systemctl'), 'systemctl')).toBe('/bin/systemctl');
    expect(findTool(installed('/usr/sbin/ioreg'), 'ioreg')).toBe('/usr/sbin/ioreg');
    expect(findTool(installed('/run/current-system/sw/bin/busctl'), 'busctl')).toBe('/run/current-system/sw/bin/busctl');
  });

  it('is null when the tool is not installed', () => {
    expect(findTool(installed(), 'xprintidle')).toBeNull();
  });

  it('never looks outside the fixed directories', () => {
    const asked: string[] = [];
    findTool({ exists: (file) => (asked.push(file), false) }, 'systemctl');
    expect(asked).toEqual([
      '/usr/bin/systemctl',
      '/bin/systemctl',
      '/usr/sbin/systemctl',
      '/sbin/systemctl',
      '/usr/local/bin/systemctl',
      '/run/current-system/sw/bin/systemctl',
    ]);
    expect(findTool(installed('/home/u/project/systemctl', './systemctl', 'systemctl'), 'systemctl')).toBeNull();
  });
});

describe('sanitiseToolEnv', () => {
  it('drops what a packaged editor leaks into its children', () => {
    const clean = sanitiseToolEnv({
      HOME: '/home/u',
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/snap/code/174/usr/lib',
      GIO_MODULE_DIR: '/snap/code/174/gio/modules',
      GTK_PATH: '/snap/code/174/usr/lib/gtk-3.0',
      GTK_EXE_PREFIX: '/snap/code/174/usr',
      GTK_IM_MODULE_FILE: '/home/u/snap/code/common/.cache/immodules/immodules.cache',
    });
    expect(clean).toEqual({ HOME: '/home/u', PATH: '/usr/bin' });
  });

  it('restores the values the snap wrapper saved, and removes the ones that were not set before', () => {
    const clean = sanitiseToolEnv({
      XDG_DATA_DIRS: '/snap/code/174/usr/share:/usr/share',
      XDG_DATA_DIRS_VSCODE_SNAP_ORIG: '/usr/local/share:/usr/share',
      GSETTINGS_SCHEMA_DIR: '/snap/code/174/usr/share/glib-2.0/schemas',
      GSETTINGS_SCHEMA_DIR_VSCODE_SNAP_ORIG: '',
      GTK_PATH: '/snap/code/174/usr/lib/gtk-3.0',
      GTK_PATH_VSCODE_SNAP_ORIG: '/usr/lib/gtk-3.0',
      GIO_MODULE_DIR: '/snap/code/174/gio/modules',
      GIO_MODULE_DIR_VSCODE_SNAP_ORIG: '',
      LOCPATH_VSCODE_SNAP_ORIG: '',
    });
    expect(clean).toEqual({ XDG_DATA_DIRS: '/usr/local/share:/usr/share', GTK_PATH: '/usr/lib/gtk-3.0' });
  });

  it('leaves an ordinary environment alone and skips undefined entries', () => {
    const env = { HOME: '/home/u', DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', GONE: undefined };
    expect(sanitiseToolEnv(env)).toEqual({ HOME: '/home/u', DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
  });

  it('does not modify its input', () => {
    const env = { LD_LIBRARY_PATH: '/x', A_VSCODE_SNAP_ORIG: 'b' };
    sanitiseToolEnv(env);
    expect(env).toEqual({ LD_LIBRARY_PATH: '/x', A_VSCODE_SNAP_ORIG: 'b' });
  });
});

describe('createPosixSystem (the real one)', () => {
  const system = createPosixSystem();
  let dir = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
    fs.writeFileSync(path.join(dir, 'stat'), '1 (x) S 0\n');
    fs.mkdirSync(path.join(dir, 'sub'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the live process environment, so the power guard sees what the test runner set', () => {
    expect(system.env).toBe(process.env);
    expect(system.env.CLAUDE_AUTOSHUTDOWN_NO_POWER).toBe('1');
    expect(system.pid).toBe(process.pid);
  });

  it('reads files and directories', async () => {
    expect(await system.readFile(path.join(dir, 'stat'))).toBe('1 (x) S 0\n');
    expect((await system.readdir(dir)).sort()).toEqual(['stat', 'sub']);
    expect(system.exists(path.join(dir, 'stat'))).toBe(true);
    expect(system.exists(path.join(dir, 'missing'))).toBe(false);
  });

  it('rejects with the errno code the backends decide on', async () => {
    await expect(system.readFile(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(system.readdir(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(system.readlink(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds a child until stop(): closing its stdin ends it', async () => {
    const script = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';
    const held = system.hold(process.execPath, ['-e', script], process.env);
    const early = await Promise.race([held.exited, system.delay(300).then(() => 'still running' as const)]);
    expect(early).toBe('still running');
    held.stop();
    held.stop();
    const exit = await held.exited;
    expect(exit.stderr).toBe('');
  });

  it('reports the exit code and stderr of a held child that ends by itself', async () => {
    const held = system.hold(process.execPath, ['-e', 'process.stderr.write("refused\\n"); process.exitCode = 3;'], process.env);
    expect(await held.exited).toEqual({ code: 3, stderr: 'refused\n' });
  });

  it('never rejects for a tool that cannot be started', async () => {
    const missing = system.hold(path.join(dir, 'no-such-tool'), [], process.env);
    const exit = await missing.exited;
    expect(exit.code).toBeNull();
    expect(exit.stderr).not.toBe('');
    expect(() => missing.stop()).not.toThrow();
  });

  it('refuses to hold a tool given by a relative path', async () => {
    const held = system.hold('node', ['-e', '0'], process.env);
    expect(await held.exited).toEqual({ code: null, stderr: 'refusing to run a non-absolute path: node' });
  });
});
