# Sidekick for Max - Server

FastAPI server that provides AI-powered code completions and transformations using Claude Code CLI.

## Prerequisites

- **Python** 3.10 or higher
- **Claude Max subscription** (required for Claude Code CLI)
- Authenticated with Claude CLI (`claude auth`)

## Quick Start

From the project root directory:

```bash
./start-server.sh
```

The server will start on port 3456 by default.

## Installation Options

### Option 1: Using the Startup Script (Recommended)

The startup script handles virtual environment creation and dependency installation automatically:

```bash
# Start with default settings (port 3456)
./start-server.sh

# Start on a custom port
./start-server.sh --port 8080

# Start in development mode (hot reload)
./start-server.sh --dev

# Show help
./start-server.sh --help
```

### Option 2: Manual Setup

Navigate to the server directory:

```bash
cd sidekick-server
```

Create and activate a virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Start the server:

```bash
uvicorn main:app --host 0.0.0.0 --port 3456
```

### Option 3: Development Mode

For development with hot reload:

```bash
cd sidekick-server
source venv/bin/activate
uvicorn main:app --reload --port 3456
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CACHE_TTL_MS` | `30000` | Cache entry TTL in milliseconds |
| `CACHE_MAX_SIZE` | `100` | Maximum cache entries |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Max requests per window |
| `LOG_RETENTION_DAYS` | `7` | Days to keep log files |

### Setting the Port

```bash
# Using environment variable
PORT=8080 uvicorn main:app --host 0.0.0.0 --port 8080

# Using the startup script
./start-server.sh --port 8080
```

## API Endpoints

### POST /inline

Generate an inline code completion.

**Request:**

```json
{
  "prefix": "function add(a, b) { return ",
  "suffix": " }",
  "language": "javascript",
  "filename": "math.js",
  "model": "haiku",
  "multiline": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prefix` | string | Yes | Code before the cursor |
| `suffix` | string | No | Code after the cursor |
| `language` | string | Yes | Programming language (e.g., "typescript", "python") |
| `filename` | string | No | Name of the file being edited |
| `model` | string | No | `"haiku"` (fast, default) or `"sonnet"` (higher quality) |
| `multiline` | boolean | No | Allow multi-line completions (default: false) |

**Response:**

```json
{
  "completion": "a + b",
  "requestId": "abc123"
}
```

**Example with curl:**

```bash
curl -X POST http://localhost:3456/inline \
  -H "Content-Type: application/json" \
  -d '{
    "prefix": "const greeting = ",
    "suffix": ";",
    "language": "typescript"
  }'
```

### POST /transform

Transform selected code based on an instruction.

**Request:**

```json
{
  "code": "function add(a, b) { return a + b; }",
  "instruction": "Add TypeScript types",
  "language": "typescript",
  "filename": "math.ts",
  "model": "opus",
  "prefix": "// Math utilities\n",
  "suffix": "\nexport default add;"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Code to transform |
| `instruction` | string | Yes | Natural language instruction |
| `language` | string | Yes | Programming language |
| `filename` | string | No | Name of the file being edited |
| `model` | string | No | `"opus"` (default), `"sonnet"`, or `"haiku"` |
| `prefix` | string | No | Context before selection |
| `suffix` | string | No | Context after selection |

**Response:**

```json
{
  "modified_code": "function add(a: number, b: number): number { return a + b; }",
  "requestId": "def456"
}
```

**Example with curl:**

```bash
curl -X POST http://localhost:3456/transform \
  -H "Content-Type: application/json" \
  -d '{
    "code": "function add(a, b) { return a + b; }",
    "instruction": "Add TypeScript types",
    "language": "typescript"
  }'
```

### GET /health

Health check endpoint with metrics.

**Response:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600.5,
  "uptimeHuman": "1h 0m 0s",
  "logFile": "logs/2024-01-10_12-00-00.jsonl",
  "metrics": {
    "totalRequests": 150,
    "cacheHits": 45,
    "cacheHitRate": 0.30,
    "avgResponseTimeMs": 234.5,
    "requestsByModel": {
      "haiku": 120,
      "sonnet": 25,
      "opus": 5
    },
    "errorCount": 2
  }
}
```

## Testing

Run the test suite:

```bash
cd sidekick-server
source venv/bin/activate
python -m pytest
```

Run tests in verbose mode:

```bash
python -m pytest -v
```

Run a specific test:

```bash
python -m pytest -k "test_name_pattern"
python -m pytest tests/test_cache.py
```

## Troubleshooting

### Server won't start

1. **Check Python version**: Requires 3.10+
   ```bash
   python3 --version
   ```

2. **Verify Claude authentication**:
   ```bash
   claude auth status
   ```

3. **Check if port is in use**:
   ```bash
   lsof -i :3456
   ```

4. **Verify virtual environment is activated**:
   ```bash
   which python  # Should show venv path
   ```

### Empty completions returned

The server filters out:
- Single-line responses longer than 200 characters
- Multi-line responses longer than 1000 characters
- Conversational responses (e.g., "I need more context")
- Markdown artifacts

This is by design to ensure only valid code completions are returned.

### Connection refused errors

Ensure the server is running and accessible:
```bash
curl http://localhost:3456/health
```

### Rate limiting (429 errors)

The server rate-limits requests to 60 per minute by default. If you hit the limit, wait for the duration specified in the `Retry-After` header.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 FastAPI Server (main.py)                │
├─────────────────────────────────────────────────────────┤
│  routers/completion.py                                  │
│  ┌─────────────────┐  ┌─────────────────┐              │
│  │  POST /inline   │  │ POST /transform │              │
│  └────────┬────────┘  └────────┬────────┘              │
│           │                    │                        │
│           ▼                    ▼                        │
│  services/completion.py  services/modification.py       │
│           │                    │                        │
│           ├──► utils/cache.py (LRU cache)              │
│           ├──► utils/rate_limiter.py                   │
│           ├──► utils/metrics.py                        │
│           │                                            │
│           ▼                                            │
│  services/claude_client.py                             │
│           │                                            │
│           ▼                                            │
│  Claude Code CLI (async streaming)                     │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
sidekick-server/
├── main.py              # FastAPI application entry point
├── config.py            # Configuration settings
├── pyproject.toml       # Project metadata and dependencies
├── requirements.txt     # pip dependencies
├── models/
│   ├── request.py       # CompletionRequest, ModifyRequest
│   └── response.py      # CompletionResponse, ModifyResponse, HealthResponse
├── routers/
│   └── completion.py    # API routes (/inline, /transform, /health)
├── services/
│   ├── claude_client.py # Claude Code CLI wrapper
│   ├── completion.py    # Inline completion logic
│   └── modification.py  # Code transformation logic
├── utils/
│   ├── cache.py         # In-memory LRU cache
│   ├── rate_limiter.py  # Sliding window rate limiter
│   ├── metrics.py       # Performance metrics
│   ├── logger.py        # JSON Lines logging
│   └── prompts.py       # Prompt template loading
├── prompts/
│   ├── system.md        # System prompt for inline completions
│   ├── user.md          # User prompt for inline completions
│   ├── modify_system.md # System prompt for transforms
│   └── modify_user.md   # User prompt for transforms
├── tests/               # Test suite
└── logs/                # Runtime logs (auto-created)
```
