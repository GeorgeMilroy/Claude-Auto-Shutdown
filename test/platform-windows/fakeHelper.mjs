// A stand-in for resources/win-helper.ps1 that speaks the same line protocol, for unit tests.
//
//   node fakeHelper.mjs <config.json> [the arguments the real helper would get]
//
// config = { log: <file>, spawns: [plan, plan, ...] }. The n-th start of the fake uses the n-th
// plan (the last one repeats). Everything it sees is appended to the log as JSON lines.
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const args = process.argv.slice(3);

const record = (entry) => fs.appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
const earlier = fs.existsSync(config.log)
  ? fs
      .readFileSync(config.log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"event":"spawn"')).length
  : 0;
const spawnNumber = earlier + 1;
const basePlan = config.spawns[Math.min(earlier, config.spawns.length - 1)] ?? {};
const noNative = args.includes('-NoNative');
const plan = noNative && basePlan.whenNoNative ? { ...basePlan, ...basePlan.whenNoNative } : basePlan;
record({ event: 'spawn', n: spawnNumber, args, pid: process.pid });

const eol = plan.crlf ? '\r\n' : '\n';
function write(text) {
  if (!plan.chunk) {
    process.stdout.write(text);
    return;
  }
  for (let at = 0; at < text.length; at += plan.chunk) process.stdout.write(text.slice(at, at + plan.chunk));
}
// Like the real helper: ASCII only, everything else as \uXXXX.
const ascii = (text) => text.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const send = (message) => write(ascii(JSON.stringify(message)) + eol);

if (plan.exitBeforeHello) {
  process.stderr.write(plan.exitBeforeHello.stderr ?? '');
  process.exitCode = plan.exitBeforeHello.code ?? 1;
} else {
  if (plan.banner) write(plan.banner + eol);
  if (plan.hello !== false) {
    const native = plan.native !== false;
    send({ id: 0, ok: true, hello: true, protocol: 2, tier: native ? 'native' : 'fallback-gp', native, nativeError: native ? null : 'Cannot add type.', languageMode: 'FullLanguage', psVersion: '5.1.0.0', pid: process.pid, ...plan.hello });
  }

  let held = false;
  function answer(request) {
    const reply = plan.replies?.[request.op];
    if (reply?.error) return { id: request.id, ok: false, error: reply.error };
    if (request.op === 'keepAwake' && reply === undefined) {
      if (plan.native === false) return { id: request.id, ok: false, error: 'keepAwake needs the native tier' };
      held = request.on === true;
      return { id: request.id, ok: true, held };
    }
    if (request.op === 'capability' && request.allowWhoami === true && plan.replies?.capabilityWithWhoami) {
      return { id: request.id, ok: true, ...plan.replies.capabilityWithWhoami };
    }
    return { id: request.id, ok: true, ...(reply ?? { echo: request }) };
  }

  let buffered = '';
  process.stdin.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === '') continue;
      const request = JSON.parse(line);
      record({ event: 'request', n: spawnNumber, raw: line, request });
      if (plan.dieOn === request.op) process.exit(7);
      if (plan.hangOn === request.op) continue;
      if (plan.floodOn === request.op) {
        // One endless "line": megabytes of output without a line break.
        const block = 'x'.repeat(1024 * 1024);
        for (let megabytes = 0; megabytes < 10; megabytes++) process.stdout.write(block);
        continue;
      }
      if (plan.garbageBeforeReply) write(`this is not json${eol}`);
      send(answer(request));
    }
  });
  process.stdin.on('end', () => {
    record({ event: 'stdin-end', n: spawnNumber });
    if (plan.onStdinEnd) {
      // Like PowerShell with a script it refuses to load: the complaint comes only now.
      process.stderr.write(plan.onStdinEnd.stderr ?? '', () => process.exit(plan.onStdinEnd.code ?? 1));
    } else if (!plan.ignoreStdinEnd) {
      process.exit(0);
    }
  });
  // Stay alive like the real helper does while its parent holds stdin open.
  setInterval(() => undefined, 1000);
}
