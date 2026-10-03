import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));

afterAll(() => {
  fs.rmSync(workFolder, { recursive: true, force: true });
});

describe('dispose()', () => {
  it('leaves no timer, socket or server behind: a process full of coordinators ends by itself', () => {
    const outfile = path.join(workFolder, 'scenario.cjs');
    buildSync({
      entryPoints: [path.join(__dirname, 'cleanExit.scenario.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });

    // A timer or handle that survived dispose() keeps the child alive until this timeout kills it.
    const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8', timeout: 15_000 });

    expect(run.stderr).toBe('');
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout.trim()) as {
      handedOver: unknown;
      rolesAtDispose: string[];
      leftover: string[];
    };
    // The scenario really was in the middle of everything when it disposed...
    expect(report.handedOver).toEqual({ handedOver: true });
    expect(report.rolesAtDispose).toEqual(['electing', 'leader', 'electing', 'electing', 'isolated', 'follower']);
    // ...and nothing it started was still alive 100 ms later.
    expect(report.leftover).toEqual([]);
  });
});
