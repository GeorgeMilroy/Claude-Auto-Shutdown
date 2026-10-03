// What the OS says about each power action ("can this run unattended on this PC?").
//
// Asked afresh when watching starts, then trusted for 5 minutes at a time. An answer that could
// not be obtained is stored as `ok: null` - "can't tell" - which blocks exactly like a "no".

import type { Capability, Platform } from '../platform/types';
import type { PowerAction } from '../shared/config';
import { errorText } from './wording';

export const CAPABILITY_TTL_MS = 5 * 60_000;

function sanitize(raw: unknown): Capability {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    ok: typeof source.ok === 'boolean' ? source.ok : null,
    detail: typeof source.detail === 'string' ? source.detail : '',
  };
}

export class CapabilityCache {
  private readonly platform: Pick<Platform, 'capability'>;
  private readonly mono: () => number;
  private readonly answers = new Map<PowerAction, { capability: Capability; atMono: number }>();
  private readonly queries = new Map<PowerAction, Promise<Capability>>();

  constructor(platform: Pick<Platform, 'capability'>, mono: () => number) {
    this.platform = platform;
    this.mono = mono;
  }

  /** The latest answer, however old; null = never asked. */
  get(action: PowerAction): Capability | null {
    return this.answers.get(action)?.capability ?? null;
  }

  all(): Partial<Record<PowerAction, Capability>> {
    const out: Partial<Record<PowerAction, Capability>> = {};
    for (const [action, answer] of this.answers) out[action] = answer.capability;
    return out;
  }

  /** Asks the OS now, whatever the cache says. One query per action at a time. Never rejects. */
  query(action: PowerAction): Promise<Capability> {
    const running = this.queries.get(action);
    if (running !== undefined) return running;
    const query = this.ask(action).finally(() => this.queries.delete(action));
    this.queries.set(action, query);
    return query;
  }

  /**
   * Re-asks for every listed action whose answer is missing or older than 5 minutes, one at a
   * time. Resolves true when anything was asked.
   */
  async refresh(actions: readonly PowerAction[], cancelled: () => boolean): Promise<boolean> {
    let asked = false;
    for (const action of actions) {
      if (cancelled()) break;
      const answer = this.answers.get(action);
      if (answer !== undefined && this.mono() - answer.atMono < CAPABILITY_TTL_MS) continue;
      await this.query(action);
      asked = true;
    }
    return asked;
  }

  private async ask(action: PowerAction): Promise<Capability> {
    let capability: Capability;
    try {
      capability = sanitize(await this.platform.capability(action));
    } catch (error) {
      capability = { ok: null, detail: `Couldn't check: ${errorText(error)}` };
    }
    this.answers.set(action, { capability, atMono: this.mono() });
    return capability;
  }
}
