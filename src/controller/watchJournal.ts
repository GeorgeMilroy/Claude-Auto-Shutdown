// What gets written down while watching, so that "why is this PC still on this morning?" has an
// answer: one line whenever the SET of unmet checks changes (not one per poll), one line when the
// scan's own problems change, and a running note of which session held things up the longest.

import type { ScanResult, Verdict } from '../core/types';
import type { ActivityEntry } from '../shared/protocol';
import { blockerKey, defaultBlockerText } from './verdict';

const MAX_LOGGED_CHARS = 600;

export interface WatchJournalOptions {
  note(level: ActivityEntry['level'], text: string): void;
  /** Plain-English summary of the unmet checks; absent or failing = the check ids are listed. */
  describeBlockers?: (verdict: Verdict, scan: ScanResult | null) => string;
}

interface Blocker {
  name: string;
  ms: number;
}

function clip(text: string): string {
  return text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS - 1)}…` : text;
}

export class WatchJournal {
  private readonly options: WatchJournalOptions;
  private lastBlockerKey: string | null = null;
  private lastScanProblems = '';
  private lastSampleMono: number | null = null;
  private blocking = new Map<string, Blocker>();
  private longest: Blocker | null = null;

  constructor(options: WatchJournalOptions) {
    this.options = options;
  }

  /** Watching started or stopped: the next verdict is news again. */
  reset(): void {
    this.lastBlockerKey = null;
    this.lastScanProblems = '';
    this.lastSampleMono = null;
    this.blocking = new Map();
    this.longest = null;
  }

  /** After every completed poll while watching. */
  poll(scan: ScanResult | null, verdict: Verdict, mono: number): void {
    this.trackBlockers(scan, mono);
    this.scanProblems(scan);
    this.verdict(verdict, scan);
  }

  /** Logs the unmet checks when their set changed since the last call. */
  verdict(verdict: Verdict, scan: ScanResult | null): void {
    const key = blockerKey(verdict);
    if (key === this.lastBlockerKey) return;
    this.lastBlockerKey = key;
    if (key === '') this.options.note('info', 'Everything is clear. Checking again before the countdown.');
    else this.options.note('info', `Still on. ${clip(this.describe(verdict, scan))}`);
  }

  /** The session that kept this PC on the longest so far, if any did. */
  heldUpBy(): { name: string; seconds: number } | null {
    return this.longest === null ? null : { name: this.longest.name, seconds: Math.round(this.longest.ms / 1000) };
  }

  private describe(verdict: Verdict, scan: ScanResult | null): string {
    try {
      const text = this.options.describeBlockers?.(verdict, scan);
      if (typeof text === 'string' && text.trim() !== '') return text;
    } catch {
      // fall back to the check ids
    }
    return defaultBlockerText(verdict);
  }

  private scanProblems(scan: ScanResult | null): void {
    const problems = scan === null ? '' : scan.errors.join(' | ');
    if (problems === this.lastScanProblems) return;
    this.lastScanProblems = problems;
    if (problems !== '') this.options.note('warn', `Couldn't see everything: ${clip(problems)}`);
  }

  /** Each blocking session is credited with the time since the previous poll. */
  private trackBlockers(scan: ScanResult | null, mono: number): void {
    const elapsed = this.lastSampleMono === null ? 0 : mono - this.lastSampleMono;
    this.lastSampleMono = mono;
    if (scan === null) return;
    const blocking = new Map<string, Blocker>();
    for (const session of scan.sessions) {
      if (!session.working || session.ignored) continue;
      const ms = (this.blocking.get(session.key)?.ms ?? 0) + elapsed;
      blocking.set(session.key, { name: session.name, ms });
      if (ms > (this.longest?.ms ?? 0)) this.longest = { name: session.name, ms };
    }
    this.blocking = blocking;
  }
}
