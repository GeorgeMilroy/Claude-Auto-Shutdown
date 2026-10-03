import { describe, expect, it } from 'vitest';
import { buildAlertLaunch, inertAlert } from '../../src/platform/winAlert';
import type { CountdownAlertOptions } from '../../src/platform/types';

const ROOT = 'C:\\Windows';
const EXTENSION = 'C:\\Users\\me\\.vscode\\extensions\\cas';
const NOW = Date.UTC(2026, 9, 3, 2, 0, 0);
const options = (overrides: Partial<CountdownAlertOptions> = {}): CountdownAlertOptions => ({
  seconds: 90,
  kind: 'real',
  title: 'Shutting down this PC in',
  body: 'All Claude sessions finished.',
  cancelLabel: 'Cancel: keep this PC on',
  sound: false,
  ...overrides,
});

/** The value that follows `flag` on the command line. */
function argAfter(args: string[] | undefined, flag: string): string | undefined {
  const index = args?.indexOf(flag) ?? -1;
  return index >= 0 ? args?.[index + 1] : undefined;
}

describe('buildAlertLaunch', () => {
  it('starts the alert script with one fixed PowerShell command line', () => {
    const launch = buildAlertLaunch(ROOT, EXTENSION, options(), 4242, NOW);
    expect(launch?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(launch?.cwd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(launch?.args.slice(0, 6)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File']);
    expect(launch?.args[6]).toMatch(/resources[\\/]win-countdown-alert\.ps1$/);
    expect(launch?.args.slice(7)).toEqual(['-Seconds', '90', '-DeadlineUnixMs', String(NOW + 90_000), '-Kind', 'real', '-ParentPid', '4242']);
  });

  it('counts to a deadline fixed at the call, so the start-up time of the window is already spent', () => {
    const launch = buildAlertLaunch(ROOT, EXTENSION, options({ seconds: 29 }), 1, NOW + 1234);
    expect(argAfter(launch?.args, '-DeadlineUnixMs')).toBe(String(NOW + 1234 + 29_000));
  });

  it('adds -Sound only for a real boolean true', () => {
    expect(buildAlertLaunch(ROOT, EXTENSION, options({ sound: true }), 1, NOW)?.args).toContain('-Sound');
    for (const sound of [false, 'true', 1, undefined] as unknown[]) {
      expect(buildAlertLaunch(ROOT, EXTENSION, options({ sound: sound as boolean }), 1, NOW)?.args, String(sound)).not.toContain('-Sound');
    }
  });

  it('never puts a text on the command line', () => {
    const launch = buildAlertLaunch(ROOT, EXTENSION, options({ title: '-Kind real', body: '"; Stop-Computer; "', cancelLabel: '$(evil)' }), 1, NOW);
    const line = launch?.args.join(' ') ?? '';
    expect(line).not.toContain('Stop-Computer');
    expect(line).not.toContain('evil');
    expect(launch?.args.filter((arg) => arg === '-Kind')).toHaveLength(1);
    expect(launch?.env).toMatchObject({ CAS_ALERT_TITLE: '-Kind real', CAS_ALERT_BODY: '"; Stop-Computer; "', CAS_ALERT_CANCEL: '$(evil)' });
  });

  it('marks a test run and a preview, and leaves the real thing unmarked', () => {
    expect(buildAlertLaunch(ROOT, EXTENSION, options({ kind: 'real' }), 1, NOW)?.env.CAS_ALERT_BADGE).toBe('');
    expect(buildAlertLaunch(ROOT, EXTENSION, options({ kind: 'test' }), 1, NOW)?.env.CAS_ALERT_BADGE).toMatch(/^TEST RUN/);
    expect(buildAlertLaunch(ROOT, EXTENSION, options({ kind: 'preview' }), 1, NOW)?.env.CAS_ALERT_BADGE).toMatch(/^PREVIEW/);
  });

  it('turns texts into single clean lines of bounded length', () => {
    const launch = buildAlertLaunch(ROOT, EXTENSION, options({ title: '  line one\r\nline\ttwo\u0000 ', body: 'x'.repeat(1000), cancelLabel: 42 as never }), 1, NOW);
    expect(launch?.env.CAS_ALERT_TITLE).toBe('line one line two');
    expect(launch?.env.CAS_ALERT_BODY).toHaveLength(240);
    expect(launch?.env.CAS_ALERT_CANCEL).toBe('');
  });

  it('rounds the seconds DOWN - it may show less time than remains, never more - and caps them', () => {
    const rounded = buildAlertLaunch(ROOT, EXTENSION, options({ seconds: 19.8 }), 1, NOW);
    expect(argAfter(rounded?.args, '-Seconds')).toBe('19');
    expect(argAfter(rounded?.args, '-DeadlineUnixMs')).toBe(String(NOW + 19_000));
    const capped = buildAlertLaunch(ROOT, EXTENSION, options({ seconds: 1e9 }), 1, NOW);
    expect(argAfter(capped?.args, '-Seconds')).toBe('86400');
    expect(argAfter(capped?.args, '-DeadlineUnixMs')).toBe(String(NOW + 86_400_000));
  });

  it('refuses unusable options instead of guessing', () => {
    for (const seconds of [0, 0.9, -5, Number.NaN, Number.POSITIVE_INFINITY, '90', null, undefined] as unknown[]) {
      expect(buildAlertLaunch(ROOT, EXTENSION, options({ seconds: seconds as number }), 1, NOW), String(seconds)).toBeNull();
    }
    expect(buildAlertLaunch(ROOT, EXTENSION, options({ kind: 'urgent' as never }), 1, NOW)).toBeNull();
    for (const now of [0, -1, 1.5, Number.NaN]) {
      expect(buildAlertLaunch(ROOT, EXTENSION, options(), 1, now), String(now)).toBeNull();
    }
  });
});

describe('inertAlert', () => {
  it('accepts listeners and stop() without doing anything', () => {
    const alert = inertAlert();
    let cancels = 0;
    alert.onCancel(() => cancels++);
    alert.stop();
    alert.stop();
    expect(cancels).toBe(0);
  });
});
