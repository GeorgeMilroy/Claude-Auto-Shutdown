// The stylesheet may take colours only from VS Code theme variables, and must work in the four
// built-in themes. There is no DOM here, so this reads the CSS as text and checks the rules that
// can be checked that way; what it looks like was checked by eye in the harness.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { themeById, THEMES } from '../../dev/themes';

const css = readFileSync(fileURLToPath(new URL('../../src/webview/styles.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  declarations: { property: string; value: string }[];
}

/** Innermost rule blocks: a selector and its declarations (a rule inside @media is found too). */
function rules(): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    declarations: (match[2] ?? '')
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration !== '')
      .map((declaration) => {
        const colon = declaration.indexOf(':');
        return { property: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() };
      }),
  }));
}

function isHighContrastRule(rule: Rule): boolean {
  return rule.selector.split(',').every((part) => part.includes('vscode-high-contrast'));
}

/** Variables referenced with nothing to fall back on: `var(--vscode-x)`. */
function requiredVariables(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--vscode-[A-Za-z0-9-]+)\s*\)/g)].map((match) => match[1] ?? '');
}

const NAMED_COLOURS = /\b(white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|maroon|navy|teal|aqua|lime|olive|fuchsia)\b/i;

describe('styles.css takes its colours only from the theme', () => {
  it('contains no literal colour', () => {
    for (const rule of rules()) {
      for (const { property, value } of rule.declarations) {
        const where = `${rule.selector} { ${property} }`;
        expect(value, where).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value, where).not.toMatch(/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
        expect(value, where).not.toMatch(NAMED_COLOURS);
      }
    }
  });

  it('references only VS Code variables and its own aliases', () => {
    const referenced = [...css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((match) => match[1] ?? '');
    expect(referenced.length).toBeGreaterThan(50);
    for (const name of referenced) expect(name).toMatch(/^--(vscode|cas)-/);
  });

  it('defines every alias it uses, and builds each alias from VS Code variables only', () => {
    const body = rules().find((rule) => rule.selector === 'body');
    const aliases = new Map((body?.declarations ?? []).filter((d) => d.property.startsWith('--cas-')).map((d) => [d.property, d.value]));
    const used = new Set([...css.matchAll(/var\(\s*(--cas-[A-Za-z0-9-]+)/g)].map((match) => match[1] ?? ''));
    for (const name of used) expect(aliases.has(name), name).toBe(true);
    for (const [name, value] of aliases) expect(value, name).toMatch(/var\(\s*--vscode-/);
  });

  it('mixes colours only from theme variables', () => {
    const mixes = [...css.matchAll(/color-mix\(([^;]*)/g)].map((match) => match[1] ?? '');
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) expect(mix).toMatch(/^in srgb, var\(--vscode-[A-Za-z0-9-]+\) \d+%, transparent\)/);
  });

  it('keeps the body transparent so the view inherits its host', () => {
    const body = rules().find((rule) => rule.selector === 'body');
    expect(body?.declarations).toContainEqual({ property: 'background', value: 'transparent' });
  });
});

describe('styles.css in the four built-in themes', () => {
  it('finds every variable it uses without a fallback in each theme', () => {
    for (const rule of rules()) {
      const themes = isHighContrastRule(rule) ? THEMES.filter((theme) => theme.id.startsWith('hc-')) : THEMES;
      for (const { property, value } of rule.declarations) {
        for (const name of requiredVariables(value)) {
          for (const theme of themes) {
            expect(Object.hasOwn(theme.vars, name), `${theme.label}: ${name} (${rule.selector} { ${property} })`).toBe(true);
          }
        }
      }
    }
  });

  it('draws borders instead of fills in high contrast', () => {
    const highContrast = rules().filter(isHighContrastRule);
    const filled = highContrast.find((rule) => rule.selector.includes('.hero') && rule.selector.includes('.btn'));
    expect(filled?.declarations).toContainEqual({ property: 'background', value: 'transparent' });
    expect(filled?.declarations).toContainEqual({ property: 'border', value: '1px solid var(--vscode-contrastBorder)' });
  });

  it('tells a real countdown from a test by the border style, in every theme', () => {
    const border = (selector: string): string | undefined =>
      rules()
        .find((rule) => rule.selector === selector)
        ?.declarations.find((declaration) => declaration.property === 'border')?.value;
    expect(border('.hero--real')).toMatch(/^2px solid /);
    expect(border('.hero--test')).toMatch(/^2px dashed /);
    expect(border('body.vscode-high-contrast .hero--real')).toBe('2px solid var(--vscode-contrastBorder)');
    expect(border('body.vscode-high-contrast .hero--test')).toBe('2px dashed var(--vscode-contrastBorder)');
  });

  it('uses the active border for hover and focus in high contrast', () => {
    const outlines = rules()
      .filter(isHighContrastRule)
      .flatMap((rule) => rule.declarations.filter((declaration) => declaration.property === 'outline'))
      .map((declaration) => declaration.value);
    expect(outlines).toContain('1px dashed var(--vscode-contrastActiveBorder)');
    expect(outlines).toContain('2px solid var(--vscode-contrastActiveBorder)');
  });

  it('stops every animation and transition when motion is reduced', () => {
    const still = rules().filter((rule) => rule.declarations.some((d) => d.property === 'animation' && d.value === 'none !important'));
    const selectors = still.map((rule) => rule.selector).join(' | ');
    expect(selectors).toContain('body.vscode-reduce-motion *');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    for (const rule of still) expect(rule.declarations).toContainEqual({ property: 'transition', value: 'none !important' });
  });

  it('shows a focus ring in the theme colour', () => {
    const focus = rules().find((rule) => rule.selector.startsWith(':focus-visible'));
    expect(focus?.declarations).toContainEqual({ property: 'outline', value: '1px solid var(--vscode-focusBorder)' });
  });

  it('keeps controls at least 28 px high and session rows at least 44 px', () => {
    const minHeight = (selector: string): string | undefined =>
      rules()
        .find((rule) => rule.selector === selector)
        ?.declarations.find((declaration) => declaration.property === 'min-height')?.value;
    for (const selector of ['.btn', '.link', '.select', '.row', '.radio']) expect(minHeight(selector), selector).toBe('28px');
    expect(minHeight('.row--session')).toBe('44px');
  });
});

describe('the theme presets of the harness', () => {
  it('are the four built-in themes, with the body classes VS Code sets', () => {
    expect(THEMES.map((theme) => [theme.id, theme.bodyClasses])).toEqual([
      ['dark', ['vscode-dark']],
      ['light', ['vscode-light']],
      ['hc-dark', ['vscode-high-contrast']],
      ['hc-light', ['vscode-high-contrast-light', 'vscode-high-contrast']],
    ]);
  });

  it('define about fifty variables each, all of them --vscode-*', () => {
    for (const theme of THEMES) {
      const names = Object.keys(theme.vars);
      expect(names.length, theme.label).toBeGreaterThanOrEqual(45);
      for (const name of names) expect(name).toMatch(/^--vscode-[A-Za-z0-9-]+$/);
    }
  });

  it('leave undefined what the real themes leave undefined', () => {
    expect(themeById('dark').vars).not.toHaveProperty('--vscode-contrastBorder');
    expect(themeById('light').vars).not.toHaveProperty('--vscode-contrastBorder');
    expect(themeById('hc-dark').vars).not.toHaveProperty('--vscode-statusBarItem-errorBackground');
    expect(themeById('hc-dark').vars).not.toHaveProperty('--vscode-testing-iconQueued');
    expect(themeById('hc-light').vars).toHaveProperty('--vscode-contrastActiveBorder');
  });

  it('fall back to Dark+ for an id that is not a theme', () => {
    expect(themeById('solarized').id).toBe('dark');
    expect(themeById(null).id).toBe('dark');
  });
});
