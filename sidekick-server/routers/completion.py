"""Completion API router."""

import time
import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from config import VERSION
from models.request import CompletionRequest, ModifyRequest
from models.response import HealthResponse
from services.completion import get_completion
from services.modification import get_modification
from utils.logger import log
from utils.metrics import metrics
from utils.rate_limiter import rate_limiter

router = APIRouter()

# Server start time for uptime calculation
_start_time = time.time()


def format_duration(seconds: int) -> str:
    """Format duration in seconds to human-readable string."""
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    return f"{hours}h {minutes}m {secs}s"


@router.post("/inline", response_model=None)
async def inline(request: CompletionRequest):
    """
    Generate an inline code completion.

    Takes the code context (prefix, suffix, language) and returns
    a completion suggestion.
    """
    request_id = str(uuid.uuid4())

    # Check rate limit
    if not rate_limiter.is_allowed():
        retry_after = rate_limiter.get_retry_after_seconds()
        log.error("Rate limit exceeded", {"requestId": request_id, "retryAfter": retry_after})
        return JSONResponse(
            status_code=429,
            content={
                "error": "Too many requests",
                "completion": "",
                "requestId": request_id,
            },
            headers={"Retry-After": str(retry_after)},
        )

    log.info("Incoming request", {"requestId": request_id, "method": "POST", "url": "/inline"})

    result = await get_completion(request, request_id)
    return result


@router.post("/transform", response_model=None)
async def transform(request: ModifyRequest):
    """
    Transform selected code based on an instruction.

    Takes the code, instruction, and language and returns
    the transformed code.
    """
    request_id = str(uuid.uuid4())

    # Check rate limit
    if not rate_limiter.is_allowed():
        retry_after = rate_limiter.get_retry_after_seconds()
        log.error("Rate limit exceeded", {"requestId": request_id, "retryAfter": retry_after})
        return JSONResponse(
            status_code=429,
            content={
                "error": "Too many requests",
                "modified_code": "",
                "requestId": request_id,
            },
            headers={"Retry-After": str(retry_after)},
        )

    log.info("Incoming request", {"requestId": request_id, "method": "POST", "url": "/transform"})

    result = await get_modification(request, request_id)
    return result


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """
    Health check endpoint.

    Returns server status, version, uptime, and metrics.
    """
    log.debug("Health check")
    uptime_seconds = int(time.time() - _start_time)

    return HealthResponse(
        status="ok",
        version=VERSION,
        uptime=uptime_seconds,
        uptimeHuman=format_duration(uptime_seconds),
        logFile=log.get_log_file_path() or "",
        metrics=metrics.get_metrics(),
    )
