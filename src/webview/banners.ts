// The banner slot above the hero. An ordinary follower window gets none: it looks and works
// exactly like the window in control. Banners are for the few facts that change what this window
// can do, or that the user must know before trusting anything below.

import type { UiState, ViewContext } from '../shared/protocol';
import { control, sending } from './actions';
import type { Control } from './actions';
import { text } from './guards';
import type { IconName } from './icons';
import { toHost } from './messages';
import { checkSentence, textContextOf } from './sharedCopy';
import { banners, buttons } from './strings';

export interface BannerModel {
  id: 'limited' | 'emergencyStop' | 'experimental';
  tone: 'info' | 'warning';
  icon: IconName;
  text: string;
  control: Control | null;
}

function limitedBanner(state: UiState | null): BannerModel {
  const app = state === null ? null : text(state.leader.app);
  const version = state === null ? null : text(state.leader.ext);
  return { id: 'limited', tone: 'info', icon: 'info', text: banners.limited(app, version), control: null };
}

function emergencyStopBanner(state: UiState | null, view: ViewContext): BannerModel | null {
  const setByUs = view.autoStopSet || (state !== null && state.stop.present && state.stop.auto);
  if (!setByUs && (state === null || !state.stop.present)) return null;
  const sentence = setByUs || state === null ? banners.autoStop : checkSentence('stopFile', 'fail', {}, textContextOf(state));
  return {
    id: 'emergencyStop',
    tone: 'warning',
    icon: 'stop-circle',
    text: sentence,
    control: control(buttons.stopFolder, sending(toHost.revealStop())),
  };
}

function experimentalBanner(state: UiState | null): BannerModel | null {
  if (state === null || !state.platform.experimental) return null;
  return {
    id: 'experimental',
    tone: 'warning',
    icon: 'beaker',
    text: banners.experimental(state.platform.osName),
    control: null,
  };
}

export function buildBanners(state: UiState | null, view: ViewContext): BannerModel[] {
  const all = [view.limited ? limitedBanner(state) : null, emergencyStopBanner(state, view), experimentalBanner(state)];
  return all.filter((banner): banner is BannerModel => banner !== null);
}
