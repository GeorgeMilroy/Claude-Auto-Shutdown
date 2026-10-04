// End-to-end run in a real VS Code extension host, against a SYNTHETIC Claude directory.
//
//   node test/e2e/launch.mjs
//
// It never touches the real ~/.claude and can never run a power action: the instance is started
// with CLAUDE_AUTOSHUTDOWN_TEST_HOME (fake home), CLAUDE_AUTOSHUTDOWN_NO_POWER=1 and test mode on.
// Build first (npm run build). Windows only for now: the fixture needs the process start FILETIME.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.platform !== 'win32') {
  console.error('The e2e launcher currently supports Windows only.');
  process.exit(2);
}

const codeExe =
  process.env.VSCODE_EXE ||
  ['C:\\Program Files\\Microsoft VS Code\\Code.exe', join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')].find(
    (candidate) => existsSync(candidate),
  );
if (!codeExe) {
  console.error('Code.exe not found. Set VSCODE_EXE.');
  process.exit(2);
}
if (!existsSync(join(root, 'dist', 'extension.js'))) {
  console.error('dist/extension.js is missing. Run `npm run build` first.');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'cas-e2e-'));
const home = join(work, 'home');
const claude = join(home, '.claude');
const stateDir = join(work, 'state');
const userData = join(work, 'user-data');
const workspace = join(work, 'workspace');
const resultFile = join(work, 'result.json');
for (const dir of [join(claude, 'sessions'), join(claude, 'projects', 'e2e-project'), stateDir, join(userData, 'User'), join(work, 'extensions'), workspace]) {
  mkdirSync(dir, { recursive: true });
}

// A live process that plays "the Claude session": the registry entry must point at a real PID
// whose start time matches procStart, exactly like a real session.
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15 * 60 * 1000)'], { stdio: 'ignore', windowsHide: true });
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const procStart = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${sleeper.pid}).StartTime.ToFileTimeUtc()`], {
  encoding: 'utf8',
}).trim();

const sessionId = '11111111-2222-4333-8444-555555555555';
const transcript = join(claude, 'projects', 'e2e-project', `${sessionId}.jsonl`);
const record = (value) => JSON.stringify(value) + '\n';
const stamp = (offsetSeconds) => new Date(Date.now() - offsetSeconds * 1000).toISOString();
writeFileSync(
  transcript,
  record({ type: 'user', timestamp: stamp(120), message: { role: 'user', content: 'run the tests' } }) +
    record({ type: 'assistant', timestamp: stamp(118), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }) +
    record({ type: 'user', timestamp: stamp(100), message: { role: 'user', content: [{ type: 'tool_result', content: 'all tests passed' }] } }) +
    record({ type: 'assistant', timestamp: stamp(95), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All tests pass.' }] } }),
);
const quietSince = new Date(Date.now() - 95_000);
utimesSync(transcript, quietSince, quietSince);
// Claude Code's own status, as it writes it: idle since the turn ended.
const registry = join(claude, 'sessions', `${sleeper.pid}.json`);
writeFileSync(
  registry,
  JSON.stringify({
    pid: sleeper.pid,
    sessionId,
    cwd: workspace,
    name: 'e2e-session',
    entrypoint: 'cli',
    kind: 'interactive',
    startedAt: Date.now() - 130_000,
    procStart,
    status: 'idle',
    statusUpdatedAt: quietSince.getTime(),
    updatedAt: quietSince.getTime(),
  }),
);

// The shortest rules the settings allow, test mode on, nothing that pops up or makes noise.
writeFileSync(
  join(userData, 'User', 'settings.json'),
  JSON.stringify(
    {
      'claudeAutoShutdown.action': 'shutdown',
      'claudeAutoShutdown.testMode': true,
      'claudeAutoShutdown.quietSeconds': 30,
      'claudeAutoShutdown.pollSeconds': 5,
      'claudeAutoShutdown.requiredPolls': 2,
      'claudeAutoShutdown.countdownSeconds': 15,
      'claudeAutoShutdown.requireUserIdle': false,
      'claudeAutoShutdown.keepAwake': false,
      'claudeAutoShutdown.countdownAlert': false,
      'claudeAutoShutdown.countdownSound': false,
      'claudeAutoShutdown.scanWsl': false,
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
    },
    null,
    2,
  ),
);

// The editor that launched us may leak its own wiring into the child; the new instance must be
// a clean, separate editor.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_') || key === 'CLAUDE_CONFIG_DIR') delete env[key];
}
Object.assign(env, {
  CLAUDE_AUTOSHUTDOWN_NO_POWER: '1',
  CLAUDE_AUTOSHUTDOWN_TEST_HOME: home,
  CLAUDE_AUTOSHUTDOWN_HOME: stateDir,
  CLAUDE_AUTOSHUTDOWN_ENDPOINT: `\\\\.\\pipe\\cas-e2e-${randomBytes(6).toString('hex')}`,
  CAS_E2E_RESULT: resultFile,
  CAS_E2E_FIXTURE: JSON.stringify({ transcript, registry, sessionId, pid: sleeper.pid, stateDir }),
});

const args = [
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${join(root, 'test', 'e2e', 'suite.cjs')}`,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${join(work, 'extensions')}`,
  '--disable-workspace-trust',
  '--disable-updates',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-gpu',
  workspace,
];

console.log(`e2e work dir: ${work}`);
const started = Date.now();

// VS Code is started through a short-lived intermediate process, so it is NOT a descendant of
// whatever runs this script. When that is a Claude Code session (an agent running the tests), the
// session is an unmatched Claude process in the fake home, and every busy process the test
// instance starts (its extension host, the helper) would count as that session's still-running
// command and cancel the countdown - correct behaviour, wrong test.
const intermediate = spawn(
  process.execPath,
  [
    '-e',
    "const c = require('node:child_process').spawn(process.env.CAS_E2E_CODE, JSON.parse(process.env.CAS_E2E_ARGS), { detached: true, stdio: 'ignore', windowsHide: false }); c.unref(); process.stdout.write(String(c.pid));",
  ],
  { env: { ...env, CAS_E2E_CODE: codeExe, CAS_E2E_ARGS: JSON.stringify(args) }, stdio: ['ignore', 'pipe', 'inherit'] },
);
let codePidText = '';
intermediate.stdout.on('data', (chunk) => (codePidText += chunk));
await new Promise((resolve) => intermediate.on('exit', resolve));
const codePid = Number(codePidText);
if (!Number.isInteger(codePid) || codePid <= 0) {
  console.error('Could not start VS Code.');
  sleeper.kill();
  process.exit(1);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
const deadline = started + 5 * 60 * 1000;
while (alive(codePid)) {
  if (Date.now() > deadline) {
    console.error('e2e timed out after 5 minutes; killing the test instance');
    execFileSync(taskkill, ['/pid', String(codePid), '/t', '/f'], { stdio: 'ignore' });
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

sleeper.kill();
let results = null;
try {
  results = JSON.parse(readFileSync(resultFile, 'utf8'));
} catch {
  // no result file: the suite never ran or crashed before writing
}
console.log(`VS Code exited after ${Math.round((Date.now() - started) / 1000)} s`);
if (!results) {
  console.error('No result file was written.');
  process.exit(1);
}
for (const step of results.steps) {
  console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.detail ? `  - ${step.detail}` : ''}`);
}
const failed = results.steps.filter((step) => !step.ok).length;
console.log(`${results.steps.length - failed} passed, ${failed} failed`);
if (process.env.CAS_E2E_KEEP !== '1') {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // files may still be locked for a moment; the temp dir is harmless
  }
}
process.exit(failed === 0 ? 0 : 1);
