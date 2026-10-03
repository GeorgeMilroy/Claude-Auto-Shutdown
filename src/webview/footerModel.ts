// Footer: Log · Settings · Help, where Help opens a short list.

import type { UiState, ViewContext } from '../shared/protocol';
import { control, present, sending, worksHere } from './actions';
import type { Control } from './actions';
import { isWatching } from './hero';
import { toHost } from './messages';
import { footer as copy } from './strings';

export interface FooterModel {
  links: Control[];
  help: Control[];
}

export function buildFooter(state: UiState | null, view: ViewContext): FooterModel {
  // The demo countdown can only be started while nothing is being watched.
  const canPreview = state !== null && !isWatching(state) && state.countdown === null;
  const help = present([
    control(copy.getStarted, sending(toHost.openWalkthrough())),
    canPreview ? control(copy.preview, sending(toHost.preview())) : null,
    control(copy.lastRun, sending(toHost.lastRun())),
    control(copy.emergencyStop, sending(toHost.revealStop())),
  ]);
  const links = present([
    control(copy.log, sending(toHost.showLog())),
    control(copy.settings, sending(toHost.openSettings())),
  ]);
  return {
    links: links.filter((item) => worksHere(item.action, view)),
    help: help.filter((item) => worksHere(item.action, view)),
  };
}
