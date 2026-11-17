# Storyboard

Silent clips, captions of five words or fewer, first frame busy. The live turn of `scenario/storefront.mjs` ("Add a test for the Retry-After header, then open a PR.") plays during every take, so the views move on camera.

## `cli-dashboard` (hero, about 18 s)

Root README hero, npm README, docs home and CLI guide.

| Beat | On screen                                                                               | Keys       | Caption                             | Camera          |
| ---- | --------------------------------------------------------------------------------------- | ---------- | ----------------------------------- | --------------- |
| 1    | Sessions › Summary following the live session: tokens, cost, context and burn rate tick | —          | See every tool call                 | wide            |
| 2    | Summary scrolled to quota (5h / 7d with projections) and the billing block              | `Tab`, `G` | Know what it costs                  | in on quota     |
| 3    | Map panel: stations light up as calls run, faults stay                                  | `9`        | What the agent touches              | wide            |
| 4    | Map › Insights: where the time went, patterns, faults                                   | `⏎`, `]`   | Where the time went                 | in on the table |
| 5    | Accounts overlay: two Claude Code accounts and one Codex account, all fresh             | `esc`, `A` | Switch accounts without logging out | wide            |

## `map-follow` (about 10 s)

Root README terminal section, activity map docs.

| Beat | On screen                                                    | Keys | Caption                      |
| ---- | ------------------------------------------------------------ | ---- | ---------------------------- |
| 1    | `sidekick map --follow`: the live map with its activity feed | —    | sidekick map --follow        |
| 2    | Insights instead of the feed: faults, retries, slowest steps | `i`  | Retries and slow steps, live |

## `vscode-tour` (about 18 s)

Root README VS Code section, Marketplace/Open VSX README, docs home and quick start. Before recording: the sidebar is widened, the Sessions list folded, and the Activity Map opened in an editor tab, so the first frame shows both.

| Beat | On screen                                                                                | Pointer                          | Caption                      | Camera           |
| ---- | ---------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------- | ---------------- |
| 1    | Session Analytics (context and quota gauges) beside the live Activity Map                | hidden                           | Quota and context, live      | wide             |
| 2    | History tab: usage across the last seven days with the previous period                   | clicks History                   | Usage across days            | wide             |
| 3    | The activity map, closer                                                                 | hidden                           | Every tool call, mapped      | in on the editor |
| 4    | Accounts view expanded; hovering the Personal account shows its switch button and health | clicks Accounts, hovers Personal | Switch accounts in one click | wide             |

## Stills (`shots.mjs`)

Captured from the same sandbox, mid-way through the live turn so the boards show work in every column: CLI Events, Charts and Kanban panels; the HTML report; VS Code Cost view, Kanban, Mind Map and Project Timeline.
