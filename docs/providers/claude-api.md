# Claude API

Direct Anthropic API access with per-token billing.

## Setup

1. Run **"Sidekick: Set API Key"** from the Command Palette
2. Enter your Anthropic API key
3. Set `sidekick.inferenceProvider` to `claude-api` in settings

## How It Works

- Uses `@anthropic-ai/sdk` with your API key
- Per-token billing — costs depend on usage
- API key stored securely in VS Code's secret storage

## Session Monitoring

Claude API mode does not include session monitoring (there are no CLI sessions to monitor). Session monitoring is only available for Claude Code, OpenCode, and Codex CLI.

## Best For

- Users without a Claude Max subscription
- Low-volume usage where per-token cost is acceptable
- CI/CD or automated workflows

## Troubleshooting

### API key issues

- Run **"Sidekick: Set API Key"** to update your key
- Ensure your API key has sufficient credits
- Run **"Sidekick: Test Connection"** to verify connectivity
