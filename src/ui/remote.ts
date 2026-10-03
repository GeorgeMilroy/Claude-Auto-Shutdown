// What this window is connected to, in words, and which settings it reads.
//
// The extension always runs on the local PC (extensionKind "ui"), also in a window that is
// connected to WSL, SSH or a container. Claude sessions inside that remote are invisible from
// here, so the leader must know that such a window is open.

import { createHash } from 'node:crypto';

const MAX_NAME_CHARS = 60;

function printable(text: string): string | null {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (clean === '') return null;
  return clean.length > MAX_NAME_CHARS ? `${clean.slice(0, MAX_NAME_CHARS - 1)}…` : clean;
}

/** Remote-SSH sometimes encodes the host as hex JSON (`{"hostName":"build-box"}`). */
function hostFromHexJson(text: string): string | null {
  if (text.length % 2 !== 0 || !/^7b[0-9a-f]+7d$/i.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'hex').toString('utf8'));
    const host = (parsed as { hostName?: unknown } | null)?.hostName;
    return typeof host === 'string' ? host : null;
  } catch {
    return null;
  }
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The part after `+` in a remote authority (`wsl+Ubuntu` -> `Ubuntu`); null when there is none. */
function authorityTarget(authority: string | undefined): string | null {
  if (authority === undefined) return null;
  const decoded = percentDecoded(authority);
  const plus = decoded.indexOf('+');
  if (plus < 0) return null;
  const target = decoded.slice(plus + 1);
  return printable(hostFromHexJson(target) ?? target);
}

/**
 * `vscode.env.remoteName` for humans: "WSL: Ubuntu", "SSH: build-box", "Dev Container"; null for a
 * local window. A WSL label has the form the scanner gives the distro's Claude folder, so the
 * leader can tell that this remote is one it can see into.
 */
export function remoteLabel(remoteName: string | undefined, authority: string | undefined): string | null {
  if (remoteName === undefined || remoteName === '') return null;
  const target = authorityTarget(authority);
  switch (remoteName) {
    case 'wsl':
      return target === null ? 'WSL' : `WSL: ${target}`;
    case 'ssh-remote':
      return target === null ? 'SSH' : `SSH: ${target}`;
    case 'dev-container':
    case 'attached-container':
      return 'Dev Container';
    case 'codespaces':
      return 'Codespaces';
    case 'tunnel':
      return target === null ? 'Tunnel' : `Tunnel: ${target}`;
    default:
      return `Remote: ${printable(remoteName) ?? 'unknown'}`;
  }
}

/**
 * Identifies the settings this window reads. Our settings are application-scoped, so every window
 * of one editor - remote windows included - reads them from that editor's local user settings:
 * one editor, one realm. VS Code, Insiders and Cursor keep separate settings and separate global
 * storage, so they are separate realms.
 */
export function realmOf(globalStoragePath: string): string {
  return createHash('sha256').update(globalStoragePath).digest('hex').slice(0, 16);
}
