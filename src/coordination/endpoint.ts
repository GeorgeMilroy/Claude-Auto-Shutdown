// Leadership = holding the listening end of one fixed local endpoint. This file is the part that
// touches the OS: one round of "try to become leader, else reach the leader".
//
// Windows (named pipe), verified on Windows 11 / Node 22:
// - a second listen() on the same pipe name fails with EADDRINUSE, so listening is exclusive;
// - the kernel frees the name when the owning process dies, so there is nothing to steal;
// - connecting while the name exists but nobody accepts (a leader that closed its listener and
//   still has open connections) blocks for up to 30 s inside libuv, hence the connect timeout.

import * as net from 'node:net';

import { CONNECT_TIMEOUT_MS, RETRY_JITTER_MS, type Range } from './timing';

export type Claim =
  /** This process now holds the endpoint. `stillOwned` is the cheap re-check for the final gate. */
  | { kind: 'leader'; server: net.Server; stillOwned(): boolean }
  /** Connected to whoever holds it. Nothing has been sent yet. */
  | { kind: 'follower'; socket: net.Socket }
  /** Neither worked this round. `delayMs` is how long to wait before the next one. */
  | { kind: 'retry'; reason: string; delayMs: Range };

export interface EndpointClaimer {
  /**
   * One round of the election. Never rejects. Aborting makes it settle promptly and release
   * whatever it had acquired; a claim returned after an abort must be released by the caller.
   */
  attempt(signal: AbortSignal): Promise<Claim>;
}

export type ListenResult = { server: net.Server } | { error: string };
export type ConnectResult = { socket: net.Socket } | { error: string };

/** The errno name of a failed OS call ('ENOENT', ...). */
export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code ? code : 'UNKNOWN';
}

const ignoreSocketError = (): void => undefined;

/** A failure (name taken, name not allowed, ...) comes back as its errno name, not as a rejection. */
export function tryListen(endpoint: string): Promise<ListenResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const onError = (error: Error): void => resolve({ error: errorCode(error) });
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve({ server });
    });
  });
}

/**
 * A failure comes back as its errno name ('TIMEOUT' / 'ABORTED' for the two this function adds).
 * The returned socket already has an 'error' listener, so a late socket error can never throw.
 */
export function tryConnect(endpoint: string, timeoutMs: number, signal: AbortSignal): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    socket.on('error', ignoreSocketError);

    const settle = (result: ConnectResult): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      resolve(result);
    };
    const fail = (code: string): void => {
      socket.destroy();
      settle({ error: code });
    };
    const onConnect = (): void => settle({ socket });
    const onError = (error: Error): void => fail(errorCode(error));
    const onAbort = (): void => fail('ABORTED');
    const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);

    socket.once('connect', onConnect);
    socket.once('error', onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function retry(reason: string, delayMs: Range = RETRY_JITTER_MS): Claim {
  return { kind: 'retry', reason, delayMs };
}

/** Gives back whatever a claim holds (used when the claim arrives too late to be wanted). */
export function releaseClaim(claim: Claim): void {
  if (claim.kind === 'leader') claim.server.close();
  else if (claim.kind === 'follower') claim.socket.destroy();
}

/** Windows: listen first; whoever can is the leader, everybody else connects. */
export class PipeClaimer implements EndpointClaimer {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async attempt(signal: AbortSignal): Promise<Claim> {
    const listened = await tryListen(this.endpoint);
    if ('server' in listened) {
      const { server } = listened;
      return { kind: 'leader', server, stillOwned: () => server.listening };
    }
    if (listened.error !== 'EADDRINUSE') return retry(`could not listen on the endpoint (${listened.error})`);

    const connected = await tryConnect(this.endpoint, CONNECT_TIMEOUT_MS, signal);
    if ('socket' in connected) return { kind: 'follower', socket: connected.socket };
    return retry(`could not connect to the leader (${connected.error})`);
  }
}
