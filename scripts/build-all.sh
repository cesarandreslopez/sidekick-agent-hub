#!/bin/bash
set -e

echo "Building sidekick-shared..."
cd "$(dirname "$0")/../sidekick-shared"
npm install
npm run build

echo "Building sidekick-cli..."
cd ../sidekick-cli
npm install
npm run build

echo "Build complete!"
echo "CLI binary at: sidekick-cli/dist/sidekick-cli.mjs"
