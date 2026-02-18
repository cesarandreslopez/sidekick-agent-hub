# PR Description Generation

Writing PR descriptions is tedious but important — reviewers need context. This analyzes all commits on your branch and generates a structured summary with changes and test plan, ready to paste into your PR.

Generate pull request descriptions automatically from your branch changes.

## Usage

Click the **PR icon** in the Source Control toolbar.

## What It Generates

- **Summary** — high-level overview of changes
- **Change List** — detailed breakdown by area
- **Test Plan** — suggested testing checklist

The description is copied to your clipboard, ready to paste into GitHub or GitLab.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.prDescriptionModel` | `auto` | Model tier — resolves to `balanced` |
