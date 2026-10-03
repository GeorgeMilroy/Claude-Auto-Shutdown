import { describe, expect, it } from 'vitest';

import { findStrays } from '../../src/core/claudeProcess';
import { isClaudeCodeProcess } from '../../src/core/scanner';
import type { ProcDetail } from '../../src/platform/types';
import { CLAUDE_EXE, detail } from './support';

describe('isClaudeCodeProcess', () => {
  it.each([
    ['the binary inside the VS Code extension', 'claude', CLAUDE_EXE],
    ['the Claude Code bundled with the desktop app', 'claude', 'C:\\Users\\X\\AppData\\Roaming\\Claude\\claude-code\\2.1.26\\claude.exe'],
    ['the launcher of the native installer', 'claude', '/home/x/.local/bin/claude'],
    ['a native binary named after its version', '2.1.283', '/home/x/.local/share/claude/versions/2.1.283'],
    ['an npm install', 'claude', '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude'],
    ['a Windows native install', 'claude', 'C:\\Users\\X\\.local\\bin\\claude.exe'],
    ['a path in another case with mixed slashes', 'claude', 'C:/USERS/X/.Local/Bin\\CLAUDE.EXE'],
  ])('yes: %s', (_label, name, path) => {
    expect(isClaudeCodeProcess(name, path)).toBe('yes');
  });

  it.each([
    ['the desktop app (installer build)', 'claude', 'C:\\Users\\X\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe'],
    ['the desktop app (Store build)', 'claude', 'C:\\Program Files\\WindowsApps\\Claude_1.0.0_x64__abc\\app\\claude.exe'],
    ['the browser bridge', 'chrome-native-host', 'C:\\Users\\X\\AppData\\Roaming\\Claude\\ChromeNativeHost\\chrome-native-host.exe'],
    ['the macOS app', 'claude', '/Applications/Claude.app/Contents/MacOS/Claude'],
    ['a macOS app helper', 'claude helper', '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'],
    ['the Linux desktop package', 'claude', '/opt/claude-desktop/claude'],
    ['a program that merely lives in a folder called claude', 'node', 'C:\\Users\\X\\claude\\tools\\node.exe'],
    ['the folder name of this very project', 'code', 'D:\\Developments\\Claude-Auto-Shutdown\\node_modules\\.bin\\code.exe'],
    ['a name that only starts like it', 'claude-helper', '/usr/bin/claude-helper'],
  ])('no: %s', (_label, name, path) => {
    expect(isClaudeCodeProcess(name, path)).toBe('no');
  });

  it('is unknown when a process named claude has no readable path', () => {
    expect(isClaudeCodeProcess('claude', null)).toBe('unknown');
    expect(isClaudeCodeProcess('claude', '')).toBe('unknown');
    expect(isClaudeCodeProcess('Claude.EXE', null)).toBe('unknown');
  });

  it('is no when the path is unreadable and the name is something else', () => {
    expect(isClaudeCodeProcess('node', null)).toBe('no');
    expect(isClaudeCodeProcess('claude-code', null)).toBe('no');
    expect(isClaudeCodeProcess('', null)).toBe('no');
  });
});

describe('findStrays', () => {
  const rows = [
    { pid: 30, ppid: 1, name: 'claude' },
    { pid: 10, ppid: 1, name: 'claude' },
    { pid: 20, ppid: 1, name: 'node' },
  ];
  const details = (entries: Record<number, ProcDetail>): Map<number, ProcDetail> =>
    new Map(Object.entries(entries).map(([pid, info]) => [Number(pid), info]));

  it('lists Claude Code processes outside every session family, by PID', () => {
    const strays = findStrays(rows, details({ 10: detail({ path: CLAUDE_EXE }), 30: detail({ path: CLAUDE_EXE }) }), new Set(), new Set());
    expect(strays.map((stray) => stray.pid)).toEqual([10, 30]);
    expect(strays[0]).toMatchObject({ name: 'claude', path: CLAUDE_EXE, ignored: false });
  });

  it('leaves out session processes, exited processes and other programs', () => {
    const known = details({ 10: detail({ path: CLAUDE_EXE }), 30: detail({ path: CLAUDE_EXE, state: 'exited' }) });
    expect(findStrays(rows, known, new Set([10]), new Set())).toEqual([]);
  });

  it('keeps a process named claude that nothing is known about', () => {
    const strays = findStrays(rows, new Map(), new Set([30]), new Set());
    expect(strays).toEqual([{ pid: 10, name: 'claude', path: null, startEpochMs: null, ignoreKey: 'proc:10:0', ignored: false }]);
  });

  it('builds the ignore key from the start time and honours it', () => {
    const known = details({ 10: detail({ path: CLAUDE_EXE, startRaw: '555', startEpochMs: 42 }) });
    const [stray] = findStrays(rows.slice(1, 2), known, new Set(), new Set(['proc:10:555']));
    expect(stray).toMatchObject({ ignoreKey: 'proc:10:555', ignored: true, startEpochMs: 42 });
  });
});
