# Sidekick Agent Hub — Review Backlog & Fix Spec

This directory is a **worklist for fixing 143 findings** from a full-repo review of `sidekick-cli`, `sidekick-vscode`, and `sidekick-shared` (2026-07-21). It is written so a fresh agent with no prior context can pick up any phase, execute it, and track progress in-place.

Every finding carries its own evidence (quoted code), a concrete fix, and a trust level. Work top-down by phase; within a phase, work high → medium → low.

---

## How to use this spec (the working loop)

1. **Pick the lowest-numbered phase that isn’t done.** Open its file (linked below). Phases are ordered by user harm, and later phases assume earlier fixes exist (e.g. Phase 2 reuses the `fetchWithTimeout` helper; Phase 5 consolidation assumes the shared APIs it imports are the good ones).
2. **Read the phase’s Progress tracker table**, then work each finding in order.
3. **For every finding, before editing:**
   - Re-open the cited `file:line` — the review is a snapshot; line numbers may have drifted. Search by the quoted evidence, not the line number.
   - If the finding is 🟡 plausible or ⚠️ unverified, **confirm the failure is real and reachable first.** If it doesn’t hold up, set its Status to `[-]` with a one-line reason and move on. (During the review, 15/15 manually re-checked highs held — but the unverified tail was never adversarially tested, so treat it as a lead, not a verdict.)
4. **Make the fix**, matching surrounding code style. Add a co-located `*.test.ts` (Vitest) that fails before and passes after — this is required for behavioral fixes.
5. **Update tracking in two places:** the finding’s `**Status:**` line and its row in the phase’s Progress tracker table (`[ ]` → `[~]` → `[x]`). Fill in the Verification line with what you tested.
6. **At phase end, run the gates** (see _Verification gates_ below) and update this README’s master table.

One finding = one focused change. Batch a phase into a PR (or two if it’s large), using Conventional Commits with a `fix/` (or `refactor/`, `perf/`, `chore/`) branch.

---

## Trust levels

| Badge                          | Meaning     | How it was reached                                                                                                                             |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ confirmed (2 verifiers)     | 50 findings | Survived two independent adversarial verifiers (one checked the code behaves as claimed, one checked the failure is reachable with real data). |
| ✅ confirmed (manual read)     | 15 findings | High-severity items whose verifier agents died on a session limit; re-read and confirmed by hand against callers/guards.                       |
| 🟡 plausible (1 verifier)      | 24 findings | One verifier confirmed; the second was unavailable. Mostly low-severity.                                                                       |
| ⚠️ unverified — re-check first | 54 findings | Medium/low findings whose verifier agents hit the session limit before voting. **Not** proven false — just untested. Re-verify before fixing.  |

8 findings were **refuted** by actual verifier votes and are intentionally absent from this spec.

> **Methodology.** A 288-agent workflow: 13 area-scoped reviewers deep-read ~96k lines and produced 152 raw findings; each went to adversarial verification. Full provenance (per-finding verifier reasoning, the workflow journal, and a resumable run to finish the unverified tail) lives outside the repo at `~/.claude/plans/sidekick-review-2026-07-21/` and `~/.claude/plans/review-sidekick-cli-and-the-async-reddy.md`. You do **not** need those to work this spec — every finding is self-contained here — but they’re the audit trail if a claim looks wrong.

---

## Master progress

Update the Done column as phases complete.

| Phase                                                | Focus                                 | Findings (H/M/L)   | Done  |
| ---------------------------------------------------- | ------------------------------------- | ------------------ | ----- |
| [Phase 1](./phase-1-security-and-data-integrity.md)  | Security & data integrity             | 20 (6/10/4)        | `[x]` |
| [Phase 2](./phase-2-crashes-and-hangs.md)            | Crashes & hangs                       | 24 (7/16/1)        | `[x]` |
| [Phase 3](./phase-3-cli-dashboard-and-ux.md)         | CLI dashboard & terminal UX           | 28 (6/12/10)       | `[x]` |
| [Phase 4](./phase-4-session-pipeline-and-webview.md) | Session pipeline, watchers & webviews | 34 (3/23/8)        | `[x]` |
| [Phase 5](./phase-5-cross-package-and-release.md)    | Cross-package consolidation & release | 25 (1/12/12)       | `[x]` |
| [Phase 6](./phase-6-polish-and-verification.md)      | Polish & remaining verification       | 12 (0/0/12)        | `[x]` |
| **Total**                                            |                                       | **143 (23/73/47)** |       |

Severity totals across all phases: **23 high · 73 medium · 47 low.**

### Highest-impact items (start here if triaging by severity, not phase)

- **Injection/XSS** — `GitService` spawns git with `shell:true` around a user-typed base branch (P1); shared `openInBrowser` shell-string command injection (P1); dashboard timeline `[more]` round-trips escaping away into `innerHTML` (P1); shared markdown report renders `javascript:`/`data:` URLs (P1).
- **Wrong numbers shown to the user** — historical session totals double-counted into all-time buckets on every VS Code restart (P1); Codex cache tokens double-counted (P1); Opus 4.5 priced at 3× (P1).
- **Crashes on real data** — message-less summary events crash `sessionContext` / `toolCall` extraction, and every _resumed_ Claude session begins with a summary row (P2).
- **CLI dashboard** — quota-failure text renders one character per line (P3); `today` date filter hides today in every UTC-negative timezone (P3); model IDs silently squashed to `haiku` in two inference clients (P2).
- **Product decision** — the dashboard’s quota-history / context-health / truncation UI is dead code: handlers live in a webview bundle no `<script>` tag ever loads (P4). Someone must decide wire-up vs delete.

---

## Global conventions & constraints (read before committing)

These come from the repo’s own rules and maintainer preferences — violating them breaks releases or gets reverted:

- **`sidekick-shared` is a published npm API** consumed by an external project pinned to an old version. **No breaking changes to its exports** — additive only. Phase 5 consolidation moves the _extension_ onto shared APIs, never the reverse.
- **Lint all three packages before considering a phase done.** Run `npm run lint` in `sidekick-shared/`, `sidekick-vscode/`, and `sidekick-cli/` (CI lints each separately; a shared-only error blocks the npm publish). `bash scripts/lint-all.sh` does all three.
- **Tests are Vitest, co-located** (`Foo.ts` ↔ `Foo.test.ts`). The `vscode` module is mocked with `vi.mock("vscode", …)`. Add a regression test with every behavioral fix.
- **Commits:** Conventional Commits (`fix(scope):`, `perf(scope):`, `refactor(scope):`). **No `Co-Authored-By` trailer for Claude** — this repo credits humans only.
- **Changelogs stay in sync:** the root `CHANGELOG.md`, the three package changelogs, and `docs/changelog.md`. Don’t rewrite a shipped version’s section — add a new one. Don’t leave an orphan `[Unreleased]` heading after a release.
- **Version bumps are the maintainer’s call** — lean patch; don’t auto-apply “feature = minor”. Don’t bump versions as part of these fixes unless asked.
- **Docs site uses `zensical`, not `mkdocs`.**

## Verification gates (run at the end of each phase)

1. `bash scripts/lint-all.sh` — clean across all three packages.
2. `npm test` in each package that the phase touched (`sidekick-shared/` builds before it tests).
3. `bash scripts/build-all.sh` — all three build; CLI binary lands at `sidekick-cli/dist/sidekick-cli.mjs` and `node sidekick-cli/dist/sidekick-cli.mjs --help` runs.
4. **Smoke the surface you changed:**
   - CLI: `node sidekick-cli/dist/sidekick-cli.mjs dashboard` against a live Claude Code session — quota text wraps, `today` filter shows today, click targets land on the clicked row.
   - Extension: press **F5** for the Extension Development Host — dashboard renders; after Phase 4, the quota-history/context-health sections actually appear; timeline `[more]` shows escaped content.
5. Update the finding Status lines, the phase Progress tracker, and this README’s master table.

---

## Layout

```
spec/
  README.md                                  ← you are here (index, methodology, conventions, master tracker)
  phase-1-security-and-data-integrity.md
  phase-2-crashes-and-hangs.md
  phase-3-cli-dashboard-and-ux.md
  phase-4-session-pipeline-and-webview.md
  phase-5-cross-package-and-release.md
  phase-6-polish-and-verification.md
```

Each phase file has: a Progress tracker table (checkbox per finding) and a Findings section where every entry is `ID · location · severity · trust · Problem · Evidence · Fix · (re-verify note if applicable) · Verification`. Finding IDs are stable (`P<phase>-<n>`) — cite them in commits and PRs (e.g. `fix(shared): guard message-less summary events (P2-01)`).
