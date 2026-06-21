# Phase 06 — Auto-switch on quota threshold (opt-in, OFF by default)

**Workstream:** WS6 · **Package:** `sidekick-shared` (+ CLI/VS Code flags) · **Depends on:** 03, 04
· **Blocks:** 07, 08 (flag wiring)

## Goal

When the **active** account's quota crosses a user-set threshold, switch to the saved account with the most
remaining quota — the ai-switcher "out of quota → auto-switch" behavior (`app_state.rs:759 refresh_tool`).
This ties directly into how the maintainer uses `sidekick quota --provider {claude,codex}`. **Opt-in and off
by default**; never thrash.

## Files to touch

- **New:** `sidekick-shared/src/autoSwitch.ts` (pure policy + a small controller).
- Hook point: `sidekick-shared/src/multiProviderQuotaService.ts` (`onUpdate`:166 / `poll`:257 /
  `getLatest`:180) and/or `quotaPoller.ts` (`QuotaPoller`:50). Prefer subscribing via `onUpdate` rather than
  editing the poller internals.
- `sidekick-shared/src/autoSwitch.test.ts`.

## Step-by-step

1. **Policy (pure, easily tested):**
   ```ts
   interface AutoSwitchConfig { enabled: boolean; thresholdPct: number; } // default { enabled:false, thresholdPct:90 }
   // Given active provider quota + per-account snapshots, decide whether/where to switch.
   function decideAutoSwitch(provider, active, candidates, cfg): { switchTo: string } | null
   ```
   - Return `null` if disabled, if active utilization < threshold, or if no candidate has materially more
     remaining quota. Use the same data behind `sidekick quota`: Claude `QuotaState` 5-hour/7-day utilization
     (`quota.ts`), Codex primary/secondary (`codexQuota.ts`). Per-account snapshots come from
     `readQuotaSnapshot` (`quotaSnapshots.ts`).
2. **Controller:** subscribe to `MultiProviderQuotaService.onUpdate`. On each update, run `decideAutoSwitch`;
   if it returns a target, call `switchAccount(provider, target)` (Phase 03 wrapper). **Emit a one-time
   transition event** and set a cooldown so repeated over-threshold readings don't thrash (mirror
   ai-switcher: notify only on transition).
3. **Config source:** read `AutoSwitchConfig` from a setting (VS Code `sidekick.accounts.autoSwitchThreshold`)
   or CLI flag (`--auto-switch <pct|off>`). The shared layer just takes a config object; the consumers own
   persistence.
4. Guard: only consider candidates that are actually switchable (have credentials / not OS-keyring-only for
   Codex). Skip and log otherwise.

## Acceptance criteria / tests

- `decideAutoSwitch` returns `null` when disabled, when under threshold, and when no candidate is better;
  returns the best candidate when the active account is over threshold and a saved account has more remaining.
- The controller switches at most once per crossing (cooldown), emits a single transition event, and never
  switches when disabled.
- No-op when only one saved account exists.

## Done-when

`npx vitest run src/autoSwitch.test.ts` passes; default config is `{enabled:false}`. Flag/setting wiring is
done in Phases 07/08. Update tracker row 06.
