# Installation

Get AI completions, agent monitoring, and session intelligence working in under two minutes.

## VS Code Marketplace

Install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max):

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "Sidekick Agent Hub"
4. Click Install

## Open VSX (Cursor, VSCodium, and other forks)

Install from [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max) — the open marketplace used by Cursor, VSCodium, and other VS Code forks.

## Download from GitHub Releases

1. Download the latest `.vsix` file from [Releases](https://github.com/cesarandreslopez/sidekick-agent-hub/releases)
2. In your editor: Extensions → `...` menu → "Install from VSIX..."
3. Select the downloaded file

## Build from Source

```bash
git clone https://github.com/cesarandreslopez/sidekick-agent-hub.git
cd sidekick-agent-hub/sidekick-vscode
npm install
npm run package
```

Then install the generated `.vsix` file as above.

## Cursor-Specific Notes

Cursor has its own AI features that may conflict with Sidekick completions. To use Sidekick in Cursor:

1. Disable Cursor's built-in completions in Cursor Settings if you prefer Sidekick's
2. Or use both side-by-side (Sidekick uses your configured provider tokens, Cursor uses its own)

## Next Steps

After installation, set up your preferred [provider](provider-setup.md) and follow the [Quick Start](quick-start.md) guide.
