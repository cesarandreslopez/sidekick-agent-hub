# Contributing

Contributions are welcome! Whether it's bug fixes, new features, or documentation improvements.

## Getting Started

### Prerequisites

- Node.js 18+
- VS Code 1.85+
- At least one provider set up (Claude Max recommended)

### Development Setup

1. Clone the repository:
    ```bash
    git clone https://github.com/cesarandreslopez/sidekick-agent-hub.git
    cd sidekick-agent-hub
    ```

2. Set up the VS Code extension:
    ```bash
    cd sidekick-vscode
    npm install
    npm run compile
    ```

3. Run tests to verify setup:
    ```bash
    npm test
    ```

### Running Locally

Open `sidekick-vscode/` in VS Code and press **F5** to launch the Extension Development Host.

## Available Commands

All commands run from `sidekick-vscode/`:

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

## Code Style

- ESLint for linting — run `npm run lint` before committing
- TypeScript strict mode
- Tests co-located with source files (`Foo.ts` / `Foo.test.ts`)

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
