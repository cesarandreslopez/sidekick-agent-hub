# Sidekick for Max - Server

FastAPI server that bridges VS Code to Claude Code CLI for code completions and transformations.

## Why a Dedicated Server?

This server enables your VS Code extension to leverage your Claude Max subscription for inline completions. Benefits:

- **Uses existing authentication** - Calls `claude` CLI with your logged-in session
- **No API keys needed** - Your Max subscription covers all usage
- **Model flexibility** - Haiku for speed, Sonnet for quality, Opus for transforms
- **Local processing** - Your code stays on your machine

## Token Efficiency

The server is designed to be token-efficient:

| Endpoint | Default Model | Timeout | Use Case |
|----------|---------------|---------|----------|
| `/inline` | Haiku | 5s | Fast completions, minimal tokens |
| `/transform` | Opus | 30s | Quality transforms, worth the tokens |

Haiku completions typically use a fraction of what an Opus CLI session would use, making this an efficient way to utilize your subscription between heavier CLI workflows.

## Installation

```bash
cd sidekick-server

# Create and activate virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## Usage

### Start the Server

```bash
# Using the convenience script (from project root)
./start-server.sh

# Or directly with uvicorn
cd sidekick-server
source venv/bin/activate
uvicorn main:app --port 3456

# Development mode with hot reload
uvicorn main:app --reload --port 3456
```

### API Endpoints

#### POST /inline
Generate code completions.

```json
{
  "prefix": "def hello(",
  "suffix": ")\n    return greeting",
  "language": "python",
  "filename": "example.py",
  "model": "haiku",
  "multiline": false
}
```

Response:
```json
{
  "completion": "name: str"
}
```

#### POST /transform
Transform selected code based on instructions.

```json
{
  "code": "function add(a, b) { return a + b; }",
  "instruction": "Add TypeScript types",
  "language": "typescript",
  "filename": "math.ts",
  "model": "opus"
}
```

Response:
```json
{
  "modified_code": "function add(a: number, b: number): number { return a + b; }"
}
```

#### GET /health
Health check endpoint.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 3456 | Server port |
| `LOG_DIR` | `logs/` | Directory for JSONL log files |

## Development

```bash
# Activate virtual environment
source venv/bin/activate

# Run tests
python -m pytest

# Run tests with coverage
python -m pytest --cov

# Lint
ruff check .
ruff check . --fix  # Auto-fix issues
```

## Architecture

```
main.py                 FastAPI application entry point
├── models/
│   └── request.py      Pydantic request/response models
├── services/
│   ├── completion.py   Inline completion logic
│   └── modification.py Code transformation logic
├── prompts/
│   ├── system.md           System prompt for completions
│   ├── user.md             User prompt template for completions
│   ├── modify_system.md    System prompt for transforms
│   └── modify_user.md      User prompt template for transforms
└── utils/
    ├── claude_client.py    Claude CLI subprocess wrapper
    ├── prompts.py          Prompt loading utilities
    └── logger.py           JSONL logging utilities
```

## Logs

The server logs requests and responses to timestamped JSONL files in the `logs/` directory. Each line contains:

- Timestamp
- Request type (inline/transform)
- Input parameters
- Response or error
- Duration
