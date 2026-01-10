"""Code completion logic using Claude Agent SDK."""

import re
import time
from typing import Optional

from models.request import CompletionRequest
from models.response import CompletionResponse
from services.claude_client import (
    get_claude_completion,
    ClaudeSDKError,
    CLINotFoundError,
    CLIConnectionError,
    ProcessError,
    CLIJSONDecodeError,
)
from utils.cache import completion_cache
from utils.logger import log
from utils.metrics import metrics
from utils.prompts import get_system_prompt, get_user_prompt

# Conversational patterns to filter out
CONVERSATIONAL_PATTERNS = [
    re.compile(r"^I (need|cannot|can't|don't|would|could)", re.IGNORECASE),
    re.compile(r"^(Could|Would|Can) you", re.IGNORECASE),
    re.compile(r"more context", re.IGNORECASE),
    re.compile(r"cannot provide", re.IGNORECASE),
    re.compile(r"please provide", re.IGNORECASE),
    re.compile(r"let me", re.IGNORECASE),
    re.compile(r"however", re.IGNORECASE),
    re.compile(r"without (additional|more)", re.IGNORECASE),
]


def clean_completion(text: str, max_length: int) -> tuple[str, Optional[str]]:
    """
    Clean up the completion response.

    Args:
        text: Raw completion text from Claude
        max_length: Maximum allowed length (200 for single-line, 1000 for multiline)

    Returns:
        Tuple of (cleaned text, filter reason if filtered)
    """
    # Remove markdown code blocks
    cleaned = re.sub(r"^```[\w]*\n?", "", text)
    cleaned = re.sub(r"\n?```$", "", cleaned)
    cleaned = cleaned.strip()

    # Check for conversational patterns
    for pattern in CONVERSATIONAL_PATTERNS:
        if pattern.search(cleaned):
            return "", f"Filtered conversational response: {pattern.pattern}"

    # Check length
    if len(cleaned) > max_length:
        return "", f"Filtered response (too long): {len(cleaned)} > {max_length}"

    return cleaned, None


async def get_completion(
    req: CompletionRequest,
    request_id: Optional[str] = None,
) -> CompletionResponse:
    """
    Generates a code completion using the Claude Agent SDK.

    Args:
        req: The completion request containing code context
        request_id: Optional unique identifier for request tracing

    Returns:
        CompletionResponse with the generated completion or error
    """
    prefix = req.prefix
    suffix = req.suffix or ""
    language = req.language
    filename = req.filename or "unknown"
    model = req.model or "haiku"
    max_tokens = req.max_tokens
    multiline = req.multiline

    # Configure max length based on mode
    max_length = 1000 if multiline else 200

    start_time = time.time() * 1000  # Convert to milliseconds

    # Check cache first
    cached = completion_cache.get(req)
    if cached:
        elapsed = time.time() * 1000 - start_time
        log.debug("Cache hit", {"requestId": request_id, "language": language, "model": model})
        metrics.record_request(model, elapsed, cache_hit=True, error=False)
        return CompletionResponse(
            completion=cached.completion,
            error=cached.error,
            requestId=request_id,
        )

    # Warn if max_tokens is provided (SDK doesn't support it)
    if max_tokens is not None:
        log.debug(
            "max_tokens parameter ignored (not supported by SDK)",
            {"requestId": request_id, "max_tokens": max_tokens},
        )

    log.info(
        "Processing completion request",
        {
            "requestId": request_id,
            "language": language,
            "filename": filename,
            "model": model,
            "prefixLength": len(prefix),
            "suffixLength": len(suffix),
        },
    )

    # Load prompts from markdown files
    system_prompt = get_system_prompt(multiline=multiline)
    prompt = get_user_prompt(
        language=language,
        filename=filename,
        prefix=prefix,
        suffix=suffix,
    )

    try:
        # Call Claude Agent SDK
        completion_text = await get_claude_completion(
            prompt=prompt,
            system_prompt=system_prompt,
            model=model,
        )

        # Clean up the completion
        cleaned_completion, filter_reason = clean_completion(completion_text, max_length)

        elapsed = time.time() * 1000 - start_time

        if filter_reason:
            log.debug(filter_reason, {"requestId": request_id, "elapsed": elapsed})
            metrics.record_request(model, elapsed, cache_hit=False, error=False)
            return CompletionResponse(completion="", requestId=request_id)

        log.info(
            "Completion generated",
            {
                "requestId": request_id,
                "elapsed": elapsed,
                "completionLength": len(cleaned_completion),
                "completion": cleaned_completion[:100],
            },
        )

        response = CompletionResponse(completion=cleaned_completion, requestId=request_id)

        # Cache successful completion
        completion_cache.set(req, response)

        # Record metrics for successful completion
        metrics.record_request(model, elapsed, cache_hit=False, error=False)

        return response

    except TimeoutError:
        elapsed = time.time() * 1000 - start_time
        log.error("Request timed out", {"requestId": request_id, "elapsed": elapsed})
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return CompletionResponse(
            completion="",
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
        return CompletionResponse(
            completion="",
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
        return CompletionResponse(
            completion="",
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
        return CompletionResponse(
            completion="",
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
        return CompletionResponse(
            completion="",
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
        return CompletionResponse(
            completion="",
            error=error_msg,
            requestId=request_id,
        )

    except Exception as e:
        elapsed = time.time() * 1000 - start_time
        error_msg = str(e) if str(e) else "Unknown error"
        log.error(
            "Completion failed",
            {
                "requestId": request_id,
                "elapsed": elapsed,
                "error": error_msg,
            },
        )
        metrics.record_request(model, elapsed, cache_hit=False, error=True)
        return CompletionResponse(
            completion="",
            error=error_msg,
            requestId=request_id,
        )
