# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Security Model

Sidekick Agent Hub is designed with security in mind:

- **No API keys stored**: Uses Claude Code CLI authentication, which manages credentials securely
- **No telemetry**: No data is sent to external servers beyond Claude API calls
- **Code stays local**: Your code context is only sent to Anthropic's API through the authenticated CLI

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainer directly or use GitHub's private vulnerability reporting feature
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Resolution timeline**: Depends on severity, typically 1-4 weeks

## Security Best Practices for Users

1. **Keep dependencies updated**: Regularly update npm dependencies
2. **Use authenticated CLI**: Always authenticate via `claude auth` before use

## Scope

This security policy covers:
- The VS Code extension (`sidekick-vscode/`)

It does not cover:
- Claude Code CLI (report to Anthropic)
- Third-party dependencies (report to respective maintainers)
