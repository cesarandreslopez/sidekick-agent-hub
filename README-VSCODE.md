# Sidekick for Max - VS Code Extension

VS Code extension that provides AI-powered inline code completions and transformations using your Claude Max subscription.

## Prerequisites

- **VS Code** v1.85.0 or higher
- **Sidekick Server** running (see [README-SERVER.md](README-SERVER.md))

## Installation

### From Source (Development)

1. Navigate to the extension directory:
   ```bash
   cd sidekick-vscode
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile the extension:
   ```bash
   npm run compile
   ```

4. Open the extension in VS Code:
   ```bash
   code .
   ```

5. Press `F5` to launch the Extension Development Host with the extension loaded.

### Building a VSIX Package

To create an installable package:

```bash
cd sidekick-vscode
npm run compile
npx @vscode/vsce package --out dist/
```

Install the generated `.vsix` file via VS Code:
- Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
- Run "Extensions: Install from VSIX..."
- Select the `.vsix` file

## Features

### Inline Completions

Code completions appear automatically as you type. Suggestions display as "ghost text" that you can:

- **Accept**: Press `Tab` to insert the suggestion
- **Dismiss**: Press `Escape` or continue typing

**Manual Trigger:**
- **Keyboard**: `Ctrl+Shift+Space` (Windows/Linux) or `Cmd+Shift+Space` (Mac)
- **Command Palette**: "Sidekick: Trigger Completion"

### Code Transforms

Transform selected code using natural language instructions:

1. Select the code you want to modify
2. Press `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)
3. Enter your instruction (e.g., "Add error handling", "Convert to async/await")
4. The selection is replaced with the transformed code

### Toggle On/Off

Toggle completions via:

- **Status Bar**: Click "Sidekick" in the bottom-right status bar
- **Command Palette**: "Sidekick: Toggle Inline Completions"

The status bar shows:
- `$(sparkle) Sidekick` - Enabled
- `$(sparkle-off) Sidekick` - Disabled

## Configuration

Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and search for "Sidekick".

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.serverUrl` | `http://localhost:3456` | URL of the Sidekick server |
| `sidekick.enabled` | `true` | Enable/disable inline completions |
| `sidekick.debounceMs` | `300` | Delay before requesting completion (ms) |
| `sidekick.inlineContextLines` | `30` | Lines of context before/after cursor for inline |
| `sidekick.transformContextLines` | `50` | Lines of context before/after selection for transforms |
| `sidekick.multiline` | `false` | Enable multi-line completions |
| `sidekick.inlineModel` | `haiku` | Model for inline: `haiku` (fast) or `sonnet` (quality) |
| `sidekick.transformModel` | `opus` | Model for transforms: `opus`, `sonnet`, or `haiku` |

### Example settings.json

```json
{
  "sidekick.serverUrl": "http://localhost:3456",
  "sidekick.enabled": true,
  "sidekick.debounceMs": 300,
  "sidekick.inlineContextLines": 30,
  "sidekick.transformContextLines": 50,
  "sidekick.multiline": false,
  "sidekick.inlineModel": "haiku",
  "sidekick.transformModel": "opus"
}
```

### Model Selection

**For Inline Completions:**
- **haiku** (default): Faster completions, lower latency. Best for quick suggestions.
- **sonnet**: Higher quality completions. Best for complex code.

**For Transforms:**
- **opus** (default): Highest quality transformations. Best for refactoring.
- **sonnet**: Balanced speed and quality.
- **haiku**: Fastest, lower quality.

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Sidekick: Toggle Inline Completions | Click status bar | Toggle completions on/off |
| Sidekick: Trigger Completion | `Ctrl+Shift+Space` / `Cmd+Shift+Space` | Manually trigger a completion |
| Sidekick: Transform Selected Code | `Ctrl+Shift+M` / `Cmd+Shift+M` | Transform selected code |

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Editor                       │
├─────────────────────────────────────────────────────────┤
│  User types code                                        │
│       │                                                 │
│       ▼                                                 │
│  SidekickInlineCompletionProvider                       │
│       │                                                 │
│       ├──► Debounce (300ms default)                    │
│       │                                                 │
│       ├──► Extract context (prefix + suffix)           │
│       │                                                 │
│       ▼                                                 │
│  POST /inline ───────────────────────► Server           │
│                                                         │
│  Display ghost text ◄─────────────────── Response       │
│       │                                                 │
│       ▼                                                 │
│  User accepts (Tab) or dismisses (Esc)                 │
└─────────────────────────────────────────────────────────┘
```

1. **Context Capture**: The extension captures code around the cursor (configurable lines before/after)
2. **Debouncing**: Requests are debounced to avoid overwhelming the server during rapid typing
3. **Request Cancellation**: Stale requests are automatically cancelled when new keystrokes arrive
4. **Ghost Text**: Completions appear as ghost text that can be accepted with Tab

## Troubleshooting

### No completions appearing

1. **Check the server is running**:
   ```bash
   curl http://localhost:3456/health
   ```

2. **Verify extension is enabled**:
   - Check status bar shows `$(sparkle) Sidekick`
   - Check Settings: `sidekick.enabled` is `true`

3. **Check VS Code Output**:
   - Open Output panel (`Ctrl+Shift+U` / `Cmd+Shift+U`)
   - Select "Extension Host" from dropdown
   - Look for "Sidekick" messages

### Slow completions

- Reduce `inlineContextLines` to send less context
- Use `haiku` model instead of `sonnet`
- Increase `debounceMs` to reduce request frequency

### Server connection errors

- Verify `serverUrl` matches where your server is running
- Check for firewall or proxy issues
- Ensure server has CORS headers (built-in by default)

## Development

### Watch Mode

Compile automatically on file changes:

```bash
npm run watch
```

### Running Tests

```bash
npm test
```

### Linting

```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

## File Structure

```
sidekick-vscode/
├── src/
│   ├── extension.ts       # Main extension entry point
│   └── extension.test.ts  # Tests
├── package.json           # Extension manifest & configuration
├── tsconfig.json          # TypeScript configuration
└── out/                   # Compiled JavaScript (generated)
```
