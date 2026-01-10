"""Tests for the completion cache."""

import asyncio
import pytest

from models.request import CompletionRequest
from models.response import CompletionResponse
from utils.cache import CompletionCache


@pytest.fixture
def cache():
    """Create a fresh cache for each test."""
    return CompletionCache(ttl_ms=1000, max_size=10)  # 1 second TTL, max 10 entries


def test_cache_miss(cache):
    """Should return None for cache miss."""
    result = cache.get(CompletionRequest(prefix="test", language="typescript"))
    assert result is None


def test_cache_and_retrieve(cache):
    """Should cache and retrieve a response."""
    request = CompletionRequest(prefix="const x = ", language="typescript")
    response = CompletionResponse(completion="42")

    cache.set(request, response)
    cached = cache.get(request)

    assert cached is not None
    assert cached.completion == response.completion


def test_no_cache_empty_completions(cache):
    """Should not cache empty completions."""
    request = CompletionRequest(prefix="test", language="typescript")
    response = CompletionResponse(completion="")

    cache.set(request, response)
    cached = cache.get(request)

    assert cached is None


def test_no_cache_error_responses(cache):
    """Should not cache responses with errors."""
    request = CompletionRequest(prefix="test", language="typescript")
    response = CompletionResponse(completion="42", error="Some error")

    cache.set(request, response)
    cached = cache.get(request)

    assert cached is None


def test_differentiate_by_language(cache):
    """Should differentiate by language."""
    request1 = CompletionRequest(prefix="test", language="typescript")
    request2 = CompletionRequest(prefix="test", language="python")
    response1 = CompletionResponse(completion="ts-completion")
    response2 = CompletionResponse(completion="py-completion")

    cache.set(request1, response1)
    cache.set(request2, response2)

    cached1 = cache.get(request1)
    cached2 = cache.get(request2)

    assert cached1 is not None
    assert cached2 is not None
    assert cached1.completion == "ts-completion"
    assert cached2.completion == "py-completion"


def test_differentiate_by_model(cache):
    """Should differentiate by model."""
    request1 = CompletionRequest(prefix="test", language="typescript", model="haiku")
    request2 = CompletionRequest(prefix="test", language="typescript", model="sonnet")
    response1 = CompletionResponse(completion="haiku-completion")
    response2 = CompletionResponse(completion="sonnet-completion")

    cache.set(request1, response1)
    cache.set(request2, response2)

    cached1 = cache.get(request1)
    cached2 = cache.get(request2)

    assert cached1 is not None
    assert cached2 is not None
    assert cached1.completion == "haiku-completion"
    assert cached2.completion == "sonnet-completion"


def test_evict_oldest_at_capacity():
    """Should evict oldest entry when at capacity."""
    cache = CompletionCache(ttl_ms=10000, max_size=2)  # 2 entry max

    cache.set(
        CompletionRequest(prefix="1", language="ts"),
        CompletionResponse(completion="one"),
    )
    cache.set(
        CompletionRequest(prefix="2", language="ts"),
        CompletionResponse(completion="two"),
    )
    cache.set(
        CompletionRequest(prefix="3", language="ts"),
        CompletionResponse(completion="three"),
    )

    assert cache.size() == 2
    assert cache.get(CompletionRequest(prefix="1", language="ts")) is None

    cached2 = cache.get(CompletionRequest(prefix="2", language="ts"))
    cached3 = cache.get(CompletionRequest(prefix="3", language="ts"))

    assert cached2 is not None
    assert cached2.completion == "two"
    assert cached3 is not None
    assert cached3.completion == "three"


@pytest.mark.asyncio
async def test_expire_after_ttl():
    """Should expire entries after TTL."""
    cache = CompletionCache(ttl_ms=50, max_size=10)  # 50ms TTL

    request = CompletionRequest(prefix="test", language="ts")
    cache.set(request, CompletionResponse(completion="value"))

    cached = cache.get(request)
    assert cached is not None
    assert cached.completion == "value"

    # Wait for expiration
    await asyncio.sleep(0.06)

    assert cache.get(request) is None


def test_clear_all_entries(cache):
    """Should clear all entries."""
    cache.set(
        CompletionRequest(prefix="1", language="ts"),
        CompletionResponse(completion="one"),
    )
    cache.set(
        CompletionRequest(prefix="2", language="ts"),
        CompletionResponse(completion="two"),
    )

    assert cache.size() == 2

    cache.clear()

    assert cache.size() == 0
    assert cache.get(CompletionRequest(prefix="1", language="ts")) is None
