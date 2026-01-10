"""Claude Agent SDK client wrapper."""

import asyncio
import os

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    TextBlock,
    query,
    # Error types for proper error handling
    ClaudeSDKError,
    CLINotFoundError,
    CLIConnectionError,
    ProcessError,
    CLIJSONDecodeError,
)

# Re-export error types for use by other modules
__all__ = [
    "get_claude_completion",
    "get_timeout",
    "ClaudeSDKError",
    "CLINotFoundError",
    "CLIConnectionError",
    "ProcessError",
    "CLIJSONDecodeError",
]

# Model-specific timeout defaults in seconds
MODEL_TIMEOUTS: dict[str, float] = {
    "haiku": 5.0,   # 5 seconds - fast model
    "sonnet": 10.0, # 10 seconds - quality model
    "opus": 30.0,   # 30 seconds - highest quality model
}

# Default timeout if model not found
DEFAULT_TIMEOUT = 5.0


def get_timeout(model: str) -> float:
    """
    Get timeout for a specific model, allowing environment override.
    Environment variable COMPLETION_TIMEOUT_MS overrides all model-specific timeouts.
    """
    env_timeout = os.environ.get("COMPLETION_TIMEOUT_MS")
    if env_timeout:
        return int(env_timeout) / 1000  # Convert ms to seconds
    return MODEL_TIMEOUTS.get(model, DEFAULT_TIMEOUT)


async def get_claude_completion(
    prompt: str,
    system_prompt: str,
    model: str = "haiku",
    timeout_override: int | None = None,
) -> str:
    """
    Query Claude using the Agent SDK.

    Args:
        prompt: The user prompt with code context
        system_prompt: System instructions for completion behavior
        model: The model to use ("haiku", "sonnet", or "opus")
        timeout_override: Optional timeout in milliseconds (overrides model default)

    Returns:
        The generated completion text

    Raises:
        TimeoutError: If the request times out
        CLINotFoundError: If Claude Code CLI is not installed
        CLIConnectionError: If connection to CLI fails
        ProcessError: If CLI process fails (includes exit_code attribute)
        CLIJSONDecodeError: If response parsing fails
        ClaudeSDKError: Base error for other SDK errors
    """
    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        model=model,
        max_turns=1,           # Single turn, no back-and-forth
        allowed_tools=[],      # No tools needed for completion
    )

    completion_text = ""
    timeout = timeout_override / 1000 if timeout_override else get_timeout(model)

    try:
        async with asyncio.timeout(timeout):
            async for message in query(prompt=prompt, options=options):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            completion_text += block.text
    except asyncio.TimeoutError:
        raise TimeoutError(f"Request timed out after {timeout}s")
    except CLINotFoundError:
        # Claude Code CLI not installed - user needs to install it
        raise
    except CLIConnectionError:
        # Connection issues with CLI - may be temporary
        raise
    except ProcessError:
        # CLI process failed - includes exit_code for debugging
        raise
    except CLIJSONDecodeError:
        # Failed to parse response - likely a CLI bug or version mismatch
        raise
    except ClaudeSDKError:
        # Catch-all for other SDK errors
        raise

    return completion_text
