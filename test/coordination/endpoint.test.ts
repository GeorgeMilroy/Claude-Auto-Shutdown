// The Windows named-pipe facts the election stands on, checked against the real OS.

import type * as net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PipeClaimer, releaseClaim, tryConnect, tryListen, type Claim } from '../../src/coordination/endpoint';
import { RETRY_JITTER_MS } from '../../src/coordination/timing';
import { sleep, uniqueEndpoint } from './harness';

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
const never = new AbortController().signal;

async function listening(endpoint: string): Promise<net.Server> {
  const result = await tryListen(endpoint);
  if (!('server' in result)) throw new Error(`could not listen: ${result.error}`);
  servers.push(result.server);
  result.server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    sockets.push(socket);
  });
  return result.server;
}

function keep(claim: Claim): Claim {
  if (claim.kind === 'leader') servers.push(claim.server);
  if (claim.kind === 'follower') sockets.push(claim.socket);
  return claim;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

describe.runIf(process.platform === 'win32')('named pipe endpoint', () => {
  it('can be listened on by one process at a time', async () => {
    const endpoint = uniqueEndpoint();
    await listening(endpoint);

    expect(await tryListen(endpoint)).toEqual({ error: 'EADDRINUSE' });
  });

  it('reports a name that is not a pipe instead of rejecting', async () => {
    expect(await tryListen('C:\\not-a-pipe\\cas-test')).toEqual({ error: 'EACCES' });
    expect(await tryConnect('C:\\not-a-pipe\\cas-test', 1000, never)).toEqual({ error: 'ENOENT' });
  });

  it('cannot be connected to when nobody listens', async () => {
    expect(await tryConnect(uniqueEndpoint(), 1000, never)).toEqual({ error: 'ENOENT' });
  });

  it('stays taken while an accepted connection is open, and is free once it is destroyed', async () => {
    const endpoint = uniqueEndpoint();
    const server = await listening(endpoint);
    const client = await tryConnect(endpoint, 1000, never);
    expect('socket' in client).toBe(true);
    if ('socket' in client) sockets.push(client.socket);
    await sleep(30);

    server.close();
    expect(await tryListen(endpoint)).toEqual({ error: 'EADDRINUSE' });

    for (const socket of sockets.splice(0)) socket.destroy();
    await sleep(30);
    const again = await tryListen(endpoint);
    expect('server' in again).toBe(true);
    if ('server' in again) servers.push(again.server);
  });

  it('gives up a connect that hangs, after the timeout', async () => {
    const endpoint = uniqueEndpoint();
    const server = await listening(endpoint);
    const first = await tryConnect(endpoint, 1000, never);
    if ('socket' in first) sockets.push(first.socket);
    await sleep(30);
    server.close(); // the name still exists (one open connection), but nobody accepts any more

    const startedAt = performance.now();
    const result = await tryConnect(endpoint, 200, never);

    expect(result).toEqual({ error: 'TIMEOUT' });
    expect(performance.now() - startedAt).toBeGreaterThan(180);
    expect(performance.now() - startedAt).toBeLessThan(900);
  });

  it('gives up a connect at once when it is aborted', async () => {
    const endpoint = uniqueEndpoint();
    const server = await listening(endpoint);
    const first = await tryConnect(endpoint, 1000, never);
    if ('socket' in first) sockets.push(first.socket);
    await sleep(30);
    server.close();
    const abort = new AbortController();

    const pending = tryConnect(endpoint, 5000, abort.signal);
    abort.abort();

    expect(await pending).toEqual({ error: 'ABORTED' });
    const alreadyAborted = await tryConnect(endpoint, 5000, abort.signal);
    expect(alreadyAborted).toEqual({ error: 'ABORTED' });
  });
});

describe.runIf(process.platform === 'win32')('PipeClaimer', () => {
  it('makes the first contender leader and the next one a follower', async () => {
    const endpoint = uniqueEndpoint();

    const first = keep(await new PipeClaimer(endpoint).attempt(never));
    const second = keep(await new PipeClaimer(endpoint).attempt(never));

    expect(first.kind).toBe('leader');
    expect(second.kind).toBe('follower');
    expect(first.kind === 'leader' && first.stillOwned()).toBe(true);
  });

  it('no longer owns the endpoint once its server is closed', async () => {
    const claim = keep(await new PipeClaimer(uniqueEndpoint()).attempt(never));
    if (claim.kind !== 'leader') throw new Error('expected to lead');

    releaseClaim(claim);

    expect(claim.stillOwned()).toBe(false);
  });

  it('asks for another round, with the usual jitter, when it can neither listen nor connect', async () => {
    const claim = await new PipeClaimer('C:\\not-a-pipe\\cas-test').attempt(never);

    expect(claim).toEqual({
      kind: 'retry',
      reason: 'could not listen on the endpoint (EACCES)',
      delayMs: RETRY_JITTER_MS,
    });
    expect(RETRY_JITTER_MS).toEqual([20, 100]);
  });

  it('frees the endpoint when a claim is released', async () => {
    const endpoint = uniqueEndpoint();
    const leader = await new PipeClaimer(endpoint).attempt(never);
    const follower = await new PipeClaimer(endpoint).attempt(never);

    releaseClaim(follower);
    releaseClaim(leader);
    await sleep(30);

    const next = keep(await new PipeClaimer(endpoint).attempt(never));
    expect(next.kind).toBe('leader');
  });
});
