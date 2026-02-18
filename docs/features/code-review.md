# Pre-commit Code Review

Catch issues before they reach your team. Pre-commit review analyzes your staged changes for bugs, security concerns, and code smells — like having a senior engineer glance at your diff before you push.

Review your changes before committing with AI-powered analysis.

## Usage

Click the **eye icon** in the Source Control toolbar to get AI feedback on your staged changes.

## What It Catches

- **Bug detection** — potential issues before they're committed
- **Security concerns** — highlighted vulnerabilities
- **Code smells** — maintainability issues

## Results

Issues are shown as:

- **Inline decorations** in the editor
- Entries in the **Problems panel**

Use **"Sidekick: Clear AI Review"** to dismiss all review annotations.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.reviewModel` | `auto` | Model tier — resolves to `balanced` |
