/**
 * The agent CLI version that wrote a session file, read from bounded head
 * and tail windows without parsing the whole transcript.
 *
 * Claude Code stamps every record with a top-level `version` (and the
 * client in `entrypoint`); Codex records `cli_version` and `originator` on
 * the rollout's first line (`session_meta`). The head window gives the
 * first version, the tail window the latest one, so a session that was
 * resumed by a newer CLI reports both.
 *
 * Dependency-free (Node's `fs` and `path` only), for hook bundles. Never
 * throws: unreadable, empty, or unrecognized files give null, and so do
 * compressed rollouts (`.jsonl.zst`), which would need a decompressor.
 *
 * @module agentVersion
 */

import * as fs from 'fs';
import * as path from 'path';
import { isCompressedRolloutFile, isRolloutFile } from './codexLayout';

export type AgentVersionProvider = 'claude-code' | 'codex';

export interface AgentVersionInfo {
  provider: AgentVersionProvider;
  /** The latest version recorded (Claude Code: in the tail window; Codex: `cli_version`). */
  version: string;
  /** The first version recorded, when it differs from `version` (a resumed session). */
  firstVersion?: string;
  /** The client: Codex `originator` (`codex_vscode`, …), Claude Code `entrypoint` (`cli`, …). */
  originator?: string;
}

export interface ReadAgentVersionOptions {
  /** Bytes read from the head and from the tail (default 64 KiB each). */
  windowBytes?: number;
}

export const DEFAULT_AGENT_VERSION_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 16 * 1024 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Complete lines of a window: the head drops its partial last line, the tail its first. */
function windowLines(text: string, isHead: boolean, wholeFile: boolean): string[] {
  const lines = text.split('\n');
  if (wholeFile) return lines;
  return isHead ? lines.slice(0, -1) : lines.slice(1);
}

function codexVersion(head: string, wholeFile: boolean): AgentVersionInfo | null {
  const newline = head.indexOf('\n');
  const first = newline === -1 ? head : head.slice(0, newline);
  const record = newline !== -1 || wholeFile ? parseRecord(first) : undefined;
  if (record) {
    if (record.type !== 'session_meta') return null;
    const payload = record.payload as Record<string, unknown> | undefined;
    const version = shortString(payload?.cli_version);
    if (!version) return null;
    const originator = shortString(payload?.originator);
    return { provider: 'codex', version, ...(originator ? { originator } : {}) };
  }
  // A session_meta longer than the window (it carries the instructions):
  // its leading fields come first, so read them from the partial line.
  if (!/^\{\s*"(?:timestamp|type)"/.test(first) || !first.includes('"session_meta"')) return null;
  const version = shortString(/"cli_version"\s*:\s*"([^"\\]{1,64})"/.exec(first)?.[1]);
  if (!version) return null;
  const originator = shortString(/"originator"\s*:\s*"([^"\\]{1,64})"/.exec(first)?.[1]);
  return { provider: 'codex', version, ...(originator ? { originator } : {}) };
}

function claudeVersions(lines: string[]): { first?: string; last?: string; client?: string } {
  let first: string | undefined;
  let last: string | undefined;
  let client: string | undefined;
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    const version = shortString(record.version);
    if (version) {
      first ??= version;
      last = version;
    }
    const entrypoint = shortString(record.entrypoint);
    if (entrypoint) client = entrypoint;
  }
  return { first, last, client };
}

/**
 * The agent version recorded in a Claude Code session or Codex rollout,
 * reading at most `windowBytes` from each end of the file with one open.
 * The provider comes from the file name: `rollout-….jsonl` is Codex,
 * anything else Claude Code.
 */
export function readAgentVersion(
  filePath: string,
  options: ReadAgentVersionOptions = {},
): AgentVersionInfo | null {
  let fd: number | undefined;
  try {
    const name = path.basename(filePath);
    if (isCompressedRolloutFile(name) || name.endsWith('.zst')) return null;
    const requested = options.windowBytes ?? DEFAULT_AGENT_VERSION_WINDOW_BYTES;
    const windowBytes = Number.isFinite(requested)
      ? Math.min(MAX_WINDOW_BYTES, Math.max(256, Math.floor(requested)))
      : DEFAULT_AGENT_VERSION_WINDOW_BYTES;
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return null;
    const headLength = Math.min(size, windowBytes);
    const head = Buffer.alloc(headLength);
    const headRead = fs.readSync(fd, head, 0, headLength, 0);
    const headText = head.toString('utf8', 0, headRead);
    const wholeFile = headRead >= size;

    if (isRolloutFile(name)) return codexVersion(headText, wholeFile);

    const fromHead = claudeVersions(windowLines(headText, true, wholeFile));
    let latest = fromHead.last;
    let client = fromHead.client;
    if (!wholeFile) {
      const tailLength = Math.min(windowBytes, size - headRead);
      const tail = Buffer.alloc(tailLength);
      const tailRead = fs.readSync(fd, tail, 0, tailLength, size - tailLength);
      const fromTail = claudeVersions(
        windowLines(tail.toString('utf8', 0, tailRead), false, false),
      );
      latest = fromTail.last ?? latest;
      client = fromTail.client ?? client;
    }
    const version = latest ?? fromHead.first;
    if (!version) return null;
    return {
      provider: 'claude-code',
      version,
      ...(fromHead.first && fromHead.first !== version ? { firstVersion: fromHead.first } : {}),
      ...(client ? { originator: client } : {}),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}
