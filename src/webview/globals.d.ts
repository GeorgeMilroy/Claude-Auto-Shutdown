// Ambient declarations for the webview bundle.

/** esbuild bundles the stylesheet into dist/webview/main.css; the import has no value. */
declare module '*.css';

/** Provided by VS Code inside a webview. May be called once. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
