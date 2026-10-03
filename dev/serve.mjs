// Serves the dashboard harness on localhost.
//
//   node scripts/build.mjs --webview-only   build the dashboard bundle first
//   node dev/serve.mjs                      then open the printed URL
//
// Binds to 127.0.0.1 only, on a free port chosen by the OS. Serves a fixed list of files - there
// is no path handling to get wrong. The two harness scripts are bundled from TypeScript on every
// request, so editing a fixture needs a reload, not a restart.

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  ttf: 'font/ttf',
};

/** @param {string} relativePath @param {string} type */
function file(relativePath, type) {
  return async () => ({ type, body: await readFile(join(root, relativePath)) });
}

/** @param {string} entry */
function bundle(entry) {
  return async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'browser',
      target: 'es2022',
      format: 'iife',
      sourcemap: 'inline',
      logLevel: 'silent',
    });
    const output = result.outputFiles[0];
    if (output === undefined) throw new Error(`esbuild produced no output for ${entry}`);
    return { type: TYPES.js, body: Buffer.from(output.contents) };
  };
}

/** @type {Record<string, () => Promise<{ type: string, body: Buffer }>>} */
const ROUTES = {
  '/': file('dev/harness.html', TYPES.html),
  '/frame.html': file('dev/frame.html', TYPES.html),
  '/harness.css': file('dev/harness.css', TYPES.css),
  '/vscode-default.css': file('dev/vscode-default.css', TYPES.css),
  '/harness.js': bundle('dev/harness.ts'),
  '/frame.js': bundle('dev/frame.ts'),
  '/webview/main.js': file('dist/webview/main.js', TYPES.js),
  '/webview/main.js.map': file('dist/webview/main.js.map', TYPES.json),
  '/webview/main.css': file('dist/webview/main.css', TYPES.css),
  '/webview/main.css.map': file('dist/webview/main.css.map', TYPES.json),
  '/webview/codicon.css': file('dist/webview/codicon.css', TYPES.css),
  '/webview/codicon.ttf': file('dist/webview/codicon.ttf', TYPES.ttf),
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  if (route === undefined || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  try {
    const { type, body } = await route();
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const hint = path.startsWith('/webview/') ? ' Run `node scripts/build.mjs --webview-only` first.' : '';
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${error instanceof Error ? error.message : String(error)}${hint}`);
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  console.log(`Dashboard harness: http://127.0.0.1:${port}/`);
  console.log('Ctrl+C to stop.');
});
