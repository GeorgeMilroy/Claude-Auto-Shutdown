// Bundles the extension host code and the webview app with esbuild.
//   node scripts/build.mjs               one-off development build
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified, no sourcemaps (used by vsce)
//   node scripts/build.mjs --webview-only  just the dashboard (for the browser harness in dev/)
import { context, build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const webviewOnly = process.argv.includes('--webview-only');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  absWorkingDir: root,
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...common,
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'css' },
};

function copyStatic() {
  const out = join(root, 'dist', 'webview');
  mkdirSync(out, { recursive: true });
  const codicons = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
  cpSync(join(codicons, 'codicon.css'), join(out, 'codicon.css'));
  cpSync(join(codicons, 'codicon.ttf'), join(out, 'codicon.ttf'));
}

const targets = webviewOnly ? [webview] : [extension, webview];

if (!watch && !webviewOnly) {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
}
copyStatic();

if (watch) {
  const contexts = await Promise.all(targets.map((target) => context(target)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching for changes...');
} else {
  await Promise.all(targets.map((target) => build(target)));
}
