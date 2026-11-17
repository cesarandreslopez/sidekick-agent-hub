# Demo recordings

Scripts that record the GIFs and screenshots in the READMEs and on the docs site. They drive the real products, the `sidekick` CLI in a terminal and the VS Code extension, against an invented session in a sandbox, so nothing from your machine appears on screen. This folder is a private package: it is not published and none of the three shipped packages depend on it.

## Regenerate everything

Prerequisites (macOS): Node.js 22+, VS Code in `/Applications`, and `brew install ttyd gifski pngquant`. The products must be built first (`bash scripts/build-all.sh` from the repo root).

```bash
cd demo
npm install
node record.mjs        # the three clips → out/<clip>/final/{<clip>.gif,<clip>.mp4,stills/}
node shots.mjs         # extra stills for the docs → out/screenshots/final/stills/
node review.mjs        # out/review.html: every clip, still and the GIF it replaces, for a human look
node sync.mjs          # approved files → assets/demo/v1/ and docs/images/demo/v1/
```

`node record.mjs cli-dashboard` records one clip (`cli-dashboard`, `map-follow`, `vscode-tour`). `node lib/generate.mjs` builds the sandbox without recording, which is handy for looking around with `HOME=/tmp/acme` and the environment from `lib/sandbox.mjs`.

**Always look at every frame before syncing.** The leak check (below) reads on-screen text only.

## How it works

| Piece                              | What it does                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scenario/storefront.mjs`          | The demo session: a believable afternoon on an invented TypeScript shop API, three prompts, a subagent, a failing test, a hook, an MCP call. Turns marked `live` are played during the take.                                                                 |
| `lib/generate.mjs`                 | Writes the scenario as Claude Code session files with usage shaped like real sessions, plus 18 days of smaller backdated sessions, project stores and the history import.                                                                                    |
| `lib/sandbox.mjs`                  | A fake home at `/tmp/acme`: explicit `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`SIDEKICK_CONFIG_DIR`, stub `security`/`claude`/`codex`/`open` binaries, example.com accounts with health metadata, a fresh status-line quota sample and an obviously fake demo login. |
| `lib/net-shim.mjs`, `vscode-shim/` | Network for sandboxed processes: status pages answer "operational", the Claude usage endpoint answers the demo quota, everything else fails. VS Code strips `NODE_OPTIONS` from its extension host, so a recording-only extension does the same there.       |
| `lib/feeder.mjs`                   | Appends the live turn while recording, one whole line per write, stamped with the wall clock, so the dashboards see a session that is running now.                                                                                                           |
| `lib/terminal.mjs`                 | The real TUI in ttyd/xterm.js inside Chromium, at 2560×1440 CSS px with a bundled font, plus a caption band under the terminal.                                                                                                                              |
| `lib/vscode.mjs`                   | The real VS Code under Playwright's Electron driver, with the packaged `.vsix` installed into the sandbox's own extensions folder.                                                                                                                           |
| `lib/overlay.mjs`                  | Captions, keycap chips and a drawn pointer with click ripples (the real pointer never shows in a screencast).                                                                                                                                                |
| `lib/recorder.mjs`, `encode.swift` | CDP screencast frames with their arrival times → an MP4 with eased camera moves cropped from the 2× frames, PNG stills, and a gifski GIF that fades back to its first frame so it loops cleanly.                                                             |
| `lib/leakcheck.mjs`                | Fails a take if on-screen text contains your username, home folder, a non-example.com email or a private project name.                                                                                                                                       |
| `directors/*.mjs`                  | One script per clip: the beats, keys, clicks, captions and camera. See `STORYBOARD.md`.                                                                                                                                                                      |

## Rules

- **No voiceovers.** Captions only, five words or fewer, in the band under the terminal or over the editor.
- **Frame 0 is the poster.** Every clip starts on a busy, populated screen, because a GIF shows its first frame before it plays.
- **Nothing real on screen.** Only the sandbox, `@example.com` accounts and the `storefront` project.
- **Versioned folders.** A new set of recordings goes to `v2/`. Never rename or delete old files under `assets/`: every published README (npm, Marketplace, Open VSX) keeps loading the files that existed when it shipped.
- **Re-record for UI changes.** When a release changes what these views look like, re-run this folder before the release.
