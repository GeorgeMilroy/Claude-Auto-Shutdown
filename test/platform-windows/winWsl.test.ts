// WSL root discovery with a fake wsl.exe runner and a fake file system. Nothing touches a real
// \\wsl.localhost path (opening one would start the distro).

import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/platform/exec';
import { parseWslList, wslIndicator, WslRootFinder, type WslFs } from '../../src/platform/winWsl';
import { runResult } from './support';

const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';
const names = (...list: string[]) => new Set(list);

function fsError(code: string, file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${file}`), { code });
}

/** Directories that exist, by full path -> entries (for readdir) or true (is a directory). */
function fakeFs(tree: Record<string, string[] | true>, failures: Record<string, string | 'hang'> = {}) {
  const touched: string[] = [];
  const check = (file: string): void => {
    touched.push(file);
    const failure = failures[file];
    if (failure && failure !== 'hang') throw fsError(failure, file);
  };
  const hang = (file: string) => failures[file] === 'hang';
  const fs: WslFs = {
    readdir: async (dir) => {
      check(dir);
      if (hang(dir)) return new Promise<string[]>(() => undefined);
      const entry = tree[dir];
      if (!Array.isArray(entry)) throw fsError('ENOENT', dir);
      return entry;
    },
    isDirectory: async (file) => {
      check(file);
      if (hang(file)) return new Promise<boolean>(() => undefined);
      if (tree[file] === undefined) throw fsError('ENOENT', file);
      return true;
    },
  };
  return { fs, touched };
}

function setup(options: { results: Record<string, RunResult>; tree?: Record<string, string[] | true>; failures?: Record<string, string | 'hang'>; wslExe?: string | null }) {
  const runs: string[] = [];
  let now = 1_000_000;
  const { fs, touched } = fakeFs(options.tree ?? {}, options.failures);
  const finder = new WslRootFinder({
    wslExe: options.wslExe === undefined ? WSL_EXE : options.wslExe,
    run: async (file, args, runOptions) => {
      expect(file).toBe(WSL_EXE);
      expect(runOptions).toMatchObject({ timeoutMs: 5000, encoding: 'utf16le' });
      const key = args.join(' ');
      runs.push(key);
      return options.results[key] ?? runResult({ code: 1 });
    },
    fs,
    now: () => now,
    fsTimeoutMs: 60,
  });
  return { finder, runs, touched, advance: (ms: number) => (now += ms) };
}

const RUNNING = '-l --running -q';
const INSTALLED = '-l -q';
const UBUNTU_TREE: Record<string, string[] | true> = {
  '\\\\wsl.localhost\\Ubuntu\\home': ['me', 'guest'],
  '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude': true,
};

describe('wslIndicator', () => {
  it('tells WSL-only processes from the VM name Hyper-V also uses', () => {
    expect(wslIndicator(names('explorer', 'code'))).toBe('none');
    expect(wslIndicator(names('vmmem'))).toBe('possible');
    expect(wslIndicator(names('vmmemwsl'))).toBe('definite');
    expect(wslIndicator(names('wslhost', 'vmmem'))).toBe('definite');
    // The WSL service is always running; it says nothing about distros.
    expect(wslIndicator(names('wslservice'))).toBe('none');
  });
});

describe('parseWslList', () => {
  it('reads one distro per line from the decoded UTF-16 output', () => {
    expect(parseWslList('\ufeffUbuntu\r\nDebian\r\n')).toEqual({ distros: ['Ubuntu', 'Debian'], unusable: [] });
    expect(parseWslList('Ubuntu-22.04\r\r\nkali_linux\n\n')).toEqual({ distros: ['Ubuntu-22.04', 'kali_linux'], unusable: [] });
    expect(parseWslList(Buffer.from('Ubuntu\r\n', 'utf16le').toString('utf16le'))).toEqual({ distros: ['Ubuntu'], unusable: [] });
  });

  it('strips stray NULs, ignores sentences and reports words that cannot be a folder name', () => {
    expect(parseWslList('U\u0000buntu\r\n')).toEqual({ distros: ['Ubuntu'], unusable: [] });
    expect(parseWslList('There are no running distributions.\r\n')).toEqual({ distros: [], unusable: [] });
    expect(parseWslList('..\\evil\r\n..\r\nUbuntu\r\nUbuntu\r\n')).toEqual({ distros: ['Ubuntu'], unusable: ['..\\evil', '..'] });
    expect(parseWslList('')).toEqual({ distros: [], unusable: [] });
  });
});

describe('WslRootFinder', () => {
  it('does nothing while no WSL process is running', async () => {
    const { finder, runs, touched } = setup({ results: {} });
    expect(await finder.find(names('explorer', 'code'))).toEqual({ roots: [], problem: null });
    expect(runs).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('does nothing when wsl.exe does not exist', async () => {
    const { finder, runs } = setup({ results: {}, wslExe: null });
    expect(await finder.find(names('vmmemwsl'))).toEqual({ roots: [], problem: null });
    expect(runs).toEqual([]);
  });

  it('cannot tell without a process list', async () => {
    const { finder, runs } = setup({ results: {} });
    const found = await finder.find(null);
    expect(found.roots).toEqual([]);
    expect(found.problem).toMatch(/Couldn't check whether WSL is running/);
    expect(runs).toEqual([]);
  });

  it('finds ~/.claude of every user of a running distro', async () => {
    const { finder, touched } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE });
    expect(await finder.find(names('vmmemwsl'))).toEqual({
      roots: [{ path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', label: 'WSL: Ubuntu' }],
      problem: null,
    });
    expect(touched).toEqual([
      '\\\\wsl.localhost\\Ubuntu\\home',
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude',
      '\\\\wsl.localhost\\Ubuntu\\home\\guest\\.claude',
      '\\\\wsl.localhost\\Ubuntu\\root\\.claude',
    ]);
  });

  it('includes /root/.claude when it is readable', async () => {
    const tree = { ...UBUNTU_TREE, '\\\\wsl.localhost\\Ubuntu\\root\\.claude': true as const };
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree });
    const found = await finder.find(names('wslhost'));
    expect(found.roots.map((root) => root.path)).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', '\\\\wsl.localhost\\Ubuntu\\root\\.claude']);
  });

  it('never touches a distro that is not running, nor Docker Desktop', async () => {
    const { finder, touched } = setup({ results: { [RUNNING]: runResult({ stdout: 'docker-desktop\r\ndocker-desktop-data\r\nDocker-Desktop\r\n' }) } });
    expect(await finder.find(names('vmmemwsl'))).toEqual({ roots: [], problem: null });
    expect(touched).toEqual([]);
  });

  it('treats a home it may not read as "not ours", not as a fault', async () => {
    const failures = { '\\\\wsl.localhost\\Ubuntu\\home\\guest\\.claude': 'EACCES', '\\\\wsl.localhost\\Ubuntu\\root\\.claude': 'EACCES' };
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE, failures });
    const found = await finder.find(names('vmmemwsl'));
    expect(found.problem).toBeNull();
    expect(found.roots).toHaveLength(1);
  });

  it('falls back to \\\\wsl$ where \\\\wsl.localhost is not served', async () => {
    const tree = { '\\\\wsl$\\Debian\\home': ['me'], '\\\\wsl$\\Debian\\home\\me\\.claude': true as const };
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Debian\r\n' }) }, tree });
    expect(await finder.find(names('vmmem'))).toEqual({ roots: [{ path: '\\\\wsl$\\Debian\\home\\me\\.claude', label: 'WSL: Debian' }], problem: null });
  });

  it('accepts a distro without /home', async () => {
    const tree = { '\\\\wsl.localhost\\Alpine\\': ['bin', 'etc', 'root'], '\\\\wsl.localhost\\Alpine\\root\\.claude': true as const };
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Alpine\r\n' }) }, tree });
    expect(await finder.find(names('vmmemwsl'))).toEqual({ roots: [{ path: '\\\\wsl.localhost\\Alpine\\root\\.claude', label: 'WSL: Alpine' }], problem: null });
  });

  it('reports a running distro whose files cannot be read', async () => {
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) } });
    const found = await finder.find(names('vmmemwsl'));
    expect(found.roots).toEqual([]);
    expect(found.problem).toMatch(/^WSL: Ubuntu: its files couldn't be read/);
  });

  it('reports an unreadable /home of a reachable distro', async () => {
    const tree = { '\\\\wsl.localhost\\Ubuntu\\': ['home', 'root'] };
    const failures = { '\\\\wsl.localhost\\Ubuntu\\home': 'EIO' };
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree, failures });
    expect((await finder.find(names('vmmemwsl'))).problem).toMatch(/\/home: EIO/);
  });

  it('reports an unexpected error on a Claude folder but keeps the roots it already found', async () => {
    const failures = { '\\\\wsl.localhost\\Ubuntu\\home\\guest\\.claude': 'EIO' };
    const { finder } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE, failures });
    const found = await finder.find(names('vmmemwsl'));
    expect(found.roots).toHaveLength(1);
    expect(found.problem).toMatch(/EIO/);
  });

  it('gives up on a distro that does not answer and leaves it alone until it does', async () => {
    const failures = { '\\\\wsl.localhost\\Ubuntu\\home': 'hang' as const };
    const { finder, touched, advance } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE, failures });
    const first = await finder.find(names('vmmemwsl'));
    expect(first.problem).toMatch(/no answer within/);
    expect(touched).toEqual(['\\\\wsl.localhost\\Ubuntu\\home']);

    advance(11_000);
    const second = await finder.find(names('vmmemwsl'));
    expect(second.problem).toMatch(/still not answering/);
    // No second request was sent to the hanging share.
    expect(touched).toEqual(['\\\\wsl.localhost\\Ubuntu\\home']);
  });

  it('reports a distro name that cannot be a folder name', async () => {
    const { finder, touched } = setup({ results: { [RUNNING]: runResult({ stdout: '..\\..\\Windows\r\nUbuntu\r\n' }) }, tree: UBUNTU_TREE });
    const found = await finder.find(names('vmmemwsl'));
    expect(found.roots).toHaveLength(1);
    expect(found.problem).toMatch(/can't be used as a folder name/);
    expect(touched.every((file) => file.startsWith('\\\\wsl.localhost\\Ubuntu\\'))).toBe(true);
  });

  it('caches a good answer for 60 s and a problem for 10 s', async () => {
    const good = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE });
    await good.finder.find(names('vmmemwsl'));
    good.advance(59_000);
    await good.finder.find(names('vmmemwsl'));
    expect(good.runs).toEqual([RUNNING]);
    good.advance(2_000);
    await good.finder.find(names('vmmemwsl'));
    expect(good.runs).toEqual([RUNNING, RUNNING]);

    const bad = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) } });
    expect((await bad.finder.find(names('vmmemwsl'))).problem).not.toBeNull();
    bad.advance(9_000);
    await bad.finder.find(names('vmmemwsl'));
    expect(bad.runs).toEqual([RUNNING]);
    bad.advance(2_000);
    await bad.finder.find(names('vmmemwsl'));
    expect(bad.runs).toEqual([RUNNING, RUNNING]);
  });

  it('forgets the cache once WSL is no longer running', async () => {
    const { finder, runs } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE });
    await finder.find(names('vmmemwsl'));
    expect(await finder.find(names('explorer'))).toEqual({ roots: [], problem: null });
    await finder.find(names('vmmemwsl'));
    expect(runs).toEqual([RUNNING, RUNNING]);
  });

  it('asks wsl.exe only once for concurrent callers', async () => {
    const { finder, runs } = setup({ results: { [RUNNING]: runResult({ stdout: 'Ubuntu\r\n' }) }, tree: UBUNTU_TREE });
    const [a, b] = await Promise.all([finder.find(names('vmmemwsl')), finder.find(names('vmmemwsl'))]);
    expect(a).toEqual(b);
    expect(runs).toEqual([RUNNING]);
  });

  describe('when wsl.exe does not list anything (it exits non-zero for "nothing running" too)', () => {
    const notInstalled = runResult({ code: 1, stderr: 'The Windows Subsystem for Linux is not installed.' });

    it('plain vmmem (Hyper-V, Docker, Sandbox) is not a problem', async () => {
      const { finder, runs } = setup({ results: { [RUNNING]: notInstalled } });
      expect(await finder.find(names('vmmem'))).toEqual({ roots: [], problem: null });
      expect(runs).toEqual([RUNNING]);
    });

    it('a WSL process with a working WSL just means no distro is running', async () => {
      const { finder, runs } = setup({ results: { [RUNNING]: runResult({ code: -1, stdout: 'There are no running distributions.\r\n' }), [INSTALLED]: runResult({ stdout: 'Ubuntu\r\n' }) } });
      expect(await finder.find(names('vmmemwsl'))).toEqual({ roots: [], problem: null });
      expect(runs).toEqual([RUNNING, INSTALLED]);
    });

    it('a WSL process with a WSL that cannot be queried is a problem', async () => {
      const { finder } = setup({ results: { [RUNNING]: runResult({ code: -1 }), [INSTALLED]: runResult({ code: -1 }) } });
      const found = await finder.find(names('wslhost'));
      expect(found.roots).toEqual([]);
      expect(found.problem).toMatch(/list of running distros couldn't be read \(exit code -1\)/);
    });

    it('a wsl.exe that hangs is a problem when WSL is definitely running', async () => {
      const hung = runResult({ code: null, timedOut: true, elapsedMs: 5000 });
      const { finder } = setup({ results: { [RUNNING]: hung, [INSTALLED]: hung } });
      expect((await finder.find(names('vmmemwsl'))).problem).toMatch(/no answer within 5 seconds/);
    });
  });
});
