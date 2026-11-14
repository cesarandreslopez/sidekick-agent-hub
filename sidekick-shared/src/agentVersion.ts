/**
 * The agent CLI version (and the model) that wrote a session file, read from
 * bounded head and tail windows without parsing the whole transcript.
 *
 * Claude Code stamps every record with a top-level `version` (and the
 * client in `entrypoint`); Codex records `cli_version` and `originator` on
 * the rollout's first line (`session_meta`). The head window gives the
 * first version, the tail window the latest one, so a session that was
 * resumed by a newer CLI reports both. The model comes from Claude Code's
 * assistant `message.model` and Codex's `turn_context` `payload.model`,
 * latest first.
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
  /**
   * Refuse a symbolic link at `filePath`: open with `O_NOFOLLOW` where the
   * platform defines it (a no-op where it does not, such as Windows), so a
   * symlinked path gives null. Only the final path component is checked.
   * Default false. Set it when the path comes from an untrusted payload.
   */
  noFollow?: boolean;
}

export type ReadAgentModelOptions = ReadAgentVersionOptions;

export interface AgentModelInfo {
  provider: AgentVersionProvider;
  /** The model of the latest turn found (Claude Code `<synthetic>` messages are skipped). */
  model: string;
}

export const DEFAULT_AGENT_VERSION_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 16 * 1024 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const MODEL_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.:@/+_[\]-]{0,127}$/;

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

interface FileWindows {
  provider: AgentVersionProvider;
  head: string;
  /** The tail window's text, when the file is longer than the head window. */
  tail?: string;
  wholeFile: boolean;
}

/**
 * Read the head window (and, when `withTail` says so, the tail window) of a
 * session file with one open. Null for compressed, missing, empty or
 * unreadable files.
 */
function readWindows(
  filePath: string,
  options: ReadAgentVersionOptions,
  withTail: (provider: AgentVersionProvider) => boolean,
): FileWindows | null {
  let fd: number | undefined;
  try {
    const name = path.basename(filePath);
    if (isCompressedRolloutFile(name) || name.endsWith('.zst')) return null;
    const requested = options.windowBytes ?? DEFAULT_AGENT_VERSION_WINDOW_BYTES;
    const windowBytes = Number.isFinite(requested)
      ? Math.min(MAX_WINDOW_BYTES, Math.max(256, Math.floor(requested)))
      : DEFAULT_AGENT_VERSION_WINDOW_BYTES;
    // Non-blocking, so a FIFO at the path cannot stall the open; anything but
    // a regular file is then refused.
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    let flags = O_RDONLY;
    if (options.noFollow && typeof O_NOFOLLOW === 'number') flags |= O_NOFOLLOW;
    if (typeof O_NONBLOCK === 'number') flags |= O_NONBLOCK;
    fd = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = stat.size;
    if (size <= 0) return null;
    const provider: AgentVersionProvider = isRolloutFile(name) ? 'codex' : 'claude-code';
    const headLength = Math.min(size, windowBytes);
    const head = Buffer.alloc(headLength);
    const headRead = fs.readSync(fd, head, 0, headLength, 0);
    const wholeFile = headRead >= size;
    const windows: FileWindows = {
      provider,
      head: head.toString('utf8', 0, headRead),
      wholeFile,
    };
    if (!wholeFile && withTail(provider)) {
      const tailLength = Math.min(windowBytes, size - headRead);
      const tail = Buffer.alloc(tailLength);
      const tailRead = fs.readSync(fd, tail, 0, tailLength, size - tailLength);
      windows.tail = tail.toString('utf8', 0, tailRead);
    }
    return windows;
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
  const windows = readWindows(filePath, options, (provider) => provider === 'claude-code');
  if (!windows) return null;
  if (windows.provider === 'codex') return codexVersion(windows.head, windows.wholeFile);

  const fromHead = claudeVersions(windowLines(windows.head, true, windows.wholeFile));
  let latest = fromHead.last;
  let client = fromHead.client;
  if (windows.tail !== undefined) {
    const fromTail = claudeVersions(windowLines(windows.tail, false, false));
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
}

/** The model a complete record names, for the provider's model-bearing record type. */
function recordModel(provider: AgentVersionProvider, line: string): string | undefined {
  // Cheap pre-filter before parsing: only these record types name a model.
  if (!line.includes('"model"')) return undefined;
  if (!line.includes(provider === 'codex' ? '"turn_context"' : '"assistant"')) return undefined;
  const record = parseRecord(line);
  if (!record) return undefined;
  const holder =
    provider === 'codex'
      ? record.type === 'turn_context'
        ? record.payload
        : undefined
      : record.type === 'assistant'
        ? record.message
        : undefined;
  const model =
    holder && typeof holder === 'object' ? (holder as Record<string, unknown>).model : undefined;
  return typeof model === 'string' && model !== '<synthetic>' && MODEL_PATTERN.test(model)
    ? model
    : undefined;
}

/**
 * The model of the latest turn in a Claude Code session (assistant
 * `message.model`, skipping `<synthetic>`) or Codex rollout (`turn_context`
 * `payload.model`), searching the tail window newest first, then the head.
 * Only complete lines inside the windows are read, so a model named only in
 * a record longer than `windowBytes` is not found. Null when none is found,
 * and for compressed, missing, empty or unreadable files. Never throws.
 */
export function readAgentModel(
  filePath: string,
  options: ReadAgentModelOptions = {},
): AgentModelInfo | null {
  const windows = readWindows(filePath, options, () => true);
  if (!windows) return null;
  const chunks =
    windows.tail !== undefined
      ? [windowLines(windows.tail, false, false), windowLines(windows.head, true, false)]
      : [windowLines(windows.head, true, windows.wholeFile)];
  for (const lines of chunks) {
    for (let index = lines.length - 1; index >= 0; index--) {
      const model = recordModel(windows.provider, lines[index]);
      if (model) return { provider: windows.provider, model };
    }
  }
  return null;
}
