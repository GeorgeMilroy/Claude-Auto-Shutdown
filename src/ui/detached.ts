/**
 * For a call into the editor whose result nobody waits for (set a context key, post to a page,
 * show a message). While the window closes such a call is rejected because the connection to the
 * editor is gone; that is not a failure of anything, and must not surface as an unhandled rejection.
 */
export function detached(call: PromiseLike<unknown>): void {
  call.then(undefined, () => undefined);
}
