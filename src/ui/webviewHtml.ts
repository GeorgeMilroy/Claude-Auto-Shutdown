// The one HTML page of the dashboard webview. It loads three files from dist/webview and nothing
// else. The policy allows no inline script, no inline style, no eval, no network and no images:
// the only script that runs is the one tag carrying this page's nonce.

import { randomBytes } from 'node:crypto';

export interface DashboardPage {
  /** webview.cspSource */
  cspSource: string;
  /** Webview URIs of the files in dist/webview. */
  scriptUri: string;
  styleUris: string[];
  nonce: string;
}

export function createNonce(): string {
  return randomBytes(18).toString('base64');
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [`default-src 'none'`, `style-src ${cspSource}`, `font-src ${cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
}

export function dashboardHtml(page: DashboardPage): string {
  const styles = page.styleUris.map((uri) => `    <link rel="stylesheet" href="${attribute(uri)}" />`).join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${attribute(contentSecurityPolicy(page.cspSource, page.nonce))}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Claude Auto Shutdown</title>
${styles}
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${attribute(page.nonce)}" src="${attribute(page.scriptUri)}"></script>
  </body>
</html>
`;
}
