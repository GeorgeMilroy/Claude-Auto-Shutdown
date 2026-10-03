// Runs INSIDE the extension host of the throw-away VS Code instance started by launch.mjs.
// Drives the real extension (real helper process, real leader endpoint, real dashboard view)
// against the synthetic Claude directory and records each step in CAS_E2E_RESULT.
const fs = require('node:fs');
const vscode = require('vscode');

const EXTENSION_ID = 'MECoreLabs.claude-auto-shutdown';
const fixture = JSON.parse(process.env.CAS_E2E_FIXTURE || '{}');
const steps = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = `threw ${error && error.message}`;
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
}

async function step(name, body) {
  try {
    const detail = await body();
    steps.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' });
  } catch (error) {
    steps.push({ name, ok: false, detail: String((error && error.stack) || error) });
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function scenario() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert(extension, `extension ${EXTENSION_ID} is not installed in the test instance`);
  const exported = await extension.activate();
  const api = exported && exported.test;
  assert(api, 'the extension did not export its test API (ExtensionMode.Test only)');
  const state = () => api.getState();
  const unmet = () => (state()?.checks ?? []).filter((check) => check.state !== 'pass').map((check) => `${check.id}:${check.state}`);
  // The fake home has no registry entries for the developer's real Claude sessions, so every real
  // Claude process on this machine is an unmatched process here. One can start at any moment (a
  // new agent), and it rightly blocks; the scenario waives each one the way a user would. Their
  // busy commands are waited for on their own, even once the process itself is waived - and when
  // this run was launched from a Claude session, this very test instance is one of them - so each
  // of those is waived too.
  const waived = new Set();
  const waiveable = (stray) => [
    ...(stray.accounted || stray.ignored ? [] : [stray]),
    ...(Array.isArray(stray.children) ? stray.children.filter((child) => !child.ignored) : []),
  ];
  const waiveRealClaudeProcesses = async () => {
    for (const stray of state()?.strays ?? []) {
      for (const item of waiveable(stray)) {
        if (waived.has(item.ignoreKey)) continue;
        waived.add(item.ignoreKey);
        const result = await api.send({ name: 'ignore', key: item.ignoreKey, on: true });
        if (!result.ok) throw new Error(`ignore ${item.ignoreKey} rejected: ${result.error}`);
      }
    }
  };

  await step('becomes leader and starts not watching', async () => {
    await waitFor('role leader', () => api.getRole() === 'leader', 20_000);
    const s = await waitFor('first state', () => state(), 10_000);
    assert(s.armed === false && s.phase === 'off', `expected off, got ${s.phase} armed=${s.armed}`);
    return `platform ${s.platform.id}, helper ${s.platform.helperTier}`;
  });

  await step('opening the dashboard starts the engine and finds the synthetic session', async () => {
    await vscode.commands.executeCommand('claudeAutoShutdown.open');
    // The test window opens in the foreground. Enter / Space / Esc in the dashboard cancel a
    // countdown by design, so keep keyboard focus out of it: a key pressed on this machine during
    // the run must not decide the result. (Esc still reaches the global binding - via 'esc'.)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const s = await waitFor('a scan with the fixture session', () => {
      const current = state();
      return current && current.sessions.some((session) => session.sessionId === fixture.sessionId) ? current : null;
    }, 30_000);
    const session = s.sessions.find((candidate) => candidate.sessionId === fixture.sessionId);
    assert(session.pid === fixture.pid, `pid ${session.pid} != ${fixture.pid}`);
    assert(session.liveness === 'verified', `liveness ${session.liveness} (start time did not match procStart)`);
    assert(session.turn === 'CLOSED', `turn ${session.turn}/${session.turnReason}`);
    assert(session.status === 'finished', `status ${session.status}`);
    assert(s.platform.helperTier === 'full', `helper tier ${s.platform.helperTier}: ${s.platform.problem}`);
    return `${s.sessions.length} session(s); idle known: ${s.checks.length} checks`;
  });

  await step('every registered command exists', async () => {
    const all = await vscode.commands.getCommands(true);
    const contributed = extension.packageJSON.contributes.commands.map((command) => command.command);
    const missing = contributed.filter((id) => !all.includes(id));
    assert(missing.length === 0, `not registered: ${missing.join(', ')}`);
    return `${contributed.length} commands`;
  });

  await step('real Claude processes on this machine show up as strays and block until told otherwise', async () => {
    const s = state();
    const registry = s.checks.find((check) => check.id === 'registry');
    assert(registry, 'no registry check');
    assert(Array.isArray(s.strays), 'state.strays is not a list (process list unreadable?)');
    // The fake home has no registry entry for the developer's real Claude sessions, so each of
    // them is an unmatched Claude process here: exactly the situation the check exists for.
    const unaccounted = s.strays.filter((stray) => !stray.accounted && !stray.ignored);
    assert((registry.state === 'pass') === (unaccounted.length === 0), `registry is ${registry.state} with ${unaccounted.length} unaccounted stray(s)`);
    return `registry check: ${registry.state}, ${s.strays.length} stray Claude process(es)`;
  });

  await step('a test run starts watching without a modal', async () => {
    const view = api.getView();
    assert(view.plan.testMode === true, 'plan is not in test mode - refusing to continue');
    const result = await api.start();
    assert(result.ok, `arm rejected: ${result.error}`);
    const s = await waitFor('watching', () => (state()?.armed ? state() : null), 10_000);
    assert(s.contract.testMode === true, 'armed contract is not a test run');
    return `phase ${s.phase}; unmet: ${unmet().join(', ') || 'none'}`;
  });

  await step('unmatched Claude processes are ignored on request ("Don\'t wait for it")', async () => {
    await waiveRealClaudeProcesses();
    const s = await waitFor('registry check passes', () => {
      const registry = state()?.checks.find((check) => check.id === 'registry');
      return registry && registry.state === 'pass' ? state() : null;
    }, 20_000);
    return `${waived.size} stray process(es) and their busy commands ignored; registry ${s.checks.find((check) => check.id === 'registry').state}`;
  });

  await step('double-checking, then a test countdown starts', async () => {
    const s = await waitFor('countdown', async () => {
      await waiveRealClaudeProcesses();
      const current = state();
      if (current && !current.armed) throw new Error(`stopped watching: ${JSON.stringify(current.lastResult)}`);
      return current && current.phase === 'countdown' ? current : null;
    }, 60_000).catch((error) => {
      throw new Error(`${error.message}; unmet now: ${unmet().join(', ')}; errors: ${JSON.stringify(state()?.scan.errors)}`);
    });
    assert(s.countdown.kind === 'test', `countdown kind ${s.countdown.kind}`);
    assert(s.countdown.remainingMs <= 15_000, `remaining ${s.countdown.remainingMs}`);
    return `countdown ${Math.round(s.countdown.remainingMs / 1000)} s of ${s.countdown.totalMs / 1000} s`;
  });

  await step('cancelling the countdown keeps this PC on and stops watching', async () => {
    const result = await api.send({ name: 'cancel', via: 'command' });
    assert(result.ok, `cancel rejected: ${result.error}`);
    const s = await waitFor('cancelled', () => (state() && !state().countdown ? state() : null), 5_000);
    assert(s.armed === false, 'still watching after a user cancel');
    assert(s.lastResult && s.lastResult.kind === 'cancelled', `lastResult ${JSON.stringify(s.lastResult)}`);
    return JSON.stringify(s.lastResult.reason);
  });

  await step('second test run goes all the way: countdown, final check, "test run passed"', async () => {
    await api.send({ name: 'dismissResult' });
    const result = await api.start();
    assert(result.ok, `arm rejected: ${result.error}`);
    const s = await waitFor('test passed', async () => {
      await waiveRealClaudeProcesses();
      const current = state();
      return current && current.lastResult && current.lastResult.kind === 'testPassed' ? current : null;
    }, 150_000).catch((error) => {
      throw new Error(`${error.message}; phase ${state()?.phase}; unmet: ${unmet().join(', ')}; last: ${JSON.stringify(state()?.lastResult)}`);
    });
    assert(s.armed === false, 'still watching after the test run');
    assert(s.testPassedOnce === true, 'testPassedOnce not set');
    return `at ${new Date(s.lastResult.atMs).toISOString()}; real Claude processes and their commands waived so far: ${waived.size}`;
  });

  await step('a session that goes back to work blocks again', async () => {
    await api.send({ name: 'dismissResult' });
    fs.appendFileSync(fixture.transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'one more thing' } }) + '\n');
    await api.send({ name: 'refresh' });
    const s = await waitFor('session working', () => {
      const session = state()?.sessions.find((candidate) => candidate.sessionId === fixture.sessionId);
      return session && session.turn === 'OPEN' ? state() : null;
    }, 20_000);
    const idle = s.checks.find((check) => check.id === 'sessionsIdle');
    assert(idle && idle.state !== 'pass', `sessionsIdle is ${idle && idle.state}`);
    return `sessionsIdle: ${idle.state}`;
  });

  await step('Emergency stop file blocks arming', async () => {
    fs.writeFileSync(`${fixture.stateDir}\\STOP.txt`, '');
    const result = await api.start();
    assert(result.ok === false, 'arming succeeded although the STOP file exists');
    fs.unlinkSync(`${fixture.stateDir}\\STOP.txt`);
    return result.error;
  });

  await step('the activity log file exists and recorded the test run', async () => {
    const log = fs.readFileSync(state().logFile, 'utf8');
    assert(/test run/i.test(log), 'no "test run" line in the activity log');
    return `${log.split('\n').length} lines`;
  });
}

exports.run = async function run() {
  let failure = null;
  try {
    await scenario();
  } catch (error) {
    failure = error;
  }
  fs.writeFileSync(process.env.CAS_E2E_RESULT, JSON.stringify({ steps }, null, 2));
  if (failure) throw failure;
};
