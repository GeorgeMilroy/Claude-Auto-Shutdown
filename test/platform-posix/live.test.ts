// The only tests that use the REAL file system and REAL tools. They are read-only (snapshot, probe,
// idle time): no capability query that could raise a consent dialog, and never execute().
//
// The Linux and macOS blocks run only on those systems. They were written on Windows and have not
// been run yet: the first run on real hardware is what verifies the backends' assumptions about
// /proc and ps, so a failure here is a finding about the backend, not a flaky test.

import * as fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createLinuxPlatform } from '../../src/platform/linux';
import { createMacPlatform } from '../../src/platform/macos';
import type { PlatformOptions } from '../../src/platform/index';

const options: PlatformOptions = { extensionPath: '/opt/extension', log: () => undefined };
/** Start of this very process, from Node's own clock. */
const ownStartMs = (): number => Date.now() - process.uptime() * 1000;
/** No PID is ever this large (Linux caps at 4194304, macOS at 99998). */
const IMPOSSIBLE_PID = 2_000_000_000;

describe.runIf(process.platform === 'linux')('linux backend, live and read-only', () => {
  it('finds this process in /proc with the right parent, path and start time', async () => {
    const platform = createLinuxPlatform(options);
    const snapshot = await platform.snapshot({ detailPids: [process.pid, IMPOSSIBLE_PID], detailNames: [] });
    expect(snapshot.processes).not.toBeNull();
    expect(snapshot.processes?.find((row) => row.pid === process.pid)?.ppid).toBe(process.ppid);

    const detail = snapshot.details[process.pid];
    expect(detail?.state).toBe('ok');
    expect(detail?.path).toBe(fs.realpathSync(process.execPath));
    expect(detail?.startRaw).toMatch(/^\d+$/);
    // btime has whole seconds, so allow a little more than one.
    expect(Math.abs((detail?.startEpochMs ?? 0) - ownStartMs())).toBeLessThan(3000);
    expect(detail?.cpuSeconds).toBeGreaterThan(0);
    expect(detail?.ioBytes).toBeGreaterThan(0);
    expect(snapshot.details[IMPOSSIBLE_PID]?.state).toBe('gone');
    expect(platform.procStartUnitsPerSecond).toBeGreaterThan(0);
    await platform.dispose();
  });

  it('probes this process and reports an idle time that is a number or unknown', async () => {
    const platform = createLinuxPlatform(options);
    const details = await platform.probe([process.pid, IMPOSSIBLE_PID]);
    expect(details[process.pid]?.state).toBe('ok');
    expect(details[IMPOSSIBLE_PID]?.state).toBe('gone');
    const idle = await platform.idleSeconds();
    if (idle !== null) expect(idle).toBeGreaterThanOrEqual(0);
    await platform.dispose();
  });
});

describe.runIf(process.platform === 'darwin')('macos backend, live and read-only', () => {
  it('finds this process in the ps listing with the right parent and start time', async () => {
    const platform = createMacPlatform(options);
    const snapshot = await platform.snapshot({ detailPids: [process.pid, IMPOSSIBLE_PID], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    expect(snapshot.processes?.find((row) => row.pid === process.pid)?.ppid).toBe(process.ppid);

    const detail = snapshot.details[process.pid];
    expect(['ok', 'partial']).toContain(detail?.state);
    // lstart has whole seconds; a wrong time zone would be off by hours.
    expect(Math.abs((detail?.startEpochMs ?? 0) - ownStartMs())).toBeLessThan(3000);
    expect(detail?.cpuSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.details[IMPOSSIBLE_PID]?.state).toBe('gone');
    await platform.dispose();
  });

  it('probes this process and reports an idle time that is a number or unknown', async () => {
    const platform = createMacPlatform(options);
    const details = await platform.probe([process.pid]);
    expect(['ok', 'partial']).toContain(details[process.pid]?.state);
    const idle = await platform.idleSeconds();
    if (idle !== null) expect(idle).toBeGreaterThanOrEqual(0);
    await platform.dispose();
  });
});

// Windows has no /proc and no /bin/ps: with the real system both backends must answer "unknown"
// for everything and call nothing gone.
describe.runIf(process.platform === 'win32' && !fs.existsSync('/proc') && !fs.existsSync('/bin/ps'))(
  'POSIX backends on a machine they do not belong on (real system)',
  () => {
    it.each([
      ['linux', createLinuxPlatform],
      ['macos', createMacPlatform],
    ] as const)('%s: everything is unknown, nothing is gone, nothing rejects', async (_name, create) => {
      const platform = create(options);
      const snapshot = await platform.snapshot({ detailPids: [process.pid], detailNames: ['claude'] });
      expect(snapshot).toMatchObject({ idleSeconds: null, processes: null, details: {} });
      expect(snapshot.problem).not.toBeNull();
      expect(await platform.probe([process.pid, 1])).toEqual({});
      expect(await platform.idleSeconds()).toBeNull();
      expect(platform.helperStatus().tier).toBe('unavailable');
      expect((await platform.keepAwake(true)).ok).toBe(false);
      await platform.dispose();
    });
  },
);
