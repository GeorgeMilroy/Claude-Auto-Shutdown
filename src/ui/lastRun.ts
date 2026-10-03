// "What happened last time?": the newest result on record, read from last-run.json - also one
// the user has already dismissed with "Got it", and also when no window is watching.

import { parseLastResult } from '../controller/records';
import type { LastResult } from '../shared/protocol';
import type { StateDir } from '../shared/stateDir';
import { describeResult } from '../shared/text';
import { copy } from './copy';
import { isRecord } from './snapshot';

export interface LastRunReport {
  message: string;
  detail: string;
}

/** The stored result, re-checked field by field (the file is input like any other); null = none. */
export function readLastRun(stateDir: Pick<StateDir, 'readJson' | 'lastRunFile'>): LastResult | null {
  const record = stateDir.readJson(stateDir.lastRunFile);
  return isRecord(record) ? parseLastResult(record.lastResult) : null;
}

function dateOf(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/** The result as a dialog: one sentence, then the details and the day it was recorded. */
export function lastRunReport(result: LastResult, osName: string): LastRunReport {
  const text = describeResult(result, osName);
  return { message: text.oneLine, detail: [...text.body, copy.recordedOn(dateOf(result.atMs))].join('\n') };
}
