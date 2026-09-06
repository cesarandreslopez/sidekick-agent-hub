# Contributing

Contributions are welcome! Whether it's bug fixes, new features, or documentation improvements.

## Getting Started

### Prerequisites

- Node.js 22 recommended for development (release CI uses Node 20 for the extension and Node 22 for the shared library and CLI)
- VS Code 1.85+
- At least one provider set up (Claude Max recommended)

### Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/cesarandreslopez/sidekick-agent-hub.git
   cd sidekick-agent-hub
   ```

2. Build all packages from the repository root (shared library first):

   ```bash
   bash scripts/build-all.sh
   ```

3. Run package tests from the repository root:

   ```bash
   (cd sidekick-shared && npm test)
   (cd sidekick-vscode && npm test)
   (cd sidekick-cli && npm test)
   ```

### Running Locally

Open `sidekick-vscode/` in VS Code and press **F5** to launch the Extension Development Host.

## Available Commands

Extension commands run from `sidekick-vscode/`:

```bash
npm run compile      # Dev build (with source maps)
npm run build        # Production build (minified)
npm run watch        # Watch mode for development
npm test             # Run all tests (Vitest)
npm run test:watch   # Watch mode for tests
npm run lint         # Check for linting issues
npm run lint:fix     # Auto-fix linting issues
npm run package      # Create .vsix for distribution
```

### Building All Packages

From the repo root:

```bash
bash scripts/build-all.sh    # Build sidekick-shared, sidekick-vscode, and sidekick-cli
```

Or build individually:

```bash
(cd sidekick-shared && npm install && npm run build)
(cd sidekick-vscode && npm install && npm run compile)
(cd sidekick-cli && npm install && npm run build)
```

## Code Style

- ESLint for linting across all three packages (`sidekick-vscode`, `sidekick-cli`, `sidekick-shared`)
- Lint the entire project before committing:
  ```bash
  bash scripts/lint-all.sh         # Check all packages
  bash scripts/lint-all.sh --fix   # Auto-fix across all packages
  ```
- TypeScript strict mode
- Tests co-located with source files (`Foo.ts` / `Foo.test.ts`)

## Release Validation

From the repository root, after building `sidekick-shared` and running the package tests:

```bash
bash scripts/lint-all.sh
bash scripts/format-check-all.sh
(cd sidekick-vscode && npx tsc --noEmit)
(cd sidekick-cli && npx tsc --noEmit)
zensical build --strict
```

Use `zensical serve` for local documentation previews. The documentation site uses Zensical with `mkdocs.yml`; do not use `mkdocs build` or `mkdocs serve`. Inspect the build output and rendered pages as well: Zensical currently warns that strict mode is unsupported.

## Branch Naming

- `feature/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation
- `refactor/description` — Code refactoring

## Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(auth): add OAuth2 support
fix(completion): handle empty responses gracefully
docs: update README with troubleshooting section
refactor(session): extract path resolution logic
```

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes with clear commits
3. Ensure tests pass (`npm test`) and linting passes (`npm run lint`)
4. Submit a PR with a clear description

## Areas for Contribution

- Test coverage improvements
- Session monitoring enhancements
- Performance improvements for inline completions
- Documentation and developer experience
- Bug fixes

Look for issues labeled `good first issue` for suitable starting points.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
