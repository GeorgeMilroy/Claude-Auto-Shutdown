// Property-style test of "not knowing is never permission".
//
// Start from inputs for which the verdict is ok. Replace one node at a time - every field, every
// list, every nested object - with values a literal port of the Python engine would wave through
// (`NaN < 300` is false, "false" is truthy, `3 >= null` is true), and require that the verdict is
// no longer ok. The only substitutions allowed to stay ok are listed below with the reason, and
// those MUST stay ok, so the list cannot quietly grow stale or hide an over-eager block.

import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/core/evaluate';
import type { EvaluateInput } from '../../src/core/evaluate';
import type { Verdict } from '../../src/core/types';
import { INT_BOUNDS } from '../../src/shared/config';
import {
  CHECK_ORDER,
  child,
  contract,
  illTyped,
  input,
  remoteWindow,
  scan,
  session,
  stray,
  subagent,
  workingSession,
} from './fixtures';

// --- the passing inputs ------------------------------------------------------------------------

/** Every optional check on, and every waiver flag carrying weight. */
const everyGate = { guardProcesses: ['ffmpeg'], extraClaudeDirs: ['D:\\fixture\\other\\.claude'] };
const remoteWindows = [
  remoteWindow({ name: 'WSL: Ubuntu', covered: true }),
  remoteWindow({ name: 'SSH: build-box', ignored: true }),
];
/** The waived one still has its children judged: one idle, one waived. */
const strays = [
  stray({ pid: 9001, accounted: true }),
  stray({ pid: 9002, ignored: true, children: [child({ pid: 7101, busy: false }), child({ pid: 7102, ignored: true })] }),
];

interface Base {
  name: string;
  input: EvaluateInput;
  /** Paths whose value no check judges IN THIS INPUT, beyond the ones no check ever judges. */
  notJudgedHere: RegExp[];
}

const BASES: Base[] = [
  {
    name: 'a finished session next to a waived working one',
    input: input({
      contract: contract(everyGate),
      remoteWindows,
      scan: scan({
        strays,
        sessions: [
          session({
            subagents: [subagent()],
            children: [child({ busy: false }), child({ pid: 7002, name: 'cargo', ignored: true })],
          }),
          workingSession({ ignored: true, children: [child({ pid: 7003 })] }),
        ],
      }),
    }),
    notJudgedHere: [
      // The finished session is judged whether or not the flag reads as "ignored", and `status`
      // only words a block that is not there.
      /^scan\.sessions\.0\.(ignored|status)$/,
      // Its first child is not busy; its second one is waived.
      /^scan\.sessions\.0\.children\.0\.ignored$/,
      /^scan\.sessions\.0\.children\.1\.busy$/,
      // Nothing about a waived session is judged - except that it really is waived.
      /^scan\.sessions\.1\.(?!ignored$)[\w.]+$/,
      // The zero-session rule is not consulted while there are sessions.
      /^(sawAnySession|secondsSinceLastSession)$/,
      /^contract\.allowWhenNoSessions$/,
    ],
  },
  {
    name: 'no sessions, the last one ended long enough ago',
    input: input({
      contract: contract(everyGate),
      remoteWindows,
      scan: scan({ strays, sessions: [] }),
      sawAnySession: true,
      secondsSinceLastSession: 900,
    }),
    notJudgedHere: [],
  },
  {
    name: 'no sessions ever, allowed by the contract',
    input: input({
      contract: contract({ ...everyGate, allowWhenNoSessions: true }),
      remoteWindows,
      scan: scan({ strays, sessions: [] }),
      sawAnySession: false,
      secondsSinceLastSession: null,
    }),
    notJudgedHere: [
      // allowWhenNoSessions passes without asking when a session was seen, and with no session
      // there is nothing to compare with the quiet target.
      /^(sawAnySession|secondsSinceLastSession)$/,
      /^contract\.quietSeconds$/,
    ],
  },
];

/** Fields no check judges in any input. */
const NEVER_JUDGED: RegExp[] = [
  // Contract fields for the controller and the scanner.
  /^contract\.(testMode|pollSeconds|countdownSeconds|forceCloseApps|scanWsl|waitForAnswers)$/,
  /^contract\.extraClaudeDirs(\.\d+)?$/,
  // Only the NUMBER of keep-on patterns matters here; matching them is the scanner's job.
  /^contract\.guardProcesses\.\d+$/,
  // Shown, never judged.
  /^capability\.detail$/,
  /^remoteWindows\.\d+\.(name|ignoreKey)$/,
  /^scan\.(startedAtMs|completedAtMs|helperProblem)$/,
  /^scan\.roots\.\d+(\.\w+)?$/,
  /^scan\.strays\.\d+\.(pid|name|path|ignoreKey)$/,
  /^scan\.strays\.\d+\.children\.\d+\.(pid|name|cpuPercent|ioBytesPerSecond|ignoreKey)$/,
  // The waived stray's first child is not busy; its second one is waived.
  /^scan\.strays\.1\.children\.0\.ignored$/,
  /^scan\.strays\.1\.children\.1\.busy$/,
  /^scan\.sessions\.\d+\.(key|origin|liveness|pid|sessionId|name|cwd|folder|entrypoint|rootLabel)$/,
  /^scan\.sessions\.\d+\.(startedAtMs|transcriptPath|lastActivityMs|turnReason|turnDetail|ignoreKey)$/,
  // Claude Code's own status: the scanner folds it into `turn` and `working`.
  /^scan\.sessions\.\d+\.(kind|claudeStatus|waitingFor|claudeStatusSinceMs|turnSource)$/,
  /^scan\.sessions\.\d+\.children\.\d+\.(pid|name|cpuPercent|ioBytesPerSecond|ignoreKey)$/,
  // Already folded into `working` by the scanner.
  /^scan\.sessions\.\d+\.activeSubagents$/,
  /^scan\.sessions\.\d+\.(subagents|why)(\.[\w.]+)?$/,
  // A flag that is not a boolean reads as the blocking value. These four entries are cleared by
  // their OTHER flag (covered / ignored, accounted / ignored), which the substitution leaves alone.
  /^remoteWindows\.0\.ignored$/,
  /^remoteWindows\.1\.covered$/,
  /^scan\.strays\.0\.ignored$/,
  /^scan\.strays\.1\.accounted$/,
];

// --- the substitutions -------------------------------------------------------------------------

const MISSING = Symbol('missing');

interface Substitute {
  label: string;
  value: unknown;
}

const SUBSTITUTES: Substitute[] = [
  { label: 'NaN', value: NaN },
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'Infinity', value: Infinity },
  { label: '-1', value: -1 },
  { label: "'900'", value: '900' },
  { label: "'false'", value: 'false' },
  { label: '{}', value: {} },
  // Beyond the brief: the falsy and truthy stand-ins that `if (flag)` style code falls for.
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: "''", value: '' },
  { label: '(deleted)', value: MISSING },
];

type Path = (string | number)[];

/** Every node below the root: leaves, lists, objects, list entries. */
function nodePaths(value: unknown, prefix: Path = []): Path[] {
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : value !== null && typeof value === 'object'
      ? Object.entries(value)
      : [];
  return entries.flatMap(([key, item]) => [[...prefix, key], ...nodePaths(item, [...prefix, key])]);
}

function dotted(path: Path): string {
  return path.join('.');
}

function withValue(base: EvaluateInput, path: Path, value: unknown): EvaluateInput {
  const copy: unknown = structuredClone(base);
  let node = copy as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) node = node[segment] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === MISSING) delete node[last];
  else node[last] = value;
  return copy as EvaluateInput;
}

function staysOk(base: Base, path: string, substitute: Substitute): boolean {
  // null is the documented way to say "no environment problem": the one substitute that is a real pass.
  if (path === 'environmentProblem' && substitute.value === null) return true;
  return [...NEVER_JUDGED, ...base.notJudgedHere].some((rule) => rule.test(path));
}

/** What must hold for every verdict, whatever went in. */
function malformations(verdict: Verdict): string[] {
  const found: string[] = [];
  const order = verdict.checks.map((entry) => CHECK_ORDER.indexOf(entry.id));
  const others = verdict.checks.filter((entry) => entry.id !== 'confirmed');
  const confirmed = verdict.checks[verdict.checks.length - 1];
  if (verdict.checks[0]?.id !== 'armed') found.push('the internal-failure fallback answered');
  if (confirmed?.id !== 'confirmed') found.push('confirmed is not last');
  if (order.some((position, index) => position < 0 || (index > 0 && position <= (order[index - 1] ?? -1)))) {
    found.push('checks are out of order or repeated');
  }
  if (verdict.allClear !== others.every((entry) => entry.state === 'pass')) found.push('allClear disagrees with the checks');
  if (verdict.ok !== (verdict.allClear && confirmed?.state === 'pass')) found.push('ok disagrees with the checks');
  if (!Number.isSafeInteger(verdict.stablePolls) || verdict.stablePolls < 0) found.push('stablePolls is not a count');
  if (!verdict.allClear && verdict.stablePolls !== 0) found.push('stablePolls survived an unmet check');
  if (!Number.isInteger(verdict.requiredPolls) || verdict.requiredPolls < INT_BOUNDS.requiredPolls[0]) {
    found.push('requiredPolls is below the floor');
  }
  if (verdict.ok && verdict.stablePolls < verdict.requiredPolls) found.push('ok before the count was reached');
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(verdict)), verdict)) found.push('the verdict is not plain JSON');
  return found;
}

/** Problems with the verdict for `mutated`, each prefixed with what was substituted. */
function judge(mutated: EvaluateInput, label: string, expectedOk: boolean): string[] {
  let verdict: Verdict;
  try {
    verdict = evaluate(mutated);
  } catch (error) {
    return [`${label}: threw ${String(error)}`];
  }
  const problems = malformations(verdict).map((problem) => `${label}: ${problem}`);
  if (verdict.ok !== expectedOk) problems.push(`${label}: ok is ${verdict.ok}, expected ${expectedOk}`);
  return problems;
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function overlap(a: Path, b: Path): boolean {
  const shared = Math.min(a.length, b.length);
  return a.slice(0, shared).every((segment, index) => segment === b[index]);
}

// --- the property ------------------------------------------------------------------------------

describe.each(BASES)('garbage in: $name', (base) => {
  const paths = nodePaths(base.input);

  it('starts from a verdict that is ok', () => {
    const verdict = evaluate(base.input);
    expect(malformations(verdict)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('reaches every field of the input', () => {
    const top = new Set(paths.map((path) => path[0]));
    expect([...top].sort()).toEqual(Object.keys(base.input).sort());
    expect(paths.length).toBeGreaterThan(60);
  });

  it.each(SUBSTITUTES)('one node replaced by $label never yields ok unless that node is not judged', (substitute) => {
    const problems = paths.flatMap((path) => {
      const name = dotted(path);
      const mutated = withValue(base.input, path, substitute.value);
      return judge(mutated, `${name} = ${substitute.label}`, staysOk(base, name, substitute));
    });
    expect(problems).toEqual([]);
  });

  it('several nodes replaced at once never unblock each other', () => {
    const random = seededRandom(0xc1a0de);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const problems: string[] = [];
    for (let round = 0; round < 1500; round++) {
      const wanted = 2 + Math.floor(random() * 4);
      const chosen: { path: Path; substitute: Substitute }[] = [];
      while (chosen.length < wanted) {
        const path = pick(paths);
        if (!chosen.some((other) => overlap(other.path, path))) chosen.push({ path, substitute: pick(SUBSTITUTES) });
      }
      const mutated = chosen.reduce((current, each) => withValue(current, each.path, each.substitute.value), base.input);
      const label = chosen.map((each) => `${dotted(each.path)} = ${each.substitute.label}`).join(' + ');
      const expectedOk = chosen.every((each) => staysOk(base, dotted(each.path), each.substitute));
      problems.push(...judge(mutated, label, expectedOk));
    }
    expect(problems).toEqual([]);
  });

  it('has no exemption that matches nothing in this input', () => {
    const idle = base.notJudgedHere.filter((rule) => !paths.some((path) => rule.test(dotted(path))));
    expect(idle).toEqual([]);
  });
});

describe('the exemption list', () => {
  it('has no entry that matches nothing at all', () => {
    const everyPath = BASES.flatMap((base) => nodePaths(base.input).map(dotted));
    expect(NEVER_JUDGED.filter((rule) => !everyPath.some((path) => rule.test(path)))).toEqual([]);
  });

  it('leaves every gate field of every input judged', () => {
    // The fields a wrong value could turn into a shutdown. None of them may ever be exempt.
    const gates = [
      'armed',
      'stopPresent',
      'scanStale',
      'scan',
      'contract',
      'capability',
      'capability.ok',
      'helperTier',
      'remoteWindows',
      'stablePolls',
      'contract.action',
      'contract.requiredPolls',
      'contract.requireUserIdle',
      'contract.userIdleSeconds',
      'contract.waitForChildProcesses',
      'contract.guardProcesses',
      'scan.sessions',
      'scan.errors',
      'scan.roots',
      'scan.strays',
      'scan.strays.0.children',
      'scan.strays.1.children',
      'scan.strays.1.children.0.busy',
      'scan.strays.1.children.1.ignored',
      'scan.unclaimedRecent',
      'scan.idleSeconds',
      'scan.guardHits',
      'scan.processListOk',
    ];
    for (const base of BASES) {
      const present = new Set(nodePaths(base.input).map(dotted));
      for (const gate of gates) {
        expect(present.has(gate), `${gate} in "${base.name}"`).toBe(true);
        expect(staysOk(base, gate, { label: 'NaN', value: NaN }), `${gate} in "${base.name}"`).toBe(false);
      }
    }
    const withSessions = BASES[0]!;
    for (const gate of ['working', 'turn', 'silenceSeconds', 'children', 'children.0.busy']) {
      expect(staysOk(withSessions, `scan.sessions.0.${gate}`, { label: 'NaN', value: NaN }), gate).toBe(false);
    }
    expect(staysOk(withSessions, 'scan.sessions.1.ignored', { label: 'NaN', value: NaN })).toBe(false);
    expect(staysOk(withSessions, 'contract.quietSeconds', { label: 'NaN', value: NaN })).toBe(false);
    expect(staysOk(BASES[1]!, 'sawAnySession', { label: 'NaN', value: NaN })).toBe(false);
    expect(staysOk(BASES[1]!, 'secondsSinceLastSession', { label: 'NaN', value: NaN })).toBe(false);
    expect(staysOk(BASES[1]!, 'contract.quietSeconds', { label: 'NaN', value: NaN })).toBe(false);
    expect(staysOk(BASES[2]!, 'contract.allowWhenNoSessions', { label: 'NaN', value: NaN })).toBe(false);
  });
});

describe('values that pass a naive comparison', () => {
  it('Infinity is not a duration: unknown stand-ins never count as "long enough"', () => {
    const idle = evaluate(input({ scan: scan({ idleSeconds: Infinity }) }));
    const silence = evaluate(input({ scan: scan({ sessions: [session({ silenceSeconds: Infinity })] }) }));
    const sinceLast = evaluate(input({ scan: scan({ sessions: [] }), secondsSinceLastSession: Infinity }));
    for (const verdict of [idle, silence, sinceLast]) expect(verdict.ok).toBe(false);
  });

  it('a limit of -1, null or "0" is not a limit that everything meets', () => {
    for (const limit of [-1, null, '0', 0, NaN]) {
      const rules = { ...contract(), quietSeconds: limit, userIdleSeconds: limit, requiredPolls: limit };
      const verdict = evaluate(input({ contract: illTyped(rules), stablePolls: 99 }));
      expect(verdict.ok).toBe(false);
      expect(verdict.allClear).toBe(false);
    }
  });

  it("refuses each limit just below the settings' floor and accepts it at the floor", () => {
    const [quietFloor] = INT_BOUNDS.quietSeconds;
    const [idleFloor] = INT_BOUNDS.userIdleSeconds;
    const [pollsFloor] = INT_BOUNDS.requiredPolls;
    const at = { quietSeconds: quietFloor, userIdleSeconds: idleFloor, requiredPolls: pollsFloor };
    const atFloor = evaluate(input({ contract: { ...contract(), ...at }, stablePolls: pollsFloor - 1 }));
    expect(atFloor.ok).toBe(true);

    const below = [
      { ...at, quietSeconds: quietFloor - 1 },
      { ...at, userIdleSeconds: idleFloor - 1 },
      { ...at, requiredPolls: pollsFloor - 1 },
    ];
    const blockedBy = below.map((limits) => {
      const verdict = evaluate(input({ contract: { ...contract(), ...limits }, stablePolls: pollsFloor - 1 }));
      expect(verdict.ok).toBe(false);
      return verdict.checks.filter((entry) => entry.state === 'cantTell').map((entry) => entry.id);
    });
    expect(blockedBy).toEqual([['quiet'], ['userIdle'], ['confirmed']]);
  });

  it('a numeric string is not a number, on either side of a comparison', () => {
    const idle = evaluate(input({ scan: scan({ idleSeconds: illTyped('900') }) }));
    const silence = evaluate(input({ scan: scan({ sessions: [session({ silenceSeconds: illTyped('900') })] }) }));
    const polls = evaluate(input({ stablePolls: illTyped('900') }));
    for (const verdict of [idle, silence, polls]) expect(verdict.ok).toBe(false);
  });

  it('a truthy string is not a flag', () => {
    const verdicts = [
      evaluate(input({ armed: illTyped('false') })),
      evaluate(input({ scan: scan({ processListOk: illTyped('false') }) })),
      evaluate(input({ capability: { ok: illTyped('false'), detail: 'x' } })),
      evaluate(input({ remoteWindows: [remoteWindow({ covered: illTyped('false') })] })),
      evaluate(input({ scan: scan({ strays: [stray({ accounted: illTyped('false') })] }) })),
      evaluate(input({ scan: scan({ sessions: [workingSession({ ignored: illTyped('false') })] }) })),
    ];
    for (const verdict of verdicts) expect(verdict.ok).toBe(false);
  });

  it('a falsy non-boolean is not "nothing wrong"', () => {
    const verdicts = [
      evaluate(input({ stopPresent: illTyped(0) })),
      evaluate(input({ scanStale: illTyped(null) })),
      evaluate(input({ environmentProblem: illTyped(undefined) })),
      evaluate(input({ scan: scan({ sessions: [session({ working: illTyped(null) })] }) })),
      evaluate(input({ scan: scan({ sessions: [session({ children: [child({ busy: illTyped(undefined) })] })] }) })),
    ];
    for (const verdict of verdicts) expect(verdict.ok).toBe(false);
  });
});
