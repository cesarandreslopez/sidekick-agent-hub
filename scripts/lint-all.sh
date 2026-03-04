#!/bin/bash
set -e

FIX=""
if [ "$1" = "--fix" ]; then
  FIX=":fix"
fi

echo "Linting sidekick-shared..."
cd "$(dirname "$0")/../sidekick-shared"
npm run lint$FIX

echo "Linting sidekick-vscode..."
cd ../sidekick-vscode
npm run lint$FIX

echo "Linting sidekick-cli..."
cd ../sidekick-cli
npm run lint$FIX

echo "Lint complete!"
