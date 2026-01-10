# Contributing to Sidekick for Max

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- Python 3.10+
- Node.js 18+
- Claude Max subscription with authenticated CLI (`claude auth`)

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/cesarandreslopez/sidekick-for-claude-max.git
   cd sidekick-for-claude-max
   ```

2. **Set up the server**
   ```bash
   cd sidekick-server
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   pip install -e ".[dev]"
   ```

3. **Set up the VS Code extension**
   ```bash
   cd sidekick-vscode
   npm install
   npm run compile
   ```

4. **Run tests to verify setup**
   ```bash
   # Server tests
   cd sidekick-server && source venv/bin/activate
   python -m pytest

   # Extension tests
   cd sidekick-vscode
   npm test
   ```

## Development Workflow

### Running Locally

1. Start the server:
   ```bash
   ./start-server.sh --dev
   ```

2. In VS Code, open `sidekick-vscode/` and press `F5` to launch the Extension Development Host.

### Code Style

**Python (Server)**
- We use [Ruff](https://github.com/astral-sh/ruff) for linting
- Run `ruff check .` before committing
- Run `ruff check . --fix` to auto-fix issues

**TypeScript (Extension)**
- We use ESLint for linting
- Run `npm run lint` before committing
- Run `npm run lint:fix` to auto-fix issues

### Running Tests

**Server:**
```bash
cd sidekick-server
source venv/bin/activate
python -m pytest              # Run all tests
python -m pytest -v           # Verbose output
python -m pytest -k "pattern" # Run specific tests
```

**Extension:**
```bash
cd sidekick-vscode
npm test                      # Run all tests
npm run test:watch            # Watch mode
```

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Code refactoring

### Commit Messages

Write clear, concise commit messages:

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- Keep the first line under 72 characters
- Reference issues when applicable ("Fix #123")

Good examples:
```
Add multi-line completion support
Fix cache invalidation on model change
Update README with troubleshooting section
```

### Pull Requests

1. Create a feature branch from `master`
2. Make your changes with clear commits
3. Ensure all tests pass
4. Update documentation if needed
5. Submit a PR with a clear description

## Project Structure

```
sidekick-for-claude-max/
├── sidekick-server/          # FastAPI server
│   ├── main.py               # Entry point
│   ├── routers/              # API endpoints
│   ├── services/             # Business logic
│   ├── utils/                # Utilities
│   ├── prompts/              # Prompt templates
│   └── tests/                # Test suite
│
├── sidekick-vscode/          # VS Code extension
│   ├── src/
│   │   └── extension.ts      # Extension entry point
│   └── package.json          # Extension manifest
│
├── start-server.sh           # Server startup script
└── README.md                 # Main documentation
```

## Areas for Contribution

### Good First Issues

Look for issues labeled `good first issue` - these are suitable for newcomers.

### Current Priorities

- Performance improvements
- Additional language support
- Documentation improvements
- Test coverage
- Bug fixes

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
