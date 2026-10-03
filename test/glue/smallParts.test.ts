// The small pure parts of the glue: Markdown escaping, remote labels and realms, the activity
// mirror, the start flow's decisions, and "what happened last time".

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contractDigest } from '../../src/shared/config';
import type { ActivityEntry, UiState } from '../../src/shared/protocol';
import { StateDir } from '../../src/shared/stateDir';
import { ActivityMirror, activityLine } from '../../src/ui/activityMirror';
import { lastRunReport, readLastRun } from '../../src/ui/lastRun';
import { commandLink, escapeMarkdown } from '../../src/ui/markdown';
import { realmOf, remoteLabel } from '../../src/ui/remote';
import { leaderHasPlan, needsConfirmation, startChoices, startRefusal, unseenRemotes } from '../../src/ui/startPlan';
import { REALM, contract, snapshot, testPassed, uiState, watching } from './fixtures';

describe('escapeMarkdown', () => {
  it('leaves nothing that Markdown would read as formatting, a link, HTML or code', () => {
    const escaped = escapeMarkdown('[a](command:x) **b** _c_ `d` <e> # f ![g](h) ~~i~~ | j');
    expect(escaped).not.toMatch(/(^|[^\\])[[\]()*_`<>#!~|]/);
  });

  it('keeps letters, digits, spaces and non-ASCII text as they are', () => {
    expect(escapeMarkdown('Quiet 0 18 of 5 00 · żółć 東京')).toBe('Quiet 0 18 of 5 00 · żółć 東京');
  });

  it('makes one line out of anything', () => {
    expect(escapeMarkdown('  first\n\n    second\tthird  ')).toBe('first second third');
  });

  it('escapes the backslash itself, so an escape cannot be undone', () => {
    expect(escapeMarkdown('\\[x]')).toBe('\\\\\\[x\\]');
  });

  it('builds a command link with an escaped label', () => {
    expect(commandLink('Stop watching', 'claudeAutoShutdown.stop')).toBe('[Stop watching](command:claudeAutoShutdown.stop)');
    expect(commandLink('a](command:evil)[b', 'claudeAutoShutdown.open')).toBe('[a\\]\\(command\\:evil\\)\\[b](command:claudeAutoShutdown.open)');
  });
});

describe('remoteLabel', () => {
  it('is null for a local window', () => {
    expect(remoteLabel(undefined, undefined)).toBeNull();
    expect(remoteLabel('', 'wsl+Ubuntu')).toBeNull();
  });

  it('names a WSL distro the way the scanner labels its Claude folder', () => {
    expect(remoteLabel('wsl', 'wsl+Ubuntu')).toBe('WSL: Ubuntu');
    expect(remoteLabel('wsl', 'wsl+Ubuntu-22.04')).toBe('WSL: Ubuntu-22.04');
    expect(remoteLabel('wsl', 'wsl%2BUbuntu')).toBe('WSL: Ubuntu');
    expect(remoteLabel('wsl', undefined)).toBe('WSL');
    expect(remoteLabel('wsl', 'wsl')).toBe('WSL');
  });

  it('names an SSH host, also when the authority is hex-encoded JSON', () => {
    expect(remoteLabel('ssh-remote', 'ssh-remote+build-box')).toBe('SSH: build-box');
    const encoded = Buffer.from(JSON.stringify({ hostName: 'build-box', user: 'me' }), 'utf8').toString('hex');
    expect(remoteLabel('ssh-remote', `ssh-remote+${encoded}`)).toBe('SSH: build-box');
  });

  it('names containers, Codespaces and tunnels without their ids', () => {
    expect(remoteLabel('dev-container', 'dev-container+7b2273657474696e67223a747275657d')).toBe('Dev Container');
    expect(remoteLabel('attached-container', 'attached-container+abc')).toBe('Dev Container');
    expect(remoteLabel('codespaces', 'codespaces+fuzzy-space-waffle')).toBe('Codespaces');
    expect(remoteLabel('tunnel', 'tunnel+office-pc')).toBe('Tunnel: office-pc');
  });

  it('still says "remote" for a kind it has never heard of', () => {
    expect(remoteLabel('k8s-pod', 'k8s-pod+x')).toBe('Remote: k8s-pod');
  });

  it('keeps a label short and on one line', () => {
    const label = remoteLabel('ssh-remote', `ssh-remote+host\n${'x'.repeat(200)}`) ?? '';
    expect(label).not.toContain('\n');
    expect(label.length).toBeLessThanOrEqual('SSH: '.length + 60);
  });
});

describe('realmOf', () => {
  const storage = 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\mecorelabs.claude-auto-shutdown';

  it('is the first 16 hex digits of the SHA-256 of the settings location', () => {
    expect(realmOf(storage)).toBe(createHash('sha256').update(storage).digest('hex').slice(0, 16));
  });

  it('is the same for every window of one editor, and differs between editors', () => {
    expect(realmOf(storage)).toBe(realmOf(storage));
    expect(realmOf(storage.replace('Code', 'Cursor'))).not.toBe(realmOf(storage));
  });
});

describe('ActivityMirror', () => {
  const entry = (atMs: number, text: string, level: ActivityEntry['level'] = 'info'): ActivityEntry => ({ atMs, level, text });

  it('passes each entry on once, in order, however often the state repeats it', () => {
    const mirror = new ActivityMirror();
    const first = [entry(1, 'Started watching.'), entry(2, 'Still on.')];
    expect(mirror.take(first)).toEqual(first);
    expect(mirror.take(first)).toEqual([]);
    expect(mirror.take([...first, entry(3, 'Everything is clear.')])).toEqual([entry(3, 'Everything is clear.')]);
  });

  it('tells two entries with the same text apart by their time', () => {
    const mirror = new ActivityMirror();
    expect(mirror.take([entry(1, 'Still on.')])).toHaveLength(1);
    expect(mirror.take([entry(1, 'Still on.'), entry(9, 'Still on.')])).toEqual([entry(9, 'Still on.')]);
  });

  it('skips what is not an entry, and reads an unknown level as info', () => {
    const mirror = new ActivityMirror();
    const odd = [null, 'text', { atMs: 'now', text: 'x' }, { atMs: 5, text: '' }, { atMs: 6, level: 'fatal', text: 'kept' }];
    expect(mirror.take(odd)).toEqual([entry(6, 'kept')]);
    expect(mirror.take(undefined)).toEqual([]);
    expect(mirror.take({ length: 3 })).toEqual([]);
  });

  it('forgets the oldest entries instead of growing for ever', () => {
    const mirror = new ActivityMirror();
    const many = Array.from({ length: 1000 }, (_unused, index) => entry(index, `line ${index}`));
    expect(mirror.take(many)).toHaveLength(1000);
    expect(mirror.take(many.slice(-40))).toEqual([]);
    // Long gone from memory, so it counts as new again.
    expect(mirror.take([entry(0, 'line 0')])).toHaveLength(1);
  });

  it('prints the entry\'s own time when it is backlog, because the channel stamps "now"', () => {
    const at = new Date(2026, 0, 15, 2, 13, 5).getTime();
    expect(activityLine(entry(at, 'Countdown cancelled.'), at + 1_000)).toBe('Countdown cancelled.');
    expect(activityLine(entry(at, 'Countdown cancelled.'), at + 3_600_000)).toBe('(02:13:05) Countdown cancelled.');
  });
});

describe('start flow decisions', () => {
  it('can be tried from a connected window that shows "not watching"', () => {
    expect(startRefusal(snapshot(uiState()))).toBeNull();
    expect(startRefusal(snapshot(uiState(), { role: 'follower' }))).toBeNull();
  });

  it('is refused, in words, whenever this window cannot know what it would start', () => {
    expect(startRefusal(snapshot(null, { role: 'isolated' }))).toContain("Can't reach the other VS Code windows");
    expect(startRefusal(snapshot(null, { role: 'electing' }))).toContain("isn't answering yet");
    expect(startRefusal(snapshot(watching()))).toBe('Already watching.');
    expect(startRefusal(snapshot(uiState(), { role: 'follower', limited: true }))).toContain('Only Cancel and Stop watching work');
    expect(startRefusal(snapshot({ ...uiState(), epoch: undefined } as unknown as UiState))).not.toBeNull();
    // A state that does not say "not watching" may be watching.
    expect(startRefusal(snapshot({ ...uiState(), armed: undefined } as unknown as UiState))).toBe('Already watching.');
  });

  it('confirms every plan that does something to this PC', () => {
    expect(needsConfirmation(contract({ testMode: false, action: 'shutdown' }))).toBe(true);
    expect(needsConfirmation(contract({ testMode: false, action: 'lock' }))).toBe(true);
    expect(needsConfirmation(contract({ testMode: true, action: 'shutdown' }))).toBe(false);
    expect(needsConfirmation(contract({ testMode: false, action: 'notify' }))).toBe(false);
    // Only an explicit `true` is a test run.
    expect(needsConfirmation({ ...contract(), testMode: 'true' as unknown as boolean })).toBe(true);
  });

  it('names the remote windows the leader cannot see into', () => {
    const state = uiState({
      remoteWindows: [
        { name: 'WSL: Ubuntu', ignoreKey: 'remote:WSL: Ubuntu', ignored: false, covered: true },
        { name: 'SSH: build-box', ignoreKey: 'remote:SSH: build-box', ignored: true, covered: false },
      ],
    });
    expect(unseenRemotes(state)).toEqual(['SSH: build-box']);
    expect(unseenRemotes({ ...uiState(), remoteWindows: null } as unknown as UiState)).toEqual([]);
  });

  it('waits for a leader that reads the same settings to show the plan about to be sent', () => {
    const plan = contract({ quietSeconds: 60 });
    const digest = contractDigest(plan);
    expect(leaderHasPlan(uiState(), REALM, digest)).toBe(false);
    expect(leaderHasPlan(uiState({ contract: plan }), REALM, digest)).toBe(true);
    // Another editor's leader has other settings; a watching or unknown leader will answer for itself.
    expect(leaderHasPlan(uiState({ contractRealm: 'another-editor' }), REALM, digest)).toBe(true);
    expect(leaderHasPlan(watching(), REALM, digest)).toBe(true);
    expect(leaderHasPlan(null, REALM, digest)).toBe(true);
  });

  it('offers test run, for real and just-notify for the configured action', () => {
    const choices = startChoices('hibernate');
    expect(choices.map((choice) => choice.label)).toEqual(['Test run: PC stays on', 'For real: Hibernate…', 'Just notify me']);
    expect(choices.map((choice) => choice.change)).toEqual([{ testMode: true }, { testMode: false }, { action: 'notify' }]);
  });

  it('offers no test run or real run while the action is "just notify me"', () => {
    const choices = startChoices('notify');
    expect(choices.map((choice) => choice.change)).toEqual([{ action: 'notify' }, null]);
  });
});

describe('what happened last time', () => {
  let dir: string;
  let stateDir: StateDir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
    stateDir = new StateDir(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has nothing to tell before anything happened', () => {
    expect(readLastRun(stateDir)).toBeNull();
  });

  it('reads the stored result, also one that was dismissed', () => {
    const result = testPassed(new Date(2026, 0, 15, 2, 14).getTime());
    stateDir.writeJson(stateDir.lastRunFile, { testPassedOnce: true, lastResult: result, dismissed: true });
    expect(readLastRun(stateDir)).toEqual(result);
  });

  it('reads a damaged record as "nothing"', () => {
    fs.writeFileSync(stateDir.lastRunFile, '{"lastResult": {"kind": "testPassed"');
    expect(readLastRun(stateDir)).toBeNull();
    stateDir.writeJson(stateDir.lastRunFile, { lastResult: { kind: 'done', atMs: 'yesterday', action: 'shutdown' } });
    expect(readLastRun(stateDir)).toBeNull();
    stateDir.writeJson(stateDir.lastRunFile, ['not', 'a', 'record']);
    expect(readLastRun(stateDir)).toBeNull();
  });

  it('reports the result in one sentence, with the details and the day', () => {
    const at = new Date(2026, 0, 15, 2, 14).getTime();
    const report = lastRunReport(testPassed(at), 'Windows');
    expect(report.message).toContain('Test run passed');
    expect(report.detail).toContain('Nothing was turned off');
    expect(report.detail).toMatch(/\nRecorded on .+\.$/);
  });
});
