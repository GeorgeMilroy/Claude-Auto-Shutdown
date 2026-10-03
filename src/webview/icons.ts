// The codicons the dashboard uses (the font is bundled next to the stylesheet) and the colour
// roles an icon can take. An icon never carries meaning alone: it always sits next to words.

export type IconName =
  | 'eye-closed'
  | 'eye'
  | 'beaker'
  | 'sync'
  | 'clock'
  | 'pass'
  | 'check-all'
  | 'question'
  | 'warning'
  | 'error'
  | 'info'
  | 'circle-slash'
  | 'stop-circle'
  | 'chevron-right'
  | 'chevron-down'
  | 'gear'
  | 'type-hierarchy-sub'
  | 'debug-step-over'
  | 'terminal';

/** passed / waiting / cantTell / broken map to the theme's test-result and warning colours. */
export type Tone = 'neutral' | 'muted' | 'passed' | 'waiting' | 'cantTell' | 'broken';

export interface Glyph {
  icon: IconName;
  tone: Tone;
  /** Rotates while motion is allowed (work in progress). */
  spin: boolean;
}

export function glyph(icon: IconName, tone: Tone, spin = false): Glyph {
  return { icon, tone, spin };
}
