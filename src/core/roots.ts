// Which Claude config folders a scan looks at, and what state each one is in.
//
// Claude Code keeps its session registry and transcripts in ~/.claude, or wherever
// CLAUDE_CONFIG_DIR pointed when it was started. The editor's environment is not the environment
// of the terminals Claude runs in, so the default folder is ALWAYS watched, and the variable and
// the user's extra folders are watched in addition - never instead.

import * as path from 'node:path';

import type { ForeignRoot } from '../platform/types';
import { listDir, type DirEntry, type GuardedFs, type Listing } from './scannerFs';
import { locationKey } from './scannerSupport';
import type { RootStatus } from './types';

export interface ScanRoot {
  path: string;
  label: string;
  /** foreign = its registry PIDs belong to another system (WSL): no process checks. */
  kind: RootStatus['kind'];
  /** Not existing is fine (the default locations). A folder the user listed must exist. */
  optional: boolean;
}

export interface RootPlan {
  roots: ScanRoot[];
  /** Configured folders that cannot be watched at all, one sentence each. */
  problems: string[];
}

const HOME_ROOT_LABEL = '~/.claude';
const ENV_ROOT_LABEL = '$CLAUDE_CONFIG_DIR';

const WSL_SHARES = ['\\\\wsl.localhost\\', '\\\\wsl$\\'];

/** A folder inside a WSL distro, reached through its network share. */
export function isForeignPath(dir: string): boolean {
  const lower = dir.replace(/\//g, '\\').toLowerCase();
  return WSL_SHARES.some((share) => lower.startsWith(share));
}

function withoutTrailingSeparators(dir: string): string {
  const normal = path.normalize(dir);
  return normal.length > path.parse(normal).root.length ? normal.replace(/[\\/]+$/, '') : normal;
}

/** The absolute folder a setting names ('~' is the home folder); null when it is not absolute. */
function locate(dir: string, homeDir: string): string | null {
  const expanded = dir === '~' || /^~[\\/]/.test(dir) ? path.join(homeDir, dir.slice(1)) : dir;
  return path.isAbsolute(expanded) ? withoutTrailingSeparators(expanded) : null;
}

function findRoot(roots: readonly ScanRoot[], dir: string): ScanRoot | undefined {
  const key = locationKey(dir);
  return roots.find((root) => locationKey(root.path) === key);
}

function addRoot(roots: ScanRoot[], dir: string, label: string, optional: boolean): void {
  const known = findRoot(roots, dir);
  // Named twice: it has to exist as soon as one of the mentions says so.
  if (known !== undefined) known.optional = known.optional && optional;
  else roots.push({ path: dir, label, kind: isForeignPath(dir) ? 'foreign' : 'local', optional });
}

/** ~/.claude, $CLAUDE_CONFIG_DIR and the extra folders from the settings, each location once. */
export function configuredRoots(homeDir: string, env: NodeJS.ProcessEnv, extraDirs: readonly string[]): RootPlan {
  const roots: ScanRoot[] = [];
  const problems: string[] = [];
  const addConfigured = (dir: string, label: string, optional: boolean, source: string): void => {
    const located = locate(dir, homeDir);
    // A relative path means something different in every terminal: there is no telling which
    // folder to watch, and a folder that is not watched must not look like a quiet one.
    if (located === null) problems.push(`${source} is not a full path (${dir}), so that Claude folder can't be watched.`);
    else addRoot(roots, located, label, optional);
  };

  addRoot(roots, withoutTrailingSeparators(path.join(homeDir, '.claude')), HOME_ROOT_LABEL, true);
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) addConfigured(override, ENV_ROOT_LABEL, true, 'CLAUDE_CONFIG_DIR');
  for (const dir of extraDirs) {
    const trimmed = dir.trim();
    if (trimmed !== '') addConfigured(trimmed, trimmed, false, 'An extra Claude folder in the settings');
  }
  return { roots, problems };
}

/** Adds the Claude folders the platform found in other systems (running WSL distros). */
export function addForeignRoots(roots: ScanRoot[], found: readonly ForeignRoot[]): void {
  for (const { path: dir, label } of found) {
    const known = findRoot(roots, dir);
    // The platform's label names the distro, and that name is what a remote window is matched by.
    if (known !== undefined && known.kind === 'foreign') known.label = label;
    else if (known === undefined) roots.push({ path: dir, label, kind: 'foreign', optional: true });
  }
}

export interface OpenRoot {
  /** Position in the scan's root list; part of every session key found here. */
  index: number;
  root: ScanRoot;
  fs: GuardedFs;
  sessionsDir: string;
  projectsDir: string;
  /** Registry file names (sessions/*.json), sorted. */
  sessionFiles: string[];
  /** Project folder names (projects/*), sorted. */
  projects: string[];
  status: RootStatus;
}

function namesOf(listing: Listing, wanted: (entry: DirEntry) => boolean): string[] {
  if (listing.state !== 'ok') return [];
  return listing.entries
    .filter(wanted)
    .map((entry) => entry.name)
    .sort();
}

function describeRoot(root: ScanRoot): string {
  return root.label === root.path ? root.path : `${root.label} (${root.path})`;
}

function rootProblem(root: ScanRoot, sessions: Listing, projects: Listing): string | null {
  const failed = sessions.state === 'failed' ? sessions : projects.state === 'failed' ? projects : null;
  if (failed !== null) return `The Claude folder ${describeRoot(root)} couldn't be read: ${failed.reason}.`;
  if (sessions.state === 'missing' && projects.state === 'missing' && !root.optional) {
    return `The extra Claude folder ${root.path} doesn't exist, or has no sessions and no projects folder.`;
  }
  return null;
}

/** Lists a root's registry files and project folders. Never rejects; `problem` is the scan error. */
export async function openRoot(root: ScanRoot, index: number, fs: GuardedFs): Promise<{ open: OpenRoot; problem: string | null }> {
  const sessionsDir = path.join(root.path, 'sessions');
  const projectsDir = path.join(root.path, 'projects');
  const [sessions, projects] = await Promise.all([listDir(fs, sessionsDir), listDir(fs, projectsDir)]);
  const problem = rootProblem(root, sessions, projects);
  const missing = sessions.state === 'missing' && projects.state === 'missing';
  const open: OpenRoot = {
    index,
    root,
    fs,
    sessionsDir,
    projectsDir,
    sessionFiles: namesOf(sessions, (entry) => entry.kind !== 'dir' && entry.name.toLowerCase().endsWith('.json')),
    projects: namesOf(projects, (entry) => entry.kind !== 'file'),
    status: {
      path: root.path,
      label: root.label,
      kind: root.kind,
      ok: problem === null,
      missing,
      detail: problem ?? (missing ? 'No sessions or projects folder here.' : null),
    },
  };
  return { open, problem };
}
