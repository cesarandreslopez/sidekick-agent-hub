# Contributing

Contributions are welcome! Whether it's bug fixes, new features, or documentation improvements.

## Getting Started

### Prerequisites

- Node.js 22 recommended for development (release CI uses Node 20 for the extension and Node 22 for the shared library and CLI)
- VS Code 1.85+
- At least one provider set up (a Claude Pro, Max, or Ultra subscription through Claude Code is recommended)

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
npm run format       # Prettier write for this package
npm run format:check # Prettier check for this package
npm run package      # Create .vsix for distribution
```

Run a single test file with `npx vitest run src/services/ModelResolver.test.ts`.

Shared library commands run from `sidekick-shared/`:

```bash
npm run build        # tsc build to dist/
npm run clean        # Remove dist/
npm test             # Build, then run Vitest
npm run test:watch   # Watch mode for tests
npm run lint         # Check for linting issues
npm run lint:fix     # Auto-fix linting issues
npm run format       # Prettier write for this package
npm run format:check # Prettier check for this package
```

CLI commands run from `sidekick-cli/`:

```bash
npm run build        # Build the launcher and main bundle in dist/
npm run build:sea    # Build the Node 22 single-executable input bundle
npm run clean        # Remove dist/
npm test             # Run Vitest
npm run test:watch   # Watch mode for tests
npm run lint         # Check for linting issues
npm run lint:fix     # Auto-fix linting issues
npm run format       # Prettier write for this package
npm run format:check # Prettier check for this package
npx tsc --noEmit     # Type-check
```

### Monorepo Helpers

These run from the repo root and cover all three packages:

```bash
bash scripts/build-all.sh          # npm install + build sidekick-shared, sidekick-vscode, sidekick-cli
bash scripts/lint-all.sh           # Lint all three packages
bash scripts/lint-all.sh --fix     # Lint and auto-fix all three
bash scripts/format-all.sh         # Prettier write across packages, docs, root markdown/YAML, and workflows
bash scripts/format-check-all.sh   # Prettier check across the same files
```

The format scripts use the Prettier installed in `sidekick-shared/node_modules`, so run `npm install` (or `npm ci`) there first.

### Building Packages Individually

`bash scripts/build-all.sh` builds everything; to build one package at a time, start with the shared library:

```bash
(cd sidekick-shared && npm install && npm run build)
(cd sidekick-vscode && npm install && npm run compile)
(cd sidekick-cli && npm install && npm run build)
```

## Code Style

- ESLint for linting and Prettier for formatting across all three packages (`sidekick-vscode`, `sidekick-cli`, `sidekick-shared`); Prettier also covers `docs/`, root markdown and YAML, and workflows
- Lint and format the entire project before committing:
  ```bash
  bash scripts/lint-all.sh           # Check all packages
  bash scripts/lint-all.sh --fix     # Auto-fix across all packages
  bash scripts/format-all.sh         # Apply Prettier formatting
  bash scripts/format-check-all.sh   # Check formatting without writing
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
3. Ensure tests (`npm test`), linting (`npm run lint`), and formatting (`npm run format:check`) pass in each package you touched
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
