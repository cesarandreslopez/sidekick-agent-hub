# sidekick-shared

Internal shared library for [Sidekick Agent Hub](https://github.com/cesarandreslopez/sidekick-agent-hub). Provides data access, types, and session provider logic used by both the VS Code extension and the CLI dashboard.

This package is not published independently — it is consumed by `sidekick-vscode` and `sidekick-cli` at build time.

## Building

```bash
cd sidekick-shared
npm install
npm run build
```

Or build everything (shared + CLI) at once:

```bash
bash scripts/build-all.sh
```

## Testing

```bash
cd sidekick-shared
npm test
```

## License

MIT
