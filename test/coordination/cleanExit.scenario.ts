// Runs as its own Node process (bundled and started by cleanExit.test.ts), because "dispose()
// leaves nothing behind" can only be proven by a process that then ends by itself.
//
// It puts coordinators into every state that owns a timer or a handle - leading with followers,
// following, waiting for a welcome, isolated and retrying, holding a handover, waiting to
// re-elect, with unanswered commands - disposes them all, and reports what is still alive.

import { retry, type EndpointClaimer } from '../../src/coordination/endpoint';
import type { CommandResult } from '../../src/shared/protocol';
import { armedState, makeHandover, Rig, sleep, waitFor } from './harness';

const never = (): Promise<CommandResult> => new Promise(() => undefined);
const blocked: EndpointClaimer = { attempt: () => Promise.resolve(retry('blocked by the scenario')) };

function aliveResources(): string[] {
  return process.getActiveResourcesInfo().sort();
}

/** What is alive now that was not alive at the start. */
function leftover(baseline: string[]): string[] {
  const remaining = [...baseline];
  return aliveResources().filter((resource) => {
    const index = remaining.indexOf(resource);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

async function main(): Promise<void> {
  // stdout and stderr are created on first use; create them now so they are part of the baseline.
  process.stdout.write('');
  process.stderr.write('');
  const baseline = aliveResources();
  const rig = new Rig();
  const elsewhere = new Rig();
  const third = new Rig();

  const leader = await rig.join('leader');
  leader.state = armedState();
  leader.handover = makeHandover();
  leader.respond = never;
  const stopping = await rig.join('stopping');
  const successor = await rig.join('successor');
  const bystander = await rig.join('bystander');

  // Unanswered commands: a 2 s "stuck" timer and a 20 s answer timer.
  stopping.coordinator.setViewVisible(true);
  void stopping.coordinator.send({ name: 'disarm' });
  void stopping.coordinator.send({ name: 'refresh' });
  await waitFor('the leader got both commands', () => leader.commands.length === 2);

  // Waiting for a welcome that never comes (2 s timer).
  const silent = await elsewhere.rawLeader();
  const unwelcome = elsewhere.window('unwelcome').start();
  await silent.accepted(1);

  // Isolated, retrying every 5 s.
  const isolated = rig.window('isolated', { claimer: blocked, random: () => 0 }).start();
  await waitFor('one window is isolated', () => isolated.role === 'isolated');

  // Holding a handover from a leader that never lets go (3 s timer).
  const clinging = await third.rawLeader();
  const holder = third.window('holder').start();
  await clinging.accepted(1);
  clinging.welcome(clinging.latest, armedState());
  await waitFor('the holder is welcomed', () => holder.role === 'follower');
  clinging.send(clinging.latest, { t: 'handover', payload: makeHandover() });
  await waitFor('the holder accepted', () => clinging.latest.received.some((message) => message.t === 'handoverAck'));

  // The leader leaves: "successor" takes over, the two others wait 500-700 ms before they
  // re-elect. Everything is disposed in the middle of that.
  const handedOver = await leader.coordinator.dispose();
  await waitFor('the successor leads', () => successor.role === 'leader');

  // A connection to the new leader that has not said hello yet (2 s timer on the leader's side).
  await rig.rawConnection();
  await sleep(20);
  const windows = [stopping, successor, bystander, unwelcome, isolated, holder];
  const rolesAtDispose = windows.map((window) => window.role);
  await Promise.all([rig.dispose(), elsewhere.dispose(), third.dispose()]);
  await sleep(100);

  const report = { handedOver, rolesAtDispose, leftover: leftover(baseline) };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
