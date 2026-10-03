// Entry point of the dashboard webview. Bundled by esbuild into dist/webview/main.js (+ main.css);
// the host page loads codicon.css, main.css and this script, and nothing else.

import { render } from 'preact';
import './styles.css';
import { App } from './components/App';
import type { VsCodeApi } from './components/App';
import { CrashBoundary } from './components/Chrome';

function mountPoint(): HTMLElement {
  return document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
}

// Every outgoing message is one of the WebviewToHost shapes built in messages.ts.
const api: VsCodeApi = acquireVsCodeApi();

render(
  <CrashBoundary post={(message) => api.postMessage(message)}>
    <App api={api} />
  </CrashBoundary>,
  mountPoint(),
);
