"""Tests for the rate limiter."""

import asyncio
import pytest

from utils.rate_limiter import RateLimiter


@pytest.fixture
def limiter():
    """Create a fresh rate limiter for each test."""
    return RateLimiter(window_ms=1000, max_requests=5)  # 1 second window, 5 requests max


def test_allow_under_limit(limiter):
    """Should allow requests under the limit."""
    assert limiter.is_allowed() is True
    assert limiter.is_allowed() is True
    assert limiter.is_allowed() is True


def test_deny_when_exceeded(limiter):
    """Should deny requests when limit is exceeded."""
    # Use up the limit
    for _ in range(5):
        assert limiter.is_allowed() is True

    # Next request should be denied
    assert limiter.is_allowed() is False


def test_track_current_count(limiter):
    """Should track current count."""
    assert limiter.get_current_count() == 0

    limiter.is_allowed()
    assert limiter.get_current_count() == 1

    limiter.is_allowed()
    assert limiter.get_current_count() == 2


def test_retry_after_seconds(limiter):
    """Should provide retry-after seconds."""
    # Fill up the limit
    for _ in range(5):
        limiter.is_allowed()

    retry_after = limiter.get_retry_after_seconds()
    # Should be approximately 1 second (the window size)
    assert retry_after > 0
    assert retry_after <= 1


def test_reset_limiter(limiter):
    """Should reset the limiter."""
    limiter.is_allowed()
    limiter.is_allowed()
    assert limiter.get_current_count() == 2

    limiter.reset()
    assert limiter.get_current_count() == 0


@pytest.mark.asyncio
async def test_allow_after_window_expires():
    """Should allow requests after window expires."""
    short_limiter = RateLimiter(window_ms=50, max_requests=2)  # 50ms window, 2 requests

    # Use up the limit
    assert short_limiter.is_allowed() is True
    assert short_limiter.is_allowed() is True
    assert short_limiter.is_allowed() is False

    # Wait for window to expire
    await asyncio.sleep(0.06)

    # Should be allowed again
    assert short_limiter.is_allowed() is True
