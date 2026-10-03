// Starting to watch, from this window.
//
// The contract sent is this window's own plan - the one on screen - together with the epoch of
// the leader that was showing "not watching" at that moment. A test run or "just notify me" is
// sent at once. A plan that does something to this PC is first confirmed in a dialog, in the
// window the person is looking at, and only an explicit click on "… when finished" counts as yes.
//
// The dialog itself is injected, so the whole decision runs in unit tests.

import { contractDigest } from '../shared/config';
import type { CommandResult } from '../shared/protocol';
import { realModalText } from '../shared/text';
import type { RealModalText } from '../shared/text';
import { copy } from './copy';
import type { SettingsBridge } from './settings';
import { leaderHasPlan, needsConfirmation, startRefusal, unseenRemotes } from './startPlan';
import type { WindowSession } from './windowSession';

export type RealRunAnswer = 'keepOn' | 'start' | 'saveAllFirst';

export interface StartFlowOptions {
  session: Pick<WindowSession, 'current' | 'send'>;
  settings: Pick<SettingsBridge, 'plan' | 'digest'>;
  /** Realm of this window's settings. */
  realm: string;
  /** Show the confirmation of a real run and report which button was pressed. */
  confirmRealRun(text: RealModalText): Promise<RealRunAnswer>;
  saveAll(): Promise<void>;
  /** Unsaved files in this window, for the dialog. */
  unsavedFiles(): number;
  /** Test seam; defaults to a timer. */
  delay?(ms: number): Promise<void>;
}

/** How long "start" waits for the leader to pick up a setting this window has just written. */
export const LEADER_PLAN_WAIT_MS = 3000;
const LEADER_PLAN_POLL_MS = 100;

/** "Not started", without a message: the person chose to keep this PC on. */
const DECLINED: CommandResult = { ok: false };

function refuse(error: string): CommandResult {
  return { ok: false, error };
}

/**
 * The dialog's buttons, in order. "Keep this PC on" comes first, which makes it the button Enter
 * presses; Esc and the close box press none. (The editor adds its own Cancel next to these.
 * Declaring ours as the close button instead would make "… when finished" the default.)
 */
export function modalButtons(text: RealModalText): string[] {
  return [text.cancel, text.confirm, ...(text.confirmAfterSave === null ? [] : [text.confirmAfterSave])];
}

/** What a pressed button means. Anything that is not exactly one of the two "yes" buttons keeps this PC on. */
export function modalAnswer(text: RealModalText, picked: string | undefined): RealRunAnswer {
  if (picked === text.confirm) return 'start';
  if (text.confirmAfterSave !== null && picked === text.confirmAfterSave) return 'saveAllFirst';
  return 'keepOn';
}

export class StartFlow {
  private readonly options: StartFlowOptions;
  private readonly delay: (ms: number) => Promise<void>;
  private running = false;

  constructor(options: StartFlowOptions) {
    this.options = options;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Start watching with this window's plan. Never retried: a refusal is the answer.
   * `{ ok: false }` without an error means the person chose to keep this PC on.
   */
  async start(): Promise<CommandResult> {
    // One dialog at a time: a second request while it is open must not queue another start behind it.
    if (this.running) return refuse(copy.startInProgress);
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<CommandResult> {
    const { session, settings, realm } = this.options;
    const refusal = startRefusal(session.current);
    const state = session.current.state;
    if (refusal !== null || state === null) return refuse(refusal ?? copy.notConnected);

    // What the person agrees to is fixed here: this plan, against this leader. Whatever changes
    // while the dialog is open makes the request invalid instead of changing what was agreed to.
    const plan = settings.plan;
    const digest = contractDigest(plan);
    const epoch = state.epoch;

    if (needsConfirmation(plan)) {
      const text = realModalText(state, { unsavedFiles: this.options.unsavedFiles(), remoteWindows: unseenRemotes(state), plan });
      const answer = await this.options.confirmRealRun(text);
      if (answer !== 'start' && answer !== 'saveAllFirst') return DECLINED;
      if (answer === 'saveAllFirst') await this.options.saveAll();
      if (settings.digest !== digest) return refuse(copy.planChangedMeanwhile);
    }
    await this.waitForLeaderPlan(digest);
    return session.send({ name: 'arm', contract: plan, digest, epoch, realm });
  }

  /** See startPlan.leaderHasPlan. Gives up after a few seconds; the leader then answers for itself. */
  private async waitForLeaderPlan(digest: string): Promise<void> {
    const { session, realm } = this.options;
    for (let waited = 0; waited < LEADER_PLAN_WAIT_MS; waited += LEADER_PLAN_POLL_MS) {
      if (leaderHasPlan(session.current.state, realm, digest)) return;
      await this.delay(LEADER_PLAN_POLL_MS);
    }
  }
}
