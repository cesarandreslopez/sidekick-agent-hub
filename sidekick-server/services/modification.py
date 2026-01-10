"""Code modification logic using Claude Agent SDK."""

import re
import time
from typing import Optional

from models.request import ModifyRequest
from models.response import ModifyResponse
from services.claude_client import (
    get_claude_completion,
    ClaudeSDKError,
    CLINotFoundError,
    CLIConnectionError,
    ProcessError,
    CLIJSONDecodeError,
)
from utils.logger import log
from utils.metrics import metrics
from utils.prompts import get_modify_system_prompt, get_modify_user_prompt


def clean_modification(text: str) -> str:
    """
    Clean up the modification response.

    Args:
        text: Raw modification text from Claude

    Returns:
        Cleaned text with markdown fences removed
    """
    # Remove markdown code blocks
    cleaned = re.sub(r"^```[\w]*\n?", "", text)
    cleaned = re.sub(r"\n?```$", "", cleaned)
    return cleaned.strip()


async def get_modification(
    req: ModifyRequest,
    request_id: Optional[str] = None,
) -> ModifyResponse:
    """
    Generates a code modification using the Claude Agent SDK.

    Args:
        req: The modification request containing code and instruction
        request_id: Optional unique identifier for request tracing

    Returns:
        ModifyResponse with the modified code or error
    """
    code = req.code
    instruction = req.instruction
    language = req.language
    filename = req.filename or "unknown"
    model = req.model or "opus"
    prefix = req.prefix or ""
    suffix = req.suffix or ""

    start_time = time.time() * 1000  # Convert to milliseconds

    log.info(
        "Processing modification request",
        {
            "requestId": request_id,
            "language": language,
            "filename": filename,
            "model": model,
            "codeLength": len(code),
            "prefixLength": len(prefix),
            "suffixLength": len(suffix),
            "instruction": instruction[:100],
        },
    )

    # Load prompts from markdown files
    system_prompt = get_modify_system_prompt()
    prompt = get_modify_user_prompt(
        language=language,
        code=code,
        instruction=instruction,
        prefix=prefix,
        suffix=suffix,
    )

    try:
        # Call Claude Agent SDK (uses model-specific timeout: haiku=5s, sonnet=10s, opus=30s)
        modified_text = await get_claude_completion(
            prompt=prompt,
            system_prompt=system_prompt,
            model=model,
        )

        # Clean up the response
        cleaned_code = clean_modification(modified_text)

        elapsed = time.time() * 1000 - start_time

        log.info(
            "Modification generated",
            {
                "requestId": request_id,
                "elapsed": elapsed,
                "originalLength": len(code),
                "modifiedLength": len(cleaned_code),
            },
        )

        # Record metrics
        metrics.record_request(model, elapsed, cache_hit=False, error=False)

        return ModifyResponse(modified_code=cleaned_code, requestId=request_id)

    except TimeoutError:
        elapsed = time.time() * 1000 - start_time
        log.error("Modification timed out", {"requestId": request_id, "elapsed": elapsed})
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error="Request timed out",
            requestId=request_id,
        )

    except CLINotFoundError:
        elapsed = time.time() * 1000 - start_time
        error_msg = "Claude Code CLI not found. Please install it with: npm install -g @anthropic-ai/claude-code"
        log.error(
            "CLI not found",
            {"requestId": request_id, "elapsed": elapsed},
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error=error_msg,
            requestId=request_id,
        )

    except CLIConnectionError as e:
        elapsed = time.time() * 1000 - start_time
        error_msg = f"Failed to connect to Claude Code CLI: {e}"
        log.error(
            "CLI connection error",
            {"requestId": request_id, "elapsed": elapsed, "error": str(e)},
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error=error_msg,
            requestId=request_id,
        )

    except ProcessError as e:
        elapsed = time.time() * 1000 - start_time
        exit_code = getattr(e, "exit_code", "unknown")
        error_msg = f"Claude Code CLI process failed (exit code: {exit_code})"
        log.error(
            "CLI process error",
            {"requestId": request_id, "elapsed": elapsed, "exitCode": exit_code, "error": str(e)},
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error=error_msg,
            requestId=request_id,
        )

    except CLIJSONDecodeError as e:
        elapsed = time.time() * 1000 - start_time
        error_msg = f"Failed to parse Claude Code response: {e}"
        log.error(
            "CLI JSON decode error",
            {"requestId": request_id, "elapsed": elapsed, "error": str(e)},
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error=error_msg,
            requestId=request_id,
        )

    except ClaudeSDKError as e:
        elapsed = time.time() * 1000 - start_time
        error_msg = f"Claude SDK error: {e}"
        log.error(
            "Claude SDK error",
            {"requestId": request_id, "elapsed": elapsed, "error": str(e)},
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error=error_msg,
            requestId=request_id,
        )

    except Exception as e:
        elapsed = time.time() * 1000 - start_time
        error_msg = str(e) if str(e) else "Unknown error"
        log.error(
            "Modification failed",
            {
                "requestId": request_id,
                "elapsed": elapsed,
                "error": error_msg,
            },
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return ModifyResponse(
            modified_code="",
            error=error_msg,
            requestId=request_id,
        )
