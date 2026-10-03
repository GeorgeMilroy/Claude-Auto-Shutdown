import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { addForeignRoots, configuredRoots, isForeignPath } from '../../src/core/roots';

const HOME = path.join(os.tmpdir(), 'cas-roots-home');
const onWindows = process.platform === 'win32';

describe('isForeignPath', () => {
  it.each([
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude',
    '\\\\wsl$\\Ubuntu\\home\\me\\.claude',
    '\\\\WSL.LOCALHOST\\Debian\\root\\.claude',
    '//wsl.localhost/Ubuntu/home/me/.claude',
  ])('is true for %s', (dir) => {
    expect(isForeignPath(dir)).toBe(true);
  });

  it.each(['C:\\Users\\me\\.claude', '/home/me/.claude', '\\\\fileserver\\share\\.claude', 'D:\\wsl.localhost\\x'])('is false for %s', (dir) => {
    expect(isForeignPath(dir)).toBe(false);
  });
});

describe('configuredRoots', () => {
  it('always watches ~/.claude', () => {
    expect(configuredRoots(HOME, {}, [])).toEqual({
      roots: [{ path: path.join(HOME, '.claude'), label: '~/.claude', kind: 'local', optional: true }],
      problems: [],
    });
  });

  it('adds $CLAUDE_CONFIG_DIR next to it, never instead of it', () => {
    const other = path.join(HOME, 'work-config');
    const { roots, problems } = configuredRoots(HOME, { CLAUDE_CONFIG_DIR: ` ${other}${path.sep} ` }, []);
    expect(problems).toEqual([]);
    expect(roots.map((root) => [root.path, root.label, root.optional])).toEqual([
      [path.join(HOME, '.claude'), '~/.claude', true],
      [other, '$CLAUDE_CONFIG_DIR', true],
    ]);
  });

  it('lists a location once when the variable points at ~/.claude', () => {
    expect(configuredRoots(HOME, { CLAUDE_CONFIG_DIR: path.join(HOME, '.claude') }, []).roots).toHaveLength(1);
    expect(configuredRoots(HOME, { CLAUDE_CONFIG_DIR: '' }, []).roots).toHaveLength(1);
  });

  it('adds every extra folder as one that must exist', () => {
    const extra = path.join(HOME, 'second');
    const { roots } = configuredRoots(HOME, {}, [extra, '  ', extra + path.sep]);
    expect(roots.slice(1)).toEqual([{ path: extra, label: extra, kind: 'local', optional: false }]);
  });

  it('expands ~ in an extra folder', () => {
    const { roots } = configuredRoots(HOME, {}, ['~/.claude-work']);
    expect(roots[1]).toMatchObject({ path: path.join(HOME, '.claude-work'), label: '~/.claude-work', optional: false });
  });

  it('makes ~/.claude required when the settings list it too', () => {
    const { roots } = configuredRoots(HOME, {}, ['~/.claude']);
    expect(roots).toEqual([{ path: path.join(HOME, '.claude'), label: '~/.claude', kind: 'local', optional: false }]);
  });

  it('reports a relative path instead of guessing what it is relative to', () => {
    const { roots, problems } = configuredRoots(HOME, { CLAUDE_CONFIG_DIR: 'config/claude' }, ['other-claude']);
    expect(roots).toHaveLength(1);
    expect(problems).toEqual([
      "CLAUDE_CONFIG_DIR is not a full path (config/claude), so that Claude folder can't be watched.",
      "An extra Claude folder in the settings is not a full path (other-claude), so that Claude folder can't be watched.",
    ]);
  });

  it.runIf(onWindows)('marks a folder inside WSL as foreign', () => {
    const { roots, problems } = configuredRoots(HOME, {}, ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude']);
    expect(problems).toEqual([]);
    expect(roots[1]).toMatchObject({ kind: 'foreign', optional: false });
  });

  it.runIf(onWindows)('treats two spellings of one Windows location as one', () => {
    const upper = path.join(HOME, '.CLAUDE').replace(/\\/g, '/');
    expect(configuredRoots(HOME, { CLAUDE_CONFIG_DIR: upper }, []).roots).toHaveLength(1);
  });
});

describe('addForeignRoots', () => {
  const ubuntu = '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude';

  it('adds what the platform found as optional foreign roots', () => {
    const { roots } = configuredRoots(HOME, {}, []);
    addForeignRoots(roots, [{ path: ubuntu, label: 'WSL: Ubuntu' }]);
    expect(roots[1]).toEqual({ path: ubuntu, label: 'WSL: Ubuntu', kind: 'foreign', optional: true });
  });

  it.runIf(onWindows)('merges with the same folder from the settings: still required, named after the distro', () => {
    const { roots } = configuredRoots(HOME, {}, ['\\\\wsl$\\Ubuntu\\home\\me\\.claude']);
    addForeignRoots(roots, [{ path: ubuntu, label: 'WSL: Ubuntu' }]);
    expect(roots).toHaveLength(2);
    expect(roots[1]).toMatchObject({ label: 'WSL: Ubuntu', kind: 'foreign', optional: false });
  });

  it('does not add the same folder twice', () => {
    const { roots } = configuredRoots(HOME, {}, []);
    addForeignRoots(roots, [
      { path: ubuntu, label: 'WSL: Ubuntu' },
      { path: ubuntu, label: 'WSL: Ubuntu' },
    ]);
    expect(roots).toHaveLength(2);
  });
});
