// The harness page around the dashboard frame: pick a fixture state, a theme, a width; watch the
// messages the dashboard posts. Everything it shows is synthetic; nothing here can reach the
// machine.

import { FIXTURES } from './fixtures';
import type { FrameHarness } from './frame';
import { THEMES } from './themes';

interface Settings {
  fixture: string;
  theme: string;
  surface: string;
  width: string;
  motion: string;
}

const WIDTHS: readonly { value: string; label: string }[] = [
  { value: '300', label: '300 px (narrow side bar)' },
  { value: '420', label: '420 px' },
  { value: '720', label: '720 px (wide layout)' },
  { value: '100%', label: 'Fill' },
];

const SURFACES: readonly { value: string; label: string }[] = [
  { value: 'sideBar', label: 'Side bar' },
  { value: 'editor', label: 'Editor' },
  { value: 'panel', label: 'Panel' },
];

const MAX_LOG_LINES = 200;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`harness.html is missing #${id}`);
  return found as T;
}

const fixtureSelect = element<HTMLSelectElement>('fixture');
const themeSelect = element<HTMLSelectElement>('theme');
const surfaceSelect = element<HTMLSelectElement>('surface');
const widthSelect = element<HTMLSelectElement>('width');
const motionBox = element<HTMLInputElement>('motion');
const frame = element<HTMLIFrameElement>('frame');
const log = element<HTMLOListElement>('log');

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function fillControls(): void {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const fixture of FIXTURES) {
    let group = groups.get(fixture.group);
    if (group === undefined) {
      group = document.createElement('optgroup');
      group.label = fixture.group;
      groups.set(fixture.group, group);
      fixtureSelect.append(group);
    }
    group.append(option(fixture.id, fixture.title));
  }
  for (const theme of THEMES) themeSelect.append(option(theme.id, theme.label));
  for (const surface of SURFACES) surfaceSelect.append(option(surface.value, surface.label));
  for (const width of WIDTHS) widthSelect.append(option(width.value, width.label));
}

function readSettings(): Settings {
  const params = new URLSearchParams(window.location.search);
  return {
    fixture: params.get('fixture') ?? FIXTURES[0]?.id ?? '',
    theme: params.get('theme') ?? 'dark',
    surface: params.get('surface') ?? 'sideBar',
    width: params.get('width') ?? '300',
    motion: params.get('motion') ?? '',
  };
}

function currentSettings(): Settings {
  return {
    fixture: fixtureSelect.value,
    theme: themeSelect.value,
    surface: surfaceSelect.value,
    width: widthSelect.value,
    motion: motionBox.checked ? 'reduce' : '',
  };
}

function query(settings: Settings): string {
  const params = new URLSearchParams({ fixture: settings.fixture, theme: settings.theme, surface: settings.surface });
  if (settings.motion !== '') params.set('motion', settings.motion);
  return params.toString();
}

function rememberInUrl(settings: Settings): void {
  window.history.replaceState(null, '', `?${query(settings)}&width=${encodeURIComponent(settings.width)}`);
}

function frameHarness(): FrameHarness | undefined {
  return frame.contentWindow?.harness;
}

function applyWidth(width: string): void {
  frame.style.width = width === '100%' ? '100%' : `${width}px`;
}

/** A fresh frame = a webview that has just been opened (including the "connecting" grace). */
function reloadFrame(): void {
  const settings = currentSettings();
  rememberInUrl(settings);
  applyWidth(settings.width);
  frame.src = `/frame.html?${query(settings)}`;
}

/** The same webview receives a new state, as it would from the host: phase changes are visible. */
function showFixture(): void {
  rememberInUrl(currentSettings());
  const inner = frameHarness();
  if (inner === undefined) reloadFrame();
  else inner.show(fixtureSelect.value);
}

function applyTheme(): void {
  const settings = currentSettings();
  rememberInUrl(settings);
  frameHarness()?.setTheme(settings.theme, settings.surface);
  frameHarness()?.setReducedMotion(settings.motion === 'reduce');
}

function appendLog(message: unknown): void {
  const line = document.createElement('li');
  line.textContent = `${new Date().toLocaleTimeString()}  ${JSON.stringify(message)}`;
  log.prepend(line);
  while (log.children.length > MAX_LOG_LINES) log.lastElementChild?.remove();
}

function start(): void {
  fillControls();
  const settings = readSettings();
  fixtureSelect.value = settings.fixture;
  themeSelect.value = settings.theme;
  surfaceSelect.value = settings.surface;
  widthSelect.value = settings.width;
  motionBox.checked = settings.motion === 'reduce';

  fixtureSelect.addEventListener('change', showFixture);
  themeSelect.addEventListener('change', applyTheme);
  surfaceSelect.addEventListener('change', applyTheme);
  motionBox.addEventListener('change', applyTheme);
  widthSelect.addEventListener('change', () => {
    rememberInUrl(currentSettings());
    applyWidth(widthSelect.value);
  });
  element<HTMLButtonElement>('reload').addEventListener('click', reloadFrame);
  element<HTMLButtonElement>('focus-plan').addEventListener('click', () => frameHarness()?.focusPlan());
  element<HTMLButtonElement>('clear-log').addEventListener('click', () => log.replaceChildren());

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (data !== null && typeof data === 'object' && 'harnessLog' in data) appendLog(data.harnessLog);
  });

  reloadFrame();
}

start();
