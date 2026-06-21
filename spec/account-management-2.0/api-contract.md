# API Contract — `sidekick-shared` account management 2.0

Authoritative TypeScript signatures + Zod shapes that consumers depend on. Implemented across Phases 01–06,
exported in Phase 09. Keep this file and the code in lockstep.

## Types

```ts
// Reused from accountRegistry.ts:5 — DO NOT redefine.
type AccountProviderId = 'claude-code' | 'codex';

// Existing, accounts.ts:41 — additive only.
interface AccountManagerResult {
  success: boolean;
  error?: string;
  warning?: string;
  needsLogin?: boolean;     // Codex two-phase
  profileId?: string;
  codexHome?: string;
}

interface BeginAccountLoginResult {
  success: boolean;
  error?: string;
  loginId: string;                      // profileId / uuid; pass to status + finalize
  alreadyComplete?: boolean;            // Codex auth was importable; no login needed
  command?: string;                     // e.g. 'claude' | 'codex'
  args?: string[];                      // e.g. ['/login'] | ['login']
  env?: Record<string, string>;         // { CLAUDE_CONFIG_DIR } | { CODEX_HOME } — merge into process.env
  configDir?: string;                   // the isolated profile home (for display)
}

type AccountLoginState = 'pending' | 'authenticated' | 'failed';
interface AccountLoginStatus { state: AccountLoginState; email?: string; error?: string; }

interface FinalizeAccountLoginOptions { activate?: boolean; }   // default true

interface SpawnAccountLoginOptions {
  onStatus?: (s: AccountLoginStatus) => void;
  signal?: AbortSignal;
  timeoutMs?: number;        // default 180_000
  stdio?: 'inherit' | 'pipe';// default 'inherit'
  activate?: boolean;        // default true
  loginCommand?: { command: string; args: string[] };  // override claude/codex invocation
}

// AccountEntry (accounts.ts:23) for Claude; SavedAccountProfile (accountRegistry.ts:14) for Codex.
interface ListAllAccountsResult {
  claude: AccountEntry[];
  codex: SavedAccountProfile[];
  activeByProvider: Record<AccountProviderId, string | null>;
}
```

## Functions

```ts
// Acquisition (Phase 03)
function beginAccountLogin(provider: AccountProviderId, label: string,
  opts?: { loginCommand?: { command: string; args: string[] } }): BeginAccountLoginResult;
function getAccountLoginStatus(provider: AccountProviderId, loginId: string): AccountLoginStatus;
function finalizeAccountLogin(provider: AccountProviderId, loginId: string,
  opts?: FinalizeAccountLoginOptions): AccountManagerResult;
function spawnAccountLogin(provider: AccountProviderId, label: string,
  opts?: SpawnAccountLoginOptions): Promise<AccountManagerResult>;

// Switch / list (Phase 03 wrappers over existing per-provider functions)
function switchAccount(provider: AccountProviderId, id: string): AccountManagerResult;
function listAllAccounts(): ListAllAccountsResult;

// Already shipped (status / read) — re-exported, unchanged:
function getActiveAccountStatus(error?: string): ActiveAccountStatus;   // accountStatus.ts
function listAccounts(): AccountEntry[];                                // accounts.ts:342 (Claude)
function listCodexAccounts(): SavedAccountProfile[];                    // codexProfiles.ts:345

// Switching internals exposed for advanced hosts (Phase 04)
function resolveActiveClaudeHome(): string;
function applyActiveClaudeToLiveHome(): AccountManagerResult;
function reconcileClaudeAuthState(): void;   // idempotent migration; safe to call on startup

// Profile primitives (Phase 01)
function claudeKeychainSuffix(configDir: string): string;
function claudeKeychainService(configDir?: string): string;

// Terminal sync (Phase 05, opt-in)
function installShellHook(): void; function uninstallShellHook(): void; function isShellHookInstalled(): boolean;
function setTerminalActiveProfile(provider: AccountProviderId, home: string | null): void;
function writeLauncher(name: string, provider: AccountProviderId, profileHome: string): void;
function removeLauncher(name: string): void;
```

## Zod schemas (Phase 09, `schemas/accountManager.ts`)

Provide a schema for every wire-crossing shape so consumers validate IPC payloads. Names:
`accountProviderIdSchema`, `accountManagerResultSchema`, `beginAccountLoginResultSchema`,
`accountLoginStatusSchema`, `accountEntrySchema`, `savedAccountProfileSchema`, `listAllAccountsResultSchema`.
Each must `z.infer` to (or be asserted equal to) the TS type above.

## Behavioral contract notes

- **Non-destructive:** `beginAccountLogin` never touches the active account (isolated profile dir).
- **Headless:** `beginAccountLogin` spawns nothing; the host owns the process. `spawnAccountLogin` is the
  convenience path for hosts with a place to run the child (CLI, or a VS Code integrated terminal).
- **Idempotent finalize:** calling `finalizeAccountLogin` twice is safe (registry upsert).
- **Codex OS-keyring:** finalize/switch may return `success:true` with a `warning` when credentials live in
  the OS keyring and can't be file-swapped (`codexProfiles.ts:432/438`). Hosts should surface `warning`.
- **Claude login command** default is `{ command:'claude', args:['/login'] }`, overridable via
  `opts.loginCommand` / `SIDEKICK_CLAUDE_LOGIN_ARGS`. Validate against the installed `claude` (Phase 03/07 risk).
- **Versioning:** additive over `sidekick-shared@0.18.5`; ships in **0.21.0**. Existing functions unchanged.
