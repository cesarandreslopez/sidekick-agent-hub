# Provider System

Sidekick has two separate provider concepts that operate independently.

```mermaid
flowchart LR
    subgraph Inference["Inference Providers"]
        direction TB
        CM["claude-max"] --> AS["AuthService"]
        CA["claude-api"] --> AS
        OCI["opencode"] --> AS
        CXI["codex"] --> AS
        AS --> Complete["complete()"]
    end

    subgraph Session["Session Providers"]
        direction TB
        CCS["claude-code"] --> SM["SessionMonitor"]
        OCS["opencode"] --> SM
        CXS["codex"] --> SM
        SM --> UI["UI Components"]
    end

    PD["ProviderDetector<br/><small>Auto-detect via filesystem mtime</small>"]
    PD -.-> Inference
    PD -.-> Session
```

## Inference Providers

Defined as `InferenceProviderId` in `src/types/inferenceProvider.ts`:

| ID | Description | Client |
|----|-------------|--------|
| `claude-max` | Claude via Max subscription | `MaxSubscriptionClient` |
| `claude-api` | Claude via API key | `ApiKeyClient` |
| `opencode` | OpenCode local server | `OpenCodeClient` |
| `codex` | Codex CLI subprocess | `CodexClient` |

All inference clients implement the `ClaudeClient` interface:

```typescript
interface ClaudeClient {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  isAvailable(): Promise<boolean>;
  dispose(): void;
}
```

`AuthService` is the central entry point — lazily initializes the correct client and routes all `complete()` calls.

## Session Providers

Defined as `SessionProvider` in `src/types/sessionProvider.ts`:

| ID | Description | Data Source |
|----|-------------|------------|
| `claude-code` | Claude Code sessions | `~/.claude/projects/` |
| `opencode` | OpenCode sessions | OpenCode data dir (`~/.local/share/opencode/`, `~/Library/Application Support/opencode/`, `%APPDATA%\\opencode\\`) |
| `codex` | Codex CLI sessions | Managed profile home + `~/.codex/sessions/` (all candidates scanned) |

Each session provider normalizes raw data into the common `ClaudeSessionEvent` format.

## Auto-Detection

Both provider types support auto-detection via `ProviderDetector`, which checks:

1. Which CLI tools are installed on the system
2. Which have the most recent filesystem activity (mtime)
3. Selects the most recently used provider

## Independence

Inference and session providers are independent — you can use Claude Max for inference while monitoring OpenCode sessions, or any other combination.

## Account Registry

Account management is provider-aware via a v2 registry format (`~/.config/sidekick/accounts/accounts.json`). Each provider (Claude Code, Codex) maintains its own active account independently — switching Claude accounts does not affect Codex, and vice versa.

- **Claude Code accounts** store backed-up OAuth credentials and identity metadata
- **Codex accounts** use isolated profile directories with independent `CODEX_HOME` paths, allowing each profile to have its own auth, config, and session data

The registry auto-migrates from v1 (single-provider) to v2 (multi-provider) on first read. Quota snapshots are cached per provider/account for offline fallback.

## Shared Provider Library

The [`sidekick-shared`](https://www.npmjs.com/package/sidekick-shared) package ports the session provider implementations for use outside VS Code. It uses the same auto-detection algorithm — checking filesystem presence and most-recent modification time — minus the VS Code setting fallback. Any npm project can consume these providers directly via `npm install sidekick-shared`.

The CLI's `--provider` flag serves as an explicit override when auto-detection isn't appropriate. Providers read session data in the same formats (JSONL, SQLite, JSON) as the extension, so the CLI produces identical results from the same data files.
