# Session Monitor Test Prompt

> **Usage:** Copy everything below the line into a Claude Code or OpenCode session.
> The prompt exercises every Sidekick monitoring view: Session Analytics
> (including the Decisions panel), Kanban Board, Mind Map (including plan
> visualization), Latest Files Touched, and Subagents.

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

### Section 4 — Plan Visualization (Mind Map plan subgraph)

Exercise plan mode so the Mind Map renders a plan root node with plan-step children.
The assistant text during plan mode is parsed for checkboxes, numbered lists, and
phase headers. After exiting plan mode, check the Mind Map for teal-colored plan
nodes connected by dashed sequence links.

1. Use **EnterPlanMode** to start a planning session.

2. While in plan mode, output a structured plan using checkbox markdown. Write it
   as your assistant response (do **not** use a tool — the plan content comes from
   your text output). Use this exact format:

   ```
   ## Refactor Plan

   ### Phase 1: Analysis
   - [ ] Read all existing source files
   - [ ] Identify shared utility functions

   ### Phase 2: Implementation
   - [ ] Extract shared utilities into src/utils.ts
   - [ ] Update math.ts imports
   - [ ] Update strings.ts imports

   ### Phase 3: Validation
   - [x] Run existing tests
   - [ ] Add tests for new utils module
   ```

3. Use **ExitPlanMode** to complete the planning cycle.

**What to verify in Mind Map:**
- A teal **Plan** root node labeled "Refactor Plan" connected to session root
- Seven **plan-step** nodes (one per checkbox item) connected to the plan root
- Dashed teal **sequence links** between consecutive steps (step-0 → step-1 → … → step-6)
- Steps carry status coloring: completed steps (step 5, "Run existing tests") appear
  dimmed; pending steps have a yellow stroke
- Hovering a step node shows its description and status in the tooltip
- The legend includes a "Plan" entry with a teal dot
- If tasks from Section 3 are still visible, plan steps whose descriptions match
  task subjects will have cross-reference links (dashed orange) to those task nodes

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

Then say: "Session monitor test complete. All Sidekick views should now have data."

---

## View Coverage Reference

| View | Sections that exercise it |
|---|---|
| **Session Analytics** | All sections (token usage, tool success/failure rates, timeline, context) |
| **Session Analytics → Decisions** | Section 5 (recovery patterns, plan mode, user questions, text patterns) |
| **Kanban Board** | Section 3 (TaskCreate, TaskUpdate lifecycle with blockedBy) |
| **Mind Map** | Section 1 (file + directory nodes), Section 4 (plan + plan-step nodes), Section 6 (command + URL nodes), Section 7 (subagent nodes) |
| **Mind Map → Plan Subgraph** | Section 4 (plan root, plan-step nodes with status, sequence links, task cross-refs) |
| **Latest Files Touched** | Section 1 (Write, Read, Edit), Section 2 (Write, Bash), Section 3 (Write) |
| **Subagents** | Section 7 (Explore, Plan, Bash agent types) |

## Tools Used

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Task`, `TaskCreate`, `TaskUpdate`, `WebSearch`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`
