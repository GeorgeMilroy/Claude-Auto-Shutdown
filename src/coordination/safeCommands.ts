// 'disarm' and 'cancel' make things safer, so they are the only commands that outlive a leader:
// each one stays pending until some leader says "done", and is sent again to every new leader.
//
// If none says so within 2 s - or this window closes first - the command is reported as stuck and
// the caller sets Emergency stop on the user's behalf. "The leader answered, but with a failure"
// counts as stuck too: a Cancel that did not happen must never look like one that did.

import { randomUUID } from 'node:crypto';

import type { Command, CommandResult } from '../shared/protocol';
import { SAFE_COMMAND_STUCK_MS, TimerSet, type TimerHandle } from './timing';

export interface PendingSafeCommand {
  readonly id: string;
  readonly command: Command;
}

interface Entry extends PendingSafeCommand {
  /** Resolves the caller's promise; null once it has been told something. */
  settle: ((result: CommandResult) => void) | null;
  stuckTimer: TimerHandle | null;
  reportedStuck: boolean;
}

export interface SafeCommandEvents {
  /** At most once per command. */
  stuck(command: Command): void;
  /** The last pending command was acknowledged. */
  delivered(): void;
}

export class PendingSafeCommands {
  private readonly entries = new Map<string, Entry>();
  private readonly timers = new TimerSet();
  private readonly events: SafeCommandEvents;

  constructor(events: SafeCommandEvents) {
    this.events = events;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Everything still waiting for a leader's "done", oldest first. */
  pending(): PendingSafeCommand[] {
    return [...this.entries.values()];
  }

  add(command: Command): { pending: PendingSafeCommand; answer: Promise<CommandResult> } {
    const entry: Entry = { id: randomUUID(), command, settle: null, stuckTimer: null, reportedStuck: false };
    const answer = new Promise<CommandResult>((resolve) => {
      entry.settle = resolve;
    });
    entry.stuckTimer = this.timers.set(() => this.reportStuck(entry), SAFE_COMMAND_STUCK_MS);
    this.entries.set(entry.id, entry);
    return { pending: entry, answer };
  }

  /** A leader answered command `id`. Unknown ids (already acknowledged, or not ours) are ignored. */
  answered(id: string, result: CommandResult): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.tell(entry, result);
    if (!result.ok) {
      this.reportStuck(entry);
      return;
    }
    this.timers.clear(entry.stuckTimer);
    this.entries.delete(id);
    if (this.entries.size === 0) this.events.delivered();
  }

  /** This window is closing: whatever is still pending will never be confirmed from here. */
  abandon(error: string): void {
    for (const entry of [...this.entries.values()]) {
      this.reportStuck(entry);
      this.tell(entry, { ok: false, error });
    }
    this.entries.clear();
    this.timers.dispose();
  }

  private tell(entry: Entry, result: CommandResult): void {
    entry.settle?.(result);
    entry.settle = null;
  }

  private reportStuck(entry: Entry): void {
    this.timers.clear(entry.stuckTimer);
    entry.stuckTimer = null;
    if (entry.reportedStuck) return;
    entry.reportedStuck = true;
    this.events.stuck(entry.command);
  }
}
