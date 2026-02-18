# AI Commit Messages

Writing good commit messages takes thought. This analyzes your actual diff and generates a meaningful message — conventional commits format or plain English — so your git history stays useful without slowing you down.

Generate intelligent commit messages from your staged changes with a single click.

## Usage

1. Stage your changes in the Source Control panel
2. Click the sparkle button in the Source Control toolbar
3. A commit message is generated based on your diff
4. Optionally regenerate with custom guidance

## Regeneration

After generation, you can:

- **Regenerate** — get a fresh message
- **Regenerate with guidance** — provide instructions like "focus on the bug fix", "make it shorter", "mention the refactoring"

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.commitMessageModel` | `auto` | Model tier — resolves to `balanced` |
| `sidekick.commitMessageStyle` | `conventional` | Format: `conventional` or `simple` |
| `sidekick.commitMessageGuidance` | (empty) | Default guidance applied to all commits |
| `sidekick.showCommitButton` | `true` | Show sparkle button in Source Control |

## Commit Styles

=== "Conventional Commits"

    Structured format: `type(scope): description`

    ```
    feat(auth): add OAuth2 support
    fix(api): handle empty response gracefully
    refactor(session): extract path resolution logic
    ```

=== "Simple"

    Plain imperative description:

    ```
    Add OAuth2 authentication support
    Handle empty API responses gracefully
    ```

## Smart Filtering

The commit message generator automatically filters out:

- Binary files
- Lock files (`package-lock.json`, `yarn.lock`, etc.)
- Generated code
- Intelligently truncates large diffs at file boundaries
