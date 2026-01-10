#!/usr/bin/env bash
#
# Start the Sidekick for Max Server (Python/FastAPI)
#
# Usage:
#   ./start-server.sh           # Start with default settings (port 3456)
#   ./start-server.sh --port 8080  # Start on custom port
#   ./start-server.sh --dev     # Start in development mode (with hot reload)
#
# Environment variables:
#   PORT - Server port (default: 3456)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${SCRIPT_DIR}/sidekick-server"

# Parse arguments
DEV_MODE=false
PORT="${PORT:-3456}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --port)
            PORT="$2"
            shift 2
            ;;
        --dev)
            DEV_MODE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --port PORT  Set server port (default: 3456)"
            echo "  --dev        Run in development mode with hot reload"
            echo "  --help       Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

cd "${SERVER_DIR}"

# Check if virtual environment exists, create if needed
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    echo "Installing dependencies..."
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

export PORT

# Graceful shutdown timeout
SHUTDOWN_TIMEOUT=10

if [ "$DEV_MODE" = true ]; then
    echo "Starting server in development mode on port ${PORT}..."
    uvicorn main:app --host 0.0.0.0 --port $PORT --reload --timeout-graceful-shutdown $SHUTDOWN_TIMEOUT
else
    echo "Starting server on port ${PORT}..."
    uvicorn main:app --host 0.0.0.0 --port $PORT --timeout-graceful-shutdown $SHUTDOWN_TIMEOUT
fi
