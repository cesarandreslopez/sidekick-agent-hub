#!/usr/bin/env bash
set -euo pipefail

# Bump version across all 3 packages in the monorepo.
# Usage: bash scripts/bump-version.sh 0.12.0

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <semver>"
  echo "Example: $0 0.12.0"
  exit 1
fi

# Validate semver format (major.minor.patch, optional pre-release)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z or X.Y.Z-pre.N)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PACKAGES=(
  "sidekick-vscode/package.json"
  "sidekick-cli/package.json"
  "sidekick-shared/package.json"
)

for pkg in "${PACKAGES[@]}"; do
  filepath="$REPO_ROOT/$pkg"
  if [[ ! -f "$filepath" ]]; then
    echo "Warning: $pkg not found, skipping"
    continue
  fi

  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$filepath', 'utf8'));
    const old = p.version;
    p.version = '$VERSION';
    fs.writeFileSync('$filepath', JSON.stringify(p, null, 2) + '\n');
    console.log('  $pkg: ' + old + ' -> $VERSION');
  "
done

echo ""
echo "All packages bumped to $VERSION."
echo ""
echo "Next steps:"
echo "  1. Update CHANGELOG.md"
echo "  2. git add -A && git commit -m 'chore: bump version to $VERSION'"
echo "  3. git tag v$VERSION"
echo "  4. git push && git push --tags"
