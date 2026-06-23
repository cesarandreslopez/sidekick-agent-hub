#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PRETTIER="$ROOT_DIR/sidekick-shared/node_modules/.bin/prettier"

if [ ! -x "$PRETTIER" ]; then
  echo "Prettier is not installed. Run npm ci in sidekick-shared first."
  exit 1
fi

echo "Checking sidekick-shared formatting..."
cd "$ROOT_DIR/sidekick-shared"
npm run format:check

echo "Checking sidekick-vscode formatting..."
cd "$ROOT_DIR/sidekick-vscode"
npm run format:check

echo "Checking sidekick-cli formatting..."
cd "$ROOT_DIR/sidekick-cli"
npm run format:check

echo "Checking root docs and workflows formatting..."
cd "$ROOT_DIR"
"$PRETTIER" --config "$ROOT_DIR/prettier.config.cjs" --ignore-path "$ROOT_DIR/.prettierignore" --check \
  "docs/**/*.md" \
  "*.md" \
  "*.yml" \
  ".github/**/*.{md,yml,yaml}"

echo "Format check complete!"
