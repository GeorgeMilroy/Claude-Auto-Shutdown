// The helper client against a FAKE helper (a small node script speaking the same line protocol).
// Nothing here starts PowerShell.

import { afterEach, describe, expect, it } from 'vitest';
import { asciiJson, buildHelperLaunch, WinHelper, type WinHelperOptions } from '../../src/platform/winHelper';
import { isAlive, makeFakeHelper, waitFor, waitUntilGone, type FakeHelper, type FakePlan } from './support';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(plans: FakePlan[], timings: Partial<WinHelperOptions> = {}) {
  const fake: FakeHelper = makeFakeHelper(plans);
  const logs: string[] = [];
  const helper = new WinHelper({
    launch: fake.launch,
    log: (message) => logs.push(message),
    helloTimeoutMs: 4000,
    requestTimeoutMs: 4000,
    stopGraceMs: 1500,
    restartBackoffMs: 60_000,
    ...timings,
  });
  cleanups.push(async () => {
    await helper.dispose();
    fake.cleanup();
  });
  return { fake, helper, logs };
}

describe('buildHelperLaunch', () => {
  const launch = buildHelperLaunch('C:\\Windows', 'C:\\Users\\me\\.vscode\\extensions\\cas', 4242);

  it('starts Windows PowerShell by absolute path with one fixed command line', () => {
    expect(launch.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(launch.cwd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(launch.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    expect(launch.args[5]).toMatch(/resources[\\/]win-helper\.ps1$/);
    expect(launch.args.slice(6)).toEqual(['-ParentPid', '4242', '-IdleExitSeconds', '120']);
  });

  it('never uses an encoded command, a hidden window style or an inline script', () => {
    const flags = launch.args.map((arg) => arg.toLowerCase());
    expect(flags.some((arg) => arg.startsWith('-enc') || arg.startsWith('-e ') || arg === '-e')).toBe(false);
    expect(flags.some((arg) => arg.startsWith('-w'))).toBe(false);
    expect(flags).not.toContain('-command');
    expect(flags).not.toContain('-c');
  });
});

describe('asciiJson', () => {
  it('escapes everything outside printable ASCII and still round-trips', () => {
    const value = { name: 'n\u00f6d\u00e9-\u65e5\u672c-\ud83d\ude00', tab: 'a\tb', del: '\u007f' };
    const line = asciiJson(value);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect(JSON.parse(line)).toEqual(value);
  });
});

describe('WinHelper against a fake helper', () => {
  it('starts lazily, greets and answers', async () => {
    const { fake, helper } = setup([{}]);
    expect(fake.spawns()).toHaveLength(0);
    expect(helper.status()).toEqual({ tier: 'full', problem: null });
    expect(helper.running).toBe(false);
    expect(helper.native).toBeNull();

    const reply = await helper.call('probe', { pids: [12, 16] });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.body.echo).toMatchObject({ op: 'probe', pids: [12, 16] });
    expect(reply.generation).toBe(1);
    expect(fake.spawns()).toHaveLength(1);
    expect(helper.running).toBe(true);
    expect(helper.native).toBe(true);
    expect(helper.pid).toBe(fake.spawns()[0]?.pid);
    expect(helper.status()).toEqual({ tier: 'full', problem: null });
  });

  it('reuses one process for many calls and numbers the requests', async () => {
    const { fake, helper } = setup([{}]);
    const replies = await Promise.all([helper.call('idle'), helper.call('snapshot', { pids: [] }), helper.call('probe', { pids: [4] })]);
    expect(replies.every((reply) => reply.ok)).toBe(true);
    expect(fake.spawns()).toHaveLength(1);
    const ids = fake.requests().map((request) => request.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => Number.isInteger(id) && (id as number) > 0)).toBe(true);
  });

  it('sends requests as pure ASCII', async () => {
    const { fake, helper } = setup([{}]);
    await helper.call('snapshot', { detailNames: ['n\u00f6d\u00e9', '\u65e5\u672c'] });
    const sent = fake.log().find((entry) => entry.event === 'request');
    expect(/^[\x20-\x7e]*$/.test(sent?.raw ?? '\u00ff')).toBe(true);
    expect(sent?.request?.detailNames).toEqual(['n\u00f6d\u00e9', '\u65e5\u672c']);
  });

  it('copes with CRLF line ends, output in small pieces and lines that are not JSON', async () => {
    const { helper } = setup([{ crlf: true, chunk: 3, banner: 'Windows PowerShell\r\nCopyright (C) Microsoft Corporation.', garbageBeforeReply: true }]);
    const reply = await helper.call('idle');
    expect(reply).toMatchObject({ ok: true });
    expect((await helper.call('probe', { pids: [8] })).ok).toBe(true);
  });

  it('returns the helper\u2019s own error without restarting it', async () => {
    const { fake, helper } = setup([{ replies: { probe: { error: 'pids required' } } }]);
    expect(await helper.call('probe')).toEqual({ ok: false, error: 'pids required' });
    expect(fake.spawns()).toHaveLength(1);
    expect(helper.running).toBe(true);
  });

  it('kills a helper that does not answer in time and counts the request as failed', async () => {
    const { fake, helper, logs } = setup([{ hangOn: 'snapshot' }, {}], { requestTimeoutMs: 300 });
    const reply = await helper.call('snapshot');
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toMatch(/did not answer/);
    const first = fake.spawns()[0]?.pid as number;
    expect(await waitUntilGone(first)).toBe(true);
    expect(fake.spawns()).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/did not answer "snapshot"/);

    // The next call gets a fresh helper.
    const next = await helper.call('snapshot');
    expect(next.ok).toBe(true);
    expect(fake.spawns()).toHaveLength(2);
    if (next.ok) expect(next.generation).toBe(2);
  });

  it('restarts a helper that died and retries the request once', async () => {
    const { fake, helper } = setup([{ dieOn: 'snapshot' }, {}]);
    const reply = await helper.call('snapshot', { pids: [4] });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.generation).toBe(2);
    expect(fake.spawns()).toHaveLength(2);
    expect(fake.requests('snapshot')).toHaveLength(2);
  });

  it('gives up after one retry when the helper keeps dying', async () => {
    const { fake, helper } = setup([{ dieOn: 'snapshot' }]);
    const reply = await helper.call('snapshot');
    expect(reply).toEqual({ ok: false, error: 'the helper stopped while answering' });
    expect(fake.spawns()).toHaveLength(2);
  });

  it('kills a helper that floods it with a line that never ends', async () => {
    const { fake, helper } = setup([{ floodOn: 'snapshot' }], { requestTimeoutMs: 8000 });
    const reply = await helper.call('snapshot');
    expect(reply.ok).toBe(false);
    const spawns = fake.spawns();
    expect(spawns).toHaveLength(2);
    for (const spawn of spawns) expect(await waitUntilGone(spawn.pid as number)).toBe(true);
  });

  it('restarts transparently after the helper exited by itself (idle exit)', async () => {
    const { fake, helper } = setup([{}]);
    expect((await helper.call('idle')).ok).toBe(true);
    const first = fake.spawns()[0]?.pid as number;
    process.kill(first);
    expect(await waitFor(() => !helper.running)).toBe(true);
    expect(helper.status().tier).toBe('full');
    expect((await helper.call('idle')).ok).toBe(true);
    expect(fake.spawns()).toHaveLength(2);
    expect(helper.generation).toBe(2);
  });

  it('reports the limited tier when the helper runs without native code', async () => {
    const { helper } = setup([{ native: false, hello: { nativeError: 'Cannot add type. Definition of new types is not supported in this language mode.' } }]);
    expect((await helper.call('idle')).ok).toBe(true);
    const status = helper.status();
    expect(status.tier).toBe('limited');
    expect(status.problem).toContain('Definition of new types is not supported');
    expect(status.problem).toMatch(/idle time, keep-awake and Sleep are unavailable/);
    expect(helper.native).toBe(false);
  });

  it('is unavailable when the execution policy refuses the script, without a second attempt', async () => {
    const stderr = 'File win-helper.ps1 cannot be loaded.\n    + FullyQualifiedErrorId : UnauthorizedAccess\n';
    const { fake, helper } = setup([{ exitBeforeHello: { code: 1, stderr } }]);
    const reply = await helper.call('snapshot');
    expect(reply.ok).toBe(false);
    expect(helper.status().tier).toBe('unavailable');
    expect(helper.status().problem).toMatch(/blocked by a script policy/);
    expect(fake.spawns()).toHaveLength(1);
    expect(fake.spawns()[0]?.args).not.toContain('-NoNative');
  });

  it('does not start PowerShell again and again while unavailable', async () => {
    const { fake, helper } = setup([{ exitBeforeHello: { code: 1, stderr: 'FullyQualifiedErrorId : UnauthorizedAccess' } }]);
    await helper.call('snapshot');
    await helper.call('snapshot');
    await helper.call('idle');
    expect(fake.spawns()).toHaveLength(1);
  });

  it('tries again once the back-off has passed', async () => {
    const { fake, helper } = setup([{ exitBeforeHello: { code: 1, stderr: 'FullyQualifiedErrorId : UnauthorizedAccess' } }, {}], { restartBackoffMs: 50 });
    expect((await helper.call('snapshot')).ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await helper.call('snapshot')).ok).toBe(true);
    expect(helper.status()).toEqual({ tier: 'full', problem: null });
    expect(fake.spawns()).toHaveLength(2);
  });

  it('recognises a script refused by policy, which PowerShell only reports once stdin is closed', async () => {
    const stderr = 'win-helper.ps1 cannot be loaded because running scripts is disabled on this system.\n    + FullyQualifiedErrorId : UnauthorizedAccess\n';
    const { fake, helper } = setup([{ hello: false, onStdinEnd: { code: 1, stderr } }], { helloTimeoutMs: 300 });
    const reply = await helper.call('snapshot');
    expect(reply.ok).toBe(false);
    expect(helper.status().tier).toBe('unavailable');
    expect(helper.status().problem).toMatch(/blocked by a script policy/);
    // Starting it again without native code would be refused just the same.
    expect(fake.spawns()).toHaveLength(1);
    expect(fake.log().some((entry) => entry.event === 'stdin-end')).toBe(true);
    expect(await waitUntilGone(fake.spawns()[0]?.pid as number)).toBe(true);
  });

  it('reports what a helper said when it ended without a greeting', async () => {
    const { helper } = setup([{ hello: false, onStdinEnd: { code: 3, stderr: 'This script is blocked by your administrator.\n' } }], { helloTimeoutMs: 300 });
    expect((await helper.call('snapshot')).ok).toBe(false);
    expect(helper.status().tier).toBe('unavailable');
    expect(helper.status().problem).toContain('PowerShell ended with code 3 (This script is blocked by your administrator.)');
  });

  it('falls back to -NoNative when the native start hangs, and stays there', async () => {
    // A helper stuck in its native start-up does not react to a closed stdin either.
    const stuck = { hello: false as const, ignoreStdinEnd: true, whenNoNative: { hello: {}, native: false, ignoreStdinEnd: false } };
    const { fake, helper } = setup([stuck], { helloTimeoutMs: 400, stopGraceMs: 300 });
    const reply = await helper.call('idle');
    expect(reply.ok).toBe(true);
    expect(helper.status().tier).toBe('limited');
    expect(helper.status().problem).toContain('PowerShell did not answer in time');
    const spawns = fake.spawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.args).not.toContain('-NoNative');
    expect(spawns[1]?.args).toContain('-NoNative');
    expect(await waitUntilGone(spawns[0]?.pid as number)).toBe(true);

    // A later restart does not wait for the native start to time out again.
    process.kill(spawns[1]?.pid as number);
    expect(await waitFor(() => !helper.running)).toBe(true);
    expect((await helper.call('idle')).ok).toBe(true);
    expect(fake.spawns()).toHaveLength(3);
    expect(fake.spawns()[2]?.args).toContain('-NoNative');
  });

  it('is unavailable when neither start greets, and leaves no process behind', async () => {
    const { fake, helper, logs } = setup([{ hello: false }], { helloTimeoutMs: 300 });
    const reply = await helper.call('snapshot');
    expect(reply.ok).toBe(false);
    const status = helper.status();
    expect(status.tier).toBe('unavailable');
    expect(status.problem).toMatch(/could not be started: PowerShell did not answer in time/);
    const spawns = fake.spawns();
    expect(spawns).toHaveLength(2);
    for (const spawn of spawns) expect(await waitUntilGone(spawn.pid as number)).toBe(true);
    expect(logs.join('\n')).toMatch(/Trying again in/);
  });

  it('rejects a helper that speaks another protocol version', async () => {
    const { fake, helper } = setup([{ hello: { protocol: 1 } }]);
    expect((await helper.call('idle')).ok).toBe(false);
    expect(helper.status().tier).toBe('unavailable');
    expect(helper.status().problem).toMatch(/protocol 1, expected 2/);
    expect(fake.spawns()).toHaveLength(1);
    expect(await waitUntilGone(fake.spawns()[0]?.pid as number)).toBe(true);
  });

  it('rejects an incomplete greeting', async () => {
    const { helper } = setup([{ hello: { pid: 'x' } }]);
    expect((await helper.call('idle')).ok).toBe(false);
    expect(helper.status().tier).toBe('unavailable');
  });

  it('is unavailable from the start when there is nothing to launch', async () => {
    const helper = new WinHelper({ launch: null, launchProblem: 'PowerShell is missing.', log: () => undefined });
    expect(helper.status()).toEqual({ tier: 'unavailable', problem: 'PowerShell is missing.' });
    expect(await helper.call('snapshot')).toEqual({ ok: false, error: 'PowerShell is missing.' });
  });

  it('is unavailable when the program to launch does not exist', async () => {
    const fake = makeFakeHelper([{}]);
    cleanups.push(() => fake.cleanup());
    const helper = new WinHelper({ launch: { file: `${fake.launch.cwd}/no-such-program.exe`, args: [], cwd: fake.launch.cwd }, log: () => undefined, helloTimeoutMs: 2000 });
    expect((await helper.call('snapshot')).ok).toBe(false);
    expect(helper.status().tier).toBe('unavailable');
  });

  it('stops the helper by closing its stdin', async () => {
    const { fake, helper } = setup([{}]);
    await helper.call('idle');
    const pid = fake.spawns()[0]?.pid as number;
    expect(isAlive(pid)).toBe(true);
    await helper.dispose();
    expect(isAlive(pid)).toBe(false);
    expect(fake.log().some((entry) => entry.event === 'stdin-end')).toBe(true);
    expect(helper.running).toBe(false);
  });

  it('kills a helper that ignores the closed stdin', async () => {
    const { fake, helper } = setup([{ ignoreStdinEnd: true }], { stopGraceMs: 300 });
    await helper.call('idle');
    const pid = fake.spawns()[0]?.pid as number;
    await helper.dispose();
    expect(await waitUntilGone(pid, 2000)).toBe(true);
  });

  it('answers nothing and starts nothing after dispose', async () => {
    const { fake, helper } = setup([{}]);
    await helper.call('idle');
    await helper.dispose();
    expect(await helper.call('idle')).toEqual({ ok: false, error: 'the helper has been stopped' });
    expect(fake.spawns()).toHaveLength(1);
    await helper.dispose();
  });

  it('can be disposed while it is still starting', async () => {
    const { fake, helper } = setup([{ hello: false }], { helloTimeoutMs: 5000 });
    const pending = helper.call('idle');
    expect(await waitFor(() => fake.spawns().length === 1)).toBe(true);
    await helper.dispose();
    expect((await pending).ok).toBe(false);
    expect(await waitUntilGone(fake.spawns()[0]?.pid as number)).toBe(true);
    expect(fake.spawns()).toHaveLength(1);
  });
});
