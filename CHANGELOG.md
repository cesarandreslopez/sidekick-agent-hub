# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- GitHub issue templates and PR template
- Contributing guidelines
- Code of conduct
- Security policy
- CI/CD workflow

## [0.2.0] - 2025-01-10

### Added
- Code transform feature (`Ctrl+Shift+M` / `Cmd+Shift+M`)
- Independent model selection for inline completions and transforms
- Transform uses Opus by default for highest quality
- Context lines configuration for transforms

### Changed
- Rebranded from "Claude Code Max" to "Sidekick for Max"
- Optimized default context settings

## [0.1.0] - 2025-01-09

### Added
- Initial release
- Inline code completions with ghost text
- VS Code extension with status bar toggle
- FastAPI server using Claude Code CLI
- Support for Haiku and Sonnet models
- Debounced completion requests
- Request cancellation for stale completions
- In-memory LRU cache
- Rate limiting
- JSONL logging with metrics
- Health check endpoint with usage statistics
