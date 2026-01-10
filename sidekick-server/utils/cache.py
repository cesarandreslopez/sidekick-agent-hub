"""In-memory cache for completion responses."""

import os
import time
from typing import Optional

from models.request import CompletionRequest
from models.response import CompletionResponse

# Default cache TTL in milliseconds
DEFAULT_CACHE_TTL_MS = 30000

# Default maximum cache size
DEFAULT_CACHE_MAX_SIZE = 100

# Cache TTL from environment or default
CACHE_TTL_MS = int(os.environ.get("CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS))

# Maximum cache size from environment or default
CACHE_MAX_SIZE = int(os.environ.get("CACHE_MAX_SIZE", DEFAULT_CACHE_MAX_SIZE))


class CacheEntry:
    """Cache entry with response and timestamp."""

    def __init__(self, response: CompletionResponse, timestamp: float):
        self.response = response
        self.timestamp = timestamp


class CompletionCache:
    """
    In-memory cache for completion responses.
    Uses LRU-style eviction when max size is reached.
    """

    def __init__(
        self, ttl_ms: int = CACHE_TTL_MS, max_size: int = CACHE_MAX_SIZE
    ):
        self._cache: dict[str, CacheEntry] = {}
        self._ttl_ms = ttl_ms
        self._max_size = max_size

    def _hash_key(self, req: CompletionRequest) -> str:
        """
        Generate a cache key from a completion request.
        Uses the last 500 chars of prefix and first 200 chars of suffix
        to keep keys reasonably sized while still being unique enough.
        """
        prefix_tail = req.prefix[-500:] if len(req.prefix) > 500 else req.prefix
        suffix_head = (req.suffix or "")[:200]
        model = req.model or "haiku"
        return f"{req.language}:{model}:{prefix_tail}:{suffix_head}"

    def get(self, req: CompletionRequest) -> Optional[CompletionResponse]:
        """
        Get a cached response for a request.
        Returns None if not cached or expired.
        """
        key = self._hash_key(req)
        entry = self._cache.get(key)

        if entry is None:
            return None

        # Check if expired (convert TTL to seconds for comparison)
        now_ms = time.time() * 1000
        if now_ms - entry.timestamp > self._ttl_ms:
            del self._cache[key]
            return None

        return entry.response

    def set(self, req: CompletionRequest, response: CompletionResponse) -> None:
        """
        Cache a response for a request.
        Only caches successful completions (non-empty, no error).
        """
        # Only cache successful completions
        if not response.completion or response.error:
            return

        # Evict oldest entry if at capacity
        if len(self._cache) >= self._max_size:
            oldest = self._find_oldest_entry()
            if oldest:
                del self._cache[oldest]

        key = self._hash_key(req)
        self._cache[key] = CacheEntry(
            response=response,
            timestamp=time.time() * 1000,  # Store in milliseconds
        )

    def _find_oldest_entry(self) -> Optional[str]:
        """Find the oldest cache entry key."""
        oldest_key: Optional[str] = None
        oldest_time = float("inf")

        for key, entry in self._cache.items():
            if entry.timestamp < oldest_time:
                oldest_time = entry.timestamp
                oldest_key = key

        return oldest_key

    def clear(self) -> None:
        """Clear all cached entries."""
        self._cache.clear()

    def size(self) -> int:
        """Get the current cache size."""
        return len(self._cache)


# Singleton cache instance
completion_cache = CompletionCache()
