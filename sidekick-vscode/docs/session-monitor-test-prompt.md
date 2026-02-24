# Session Monitor Test Prompt

> **Usage:** Copy everything below the line into a Claude Code or OpenCode session.
> The prompt exercises every Sidekick monitoring view: Session Analytics
> (including the Decisions panel), Kanban Board, Mind Map (including plan
> visualization), Latest Files Touched, Subagents, and Session Intelligence
> features (context health, goal gates, truncation, cycle detection).

---

## Instructions

Follow each section in order. Do not skip ahead. Every tool call you make
generates telemetry that Sidekick's Session Monitor uses to populate its views.

### Section 1 — File Operations (Latest Files Touched + Mind Map file/directory nodes)

1. Create three source files inside a `src/` directory:

   - `src/math.ts` — export functions `add(a: number, b: number)` and `multiply(a: number, b: number)` with implementations.
   - `src/strings.ts` — export functions `capitalize(s: string)` and `reverse(s: string)` with implementations.
   - `src/index.ts` — re-exports everything from `math.ts` and `strings.ts`.

   Use the **Write** tool for each file.

2. Use **Read** to read back `src/math.ts`.

3. Use **Edit** to add a `subtract(a: number, b: number)` function to `src/math.ts`.

4. Use **Glob** to list all `*.ts` files under `src/`.

5. Use **Grep** to search for the pattern `export function` across `src/`.

### Section 2 — Deliberate Errors (Session Analytics error tracking)

Generate each of these errors so the Session Monitor can categorize them:

1. **File not found** — Use **Read** to read `src/does-not-exist.ts`.

2. **Non-zero exit code** — Use **Bash** to run: `exit 42`

3. **Syntax error** — Use **Write** to create `src/bad.ts` with content:
   ```
   const x: number = "oops"
   function broken( { return 1 }
   ```
   Then use **Bash** to run: `npx tsc --noEmit src/bad.ts`
   (This will fail with a TypeScript syntax error.)

4. **Permission denied** — Use **Bash** to run:
   ```bash
   chmod 000 src/bad.ts && cat src/bad.ts
   ```
   Then restore permissions: `chmod 644 src/bad.ts`

### Section 3 — Task Lifecycle (Kanban Board)

Create and manage tasks with dependencies:

1. Use **TaskCreate** to create these three tasks:
   - Task A: subject "Write unit tests for math module", description "Create tests for add, subtract, and multiply in math.ts", activeForm "Writing math tests"
   - Task B: subject "Write unit tests for strings module", description "Create tests for capitalize and reverse in strings.ts", activeForm "Writing string tests"
   - Task C: subject "Create integration test", description "Test that index.ts re-exports work correctly", activeForm "Writing integration test"

2. Use **TaskUpdate** to make Task C blocked by both Task A and Task B.

3. Use **TaskUpdate** to mark Task A as `in_progress`.

4. Use **Write** to create `src/math.test.ts` with basic test stubs (describe blocks with test cases for add, subtract, multiply).

5. Use **TaskUpdate** to mark Task A as `completed`.

6. Use **TaskUpdate** to mark Task B as `in_progress`.

7. Use **Write** to create `src/strings.test.ts` with basic test stubs (describe blocks with test cases for capitalize, reverse).

8. Use **TaskUpdate** to mark Task B as `completed`.

9. Task C should now be unblocked. Use **TaskUpdate** to mark Task C as `in_progress`.

10. Use **Write** to create `src/index.test.ts` with a basic integration test stub.

11. Use **TaskUpdate** to mark Task C as `completed`.

### Section 3A — Goal Gate Tasks (Kanban Board + Mind Map + Handoff)

Goal gates are high-priority tasks that must be completed before handoff. They are
detected by keyword matching or by blocking multiple downstream tasks.

1. Use **TaskCreate** to create a goal-gate task detected by **keyword**:
   - subject: "CRITICAL: Fix authentication before deploy"
   - description: "Authentication is broken in production. This must be resolved before any other work proceeds."
   - activeForm: "Fixing authentication"

   The keyword regex is: `/\b(CRITICAL|MUST|blocker|required|must.?complete|goal.?gate|essential|do.?not.?skip|blocking)\b/i`

2. Use **TaskCreate** to create three dependent tasks:
   - Task D: subject "Update user profile page", description "Depends on auth fix", activeForm "Updating profile page"
   - Task E: subject "Add logout button", description "Depends on auth fix", activeForm "Adding logout button"
   - Task F: subject "Write auth integration tests", description "Depends on auth fix", activeForm "Writing auth tests"

3. Use **TaskCreate** to create a goal-gate task detected by **blocking count**:
   - subject: "Set up CI pipeline", description: "Pipeline must be ready before feature work begins", activeForm: "Setting up CI"

4. Use **TaskUpdate** to make Tasks D, E, and F all blocked by the "Set up CI pipeline" task.
   (A task blocking 3+ others is automatically flagged as a goal gate.)

5. Use **TaskUpdate** to mark the "CRITICAL: Fix authentication" task as `completed`.
   Leave "Set up CI pipeline" as `pending` so the handoff will flag it as incomplete.

**What to verify:**
- **Kanban Board**: Goal-gate cards show a red left border and a warning icon (⚠️)
- **Mind Map**: Goal-gate task nodes have distinct visual treatment (red border or badge)
- **Handoff**: Generate a handoff — the markdown includes a "CRITICAL: Incomplete Goal Gates" section listing the incomplete "Set up CI pipeline" task

### Section 3B — Error Burst & Retry Patterns (Session Analytics + Notifications)

Exercise the error detection systems that flag inefficient agent behavior.

#### Error burst (3+ consecutive tool errors)

1. Use **Read** to read `src/nonexistent-1.ts` (will fail — file not found)
2. Use **Read** to read `src/nonexistent-2.ts` (will fail)
3. Use **Read** to read `src/nonexistent-3.ts` (will fail)

This triggers an error burst notification after the third consecutive error.

#### Command failure inefficiency (same Bash command fails 3+ times)

4. Use **Bash** to run: `npm run nonexistent-script` (will fail)
5. Use **Bash** to run: `npm run nonexistent-script` (will fail again)
6. Use **Bash** to run: `npm run nonexistent-script` (will fail a third time)

#### Retry loop inefficiency (consecutive fail pairs on same target)

7. Use **Read** to read `src/phantom-file.ts` (will fail)
8. Use **Read** to read `src/phantom-file.ts` (will fail again — same file, back-to-back)

**What to verify:**
- **Notification**: VS Code warning notification appears after the error burst (step 3)
- **Session Analytics → Inefficiencies**: Panel shows `command_failure` entry (steps 4-6) and `retry_loop` entry (steps 7-8)

> **Note:** The files read in this section don't exist, so no cleanup is needed.

### Section 3C — Cycle Detection (Mind Map + Notifications)

Exercise the cycle detector by creating a repeating Read→Edit pattern on the same
file. The detector looks for a pattern of length 2 repeated 3 times within a window
of 6 tool calls.

1. Use **Read** to read `src/math.ts`
2. Use **Edit** to add a comment `// cycle test 1` at the top of `src/math.ts`
3. Use **Read** to read `src/math.ts`
4. Use **Edit** to change the comment to `// cycle test 2` in `src/math.ts`
5. Use **Read** to read `src/math.ts`
6. Use **Edit** to change the comment to `// cycle test 3` in `src/math.ts`

**What to verify:**
- **Notification**: VS Code warning notification about agent cycling on `src/math.ts`
- **Mind Map**: The `src/math.ts` file node shows a cycling indicator (animated border or badge)

> **Provider note:** Cycle detection works identically across all three providers
> since it operates on normalized `ToolCall` data from the session pipeline.

### Section 4 — Plan Analytics (Dashboard plan section + Mind Map plan subgraph)

Exercise plan mode so the Dashboard shows the Plan Progress section and the Mind Map
renders enriched plan nodes. The plan markdown uses complexity keywords that trigger
automatic complexity detection, and the tool calls made between EnterPlanMode and
ExitPlanMode are attributed to plan steps for token/tool call tracking.

1. Use **EnterPlanMode** to start a planning session.

2. While in plan mode, output a structured plan using checkbox markdown. Write it
   as your assistant response (do **not** use a tool — the plan content comes from
   your text output). Use this exact format — note the complexity keywords:

   ```
   ## Refactor Plan

   ### Phase 1: Analysis
   - [ ] Read all existing source files
   - [ ] Identify shared utility functions

   ### Phase 2: Implementation
   - [ ] Refactor and extract shared utilities into src/utils.ts [high]
   - [ ] Update math.ts imports
   - [ ] Update strings.ts imports

   ### Phase 3: Validation
   - [x] Run existing tests
   - [ ] Fix any broken import paths
   ```

3. Use **ExitPlanMode** to complete the planning cycle.

4. Now simulate plan step execution by doing real work that gets attributed to the
   plan. Use **Read** to read `src/math.ts`, then use **Read** to read `src/strings.ts`,
   then use **Grep** to search for `export` in `src/`. These tool calls generate
   token usage and tool call counts that are attributed to the active plan.

5. Use **Write** to create `src/utils.ts` with a shared utility function:
   ```typescript
   export function clamp(value: number, min: number, max: number): number {
     return Math.min(max, Math.max(min, value));
   }
   ```

**What to verify in Dashboard (Plan Progress section):**
- **Plan Progress** section appears between latency stats and "Improve Agent Guidance"
- Plan title shows "Refactor Plan"
- Progress bar shows completion percentage (1/7 = ~14% since "Run existing tests" is pre-checked)
- Step list shows status icons: ✓ for completed, ○ for pending
- Steps show metadata: complexity indicator ("high" for the refactor step), and
  after step 4-5, token counts and tool call counts appear on steps
- Stats line shows step count, completion percentage

**What to verify in Mind Map:**
- A teal **Plan** root node labeled "Refactor Plan" with completion stats in tooltip
  (e.g., "Refactor Plan (1/7 steps, 14%)")
- Seven **plan-step** nodes connected to the plan root
- **Complexity color coding**: the "Refactor and extract..." step renders in **red**
  (high complexity); the "Fix any broken..." step renders in **green** (low complexity,
  since "fix" is a low-complexity keyword); other steps remain default teal
- **Token-based sizing**: steps with more attributed tokens appear slightly larger
- **Enriched tooltips**: hover a plan-step node to see complexity, duration, and
  token count in addition to status
- Dashed teal **sequence links** between consecutive steps
- Steps carry status coloring: completed steps appear dimmed; pending steps have
  a yellow stroke; failed steps (if any) show red stroke
- If tasks from Section 3 are still visible, plan steps whose descriptions match
  task subjects will have cross-reference links (dashed orange) to those task nodes

**What to verify in Plan History (below Plan Progress):**
- If this is not your first test session, a **Plan History** section appears showing
  stats from previous sessions' plans (total plans, completion rate, avg duration)
- Recent plans listed with title, status, completion %, step count, and date

> **OpenCode note:** In OpenCode, plan content appears inside `<proposed_plan>` XML
> tags in assistant messages rather than via `EnterPlanMode`/`ExitPlanMode` tool calls.
> The parser extracts and structures the inner markdown identically.
>
> **Codex note:** Codex uses `UpdatePlan` tool calls with a structured `{ step, status }[]`
> array. These are mapped directly to plan steps (no markdown parsing) and also appear
> as task nodes on the Kanban Board.

### Section 5 — Decision Extraction (Session Analytics → Decisions panel)

Exercise all four decision extraction sources so the Decisions section populates:

1. **Recovery pattern** — Trigger a failure-then-success recovery:
   - Use **Bash** to run: `npm install --no-package-lock nonexistent-pkg-abc123` (will fail)
   - Use **Bash** to run: `echo "Fallback: skipping nonexistent package"` (succeeds)

2. **Plan mode** — The plan mode cycle from Section 4 above already generates a
   plan-mode decision entry. No additional action needed here; just verify the
   decision appears.

3. **User question** — Ask the user to choose between options:
   - Use **AskUserQuestion** with:
     - question: "Which test framework should we use?"
     - options: `["Vitest", "Jest", "Mocha"]`

4. **Text pattern** — In your next response, include a decision statement like:
   "I'll use Vitest because it has native ESM support and faster execution."

After completing these steps, open Session Analytics → scroll to the **Decisions** section.
You should see entries with source badges: `recovery pattern`, `plan mode`, `user question`, and `text pattern`.
Use the search box to filter by keyword (e.g., "vitest").

### Section 6 — Bash Commands & Search (Mind Map command/URL nodes + Session Analytics)

1. Use **Bash** to run: `wc -l src/*.ts`

2. Use **Bash** to run: `ls -la src/`

3. Use **WebSearch** to search for: `TypeScript vitest describe block syntax`

4. Use **Bash** to create a summary file:
   ```bash
   echo "Test run complete at $(date)" > summary.txt
   ```

5. Use **Read** to read `summary.txt`.

### Section 7 — Subagents (Subagent Tree + Mind Map subagent nodes)

Spawn three subagents using the **Task** tool. Each must use a different `subagent_type` so the Subagent Tree classifies them differently:

1. **Explore agent** — subagent_type `Explore`, prompt: "List all TypeScript files in src/ and report how many export statements each file contains."

2. **Plan agent** — subagent_type `Plan`, prompt: "Read the files in src/ and design a plan for adding a divide function to math.ts with error handling for division by zero."

3. **Bash agent** — subagent_type `Bash`, prompt: "Run `wc -l` on every .ts file in src/ and report the total line count."

Wait for all three to complete before continuing.

### Section 8 — Cleanup

Delete the files created during this test:

```bash
rm -f src/math.ts src/strings.ts src/index.ts src/bad.ts src/math.test.ts src/strings.test.ts src/index.test.ts summary.txt
rmdir src/ 2>/dev/null
```

> **Note:** The nonexistent files from Section 3B (`src/nonexistent-*.ts`,
> `src/phantom-file.ts`) were never created, so no cleanup is needed for them.
> Tasks from Sections 3 and 3A are in-memory only and reset with the session.

Then say: "Session monitor test complete. All Sidekick views should now have data."

---

## View Coverage Reference

| View | Sections that exercise it |
|---|---|
| **Session Analytics** | All sections (token usage, tool success/failure rates, timeline, context) |
| **Session Analytics → Decisions** | Section 5 (recovery patterns, plan mode, user questions, text patterns) |
| **Session Analytics → Inefficiencies** | Section 3B (error burst, command failure, retry loop), Section 3C (cycle detection) |
| **Dashboard → Context Health** | Section 3B note: context health displays after compaction — hard to trigger in a short test, but verify the gauge element exists |
| **Dashboard → Truncation Count** | Truncation requires tool output with specific markers — verified by unit tests; element visibility can be confirmed in Dashboard |
| **Kanban Board** | Section 3 (TaskCreate, TaskUpdate lifecycle with blockedBy) |
| **Kanban Board → Goal Gates** | Section 3A (red border + warning icon on goal-gate cards) |
| **Mind Map** | Section 1 (file + directory nodes), Section 4 (plan + plan-step nodes), Section 6 (command + URL nodes), Section 7 (subagent nodes) |
| **Dashboard → Plan Progress** | Section 4 (progress bar, step list with status/complexity/tokens, plan stats) |
| **Dashboard → Plan History** | Section 4 note: appears on subsequent test runs showing historical plan stats |
| **Mind Map → Plan Subgraph** | Section 4 (plan root, plan-step nodes with complexity colors, token sizing, enriched tooltips, sequence links, task cross-refs) |
| **Mind Map → Goal Gates** | Section 3A (distinct visual treatment on goal-gate task nodes) |
| **Mind Map → Cycling Files** | Section 3C (cycling indicator on file nodes caught in repetitive loops) |
| **Latest Files Touched** | Section 1 (Write, Read, Edit), Section 2 (Write, Bash), Section 3 (Write) |
| **Subagents** | Section 7 (Explore, Plan, Bash agent types) |
| **Handoff → Goal Gates** | Section 3A ("CRITICAL: Incomplete Goal Gates" section in handoff markdown) |
| **Handoff → Plan Progress** | Section 4 (handoff includes "Plan Progress" section with completed/remaining steps) |

## Tools Used

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Task`, `TaskCreate`, `TaskUpdate`, `WebSearch`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`
