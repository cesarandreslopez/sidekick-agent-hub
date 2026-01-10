"""Rate limiter for protecting against request floods."""

import math
import os
import time

# Default rate limit window in milliseconds (1 minute)
DEFAULT_WINDOW_MS = 60000

# Default maximum requests per window
DEFAULT_MAX_REQUESTS = 60

# Rate limit window from environment or default
RATE_LIMIT_WINDOW_MS = int(os.environ.get("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS))

# Maximum requests from environment or default
RATE_LIMIT_MAX_REQUESTS = int(
    os.environ.get("RATE_LIMIT_MAX_REQUESTS", DEFAULT_MAX_REQUESTS)
)


class RateLimiter:
    """
    Sliding window rate limiter.
    Tracks request timestamps and allows/denies based on count within window.
    """

    def __init__(
        self,
        window_ms: int = RATE_LIMIT_WINDOW_MS,
        max_requests: int = RATE_LIMIT_MAX_REQUESTS,
    ):
        self._requests: list[float] = []
        self._window_ms = window_ms
        self._max_requests = max_requests

    def is_allowed(self) -> bool:
        """
        Check if a request is allowed under the rate limit.
        If allowed, the request is recorded.

        Returns:
            True if the request is allowed, False if rate limited
        """
        now = time.time() * 1000  # Convert to milliseconds

        # Remove timestamps outside the window
        self._requests = [t for t in self._requests if now - t < self._window_ms]

        # Check if under limit
        if len(self._requests) >= self._max_requests:
            return False

        # Record this request
        self._requests.append(now)
        return True

    def get_retry_after_seconds(self) -> int:
        """
        Get the number of seconds until the rate limit resets.
        Returns 0 if not currently rate limited.
        """
        if not self._requests:
            return 0

        now = time.time() * 1000
        oldest = self._requests[0]
        wait_ms = self._window_ms - (now - oldest)

        return max(0, math.ceil(wait_ms / 1000))

    def get_current_count(self) -> int:
        """Get the current request count in the window."""
        now = time.time() * 1000
        self._requests = [t for t in self._requests if now - t < self._window_ms]
        return len(self._requests)

    def reset(self) -> None:
        """Reset the rate limiter (for testing)."""
        self._requests = []


# Singleton rate limiter instance
rate_limiter = RateLimiter()
