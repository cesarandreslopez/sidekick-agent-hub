#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PRETTIER="$ROOT_DIR/sidekick-shared/node_modules/.bin/prettier"

if [ ! -x "$PRETTIER" ]; then
  echo "Prettier is not installed. Run npm ci in sidekick-shared first."
  exit 1
fi

echo "Formatting sidekick-shared..."
cd "$ROOT_DIR/sidekick-shared"
npm run format

echo "Formatting sidekick-vscode..."
cd "$ROOT_DIR/sidekick-vscode"
npm run format

echo "Formatting sidekick-cli..."
cd "$ROOT_DIR/sidekick-cli"
npm run format

echo "Formatting root docs and workflows..."
cd "$ROOT_DIR"
"$PRETTIER" --config "$ROOT_DIR/prettier.config.cjs" --ignore-path "$ROOT_DIR/.prettierignore" --write \
  "docs/**/*.md" \
  "*.md" \
  "*.yml" \
  ".github/**/*.{md,yml,yaml}"

echo "Format complete!"
