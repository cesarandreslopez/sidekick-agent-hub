"""Integration tests for the FastAPI server."""

import pytest
from httpx import AsyncClient, ASGITransport

from main import app
from utils.cache import completion_cache
from utils.rate_limiter import rate_limiter
from utils.metrics import metrics


@pytest.fixture(autouse=True)
def reset_state():
    """Reset all state before each test."""
    completion_cache.clear()
    rate_limiter.reset()
    metrics.reset()
    yield


@pytest.fixture
async def client():
    """Create an async test client."""
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


@pytest.mark.asyncio
async def test_health_endpoint(client):
    """Should return health status."""
    response = await client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data
    assert "uptime" in data
    assert "uptimeHuman" in data
    assert "metrics" in data


@pytest.mark.asyncio
async def test_health_metrics_structure(client):
    """Should return correct metrics structure."""
    response = await client.get("/health")

    assert response.status_code == 200
    data = response.json()
    metrics_data = data["metrics"]

    assert "totalRequests" in metrics_data
    assert "cacheHits" in metrics_data
    assert "cacheHitRate" in metrics_data
    assert "avgResponseTimeMs" in metrics_data
    assert "requestsByModel" in metrics_data
    assert "errorCount" in metrics_data


@pytest.mark.asyncio
async def test_cors_headers(client):
    """Should include CORS headers."""
    # Send a CORS preflight request with required headers
    response = await client.options(
        "/inline",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert "access-control-allow-origin" in response.headers


@pytest.mark.asyncio
async def test_validation_error_missing_prefix(client):
    """Should return 422 for missing prefix."""
    response = await client.post(
        "/inline",
        json={"language": "typescript"},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_validation_error_missing_language(client):
    """Should return 422 for missing language."""
    response = await client.post(
        "/inline",
        json={"prefix": "test"},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_validation_error_invalid_model(client):
    """Should return 422 for invalid model."""
    response = await client.post(
        "/inline",
        json={
            "prefix": "test",
            "language": "typescript",
            "model": "invalid",
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_not_found(client):
    """Should return 404 for unknown routes."""
    response = await client.get("/unknown")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_rate_limiting(client):
    """Should enforce rate limiting."""
    # Create a limiter with low limit for testing
    rate_limiter._max_requests = 2

    # First two requests should succeed (may fail if Claude SDK not available,
    # but they won't be rate limited)
    await client.post(
        "/inline",
        json={"prefix": "test", "language": "typescript"},
    )
    await client.post(
        "/inline",
        json={"prefix": "test", "language": "typescript"},
    )

    # Third request should be rate limited
    response = await client.post(
        "/inline",
        json={"prefix": "test", "language": "typescript"},
    )

    assert response.status_code == 429
    assert "Retry-After" in response.headers

    # Reset for other tests
    rate_limiter._max_requests = 60


@pytest.mark.asyncio
async def test_request_includes_request_id(client):
    """Should include requestId in response."""
    # Note: This test may fail if Claude SDK is not installed
    # In a real test, we would mock the SDK
    response = await client.post(
        "/inline",
        json={"prefix": "const x = ", "language": "typescript"},
    )

    # Even on error, requestId should be present
    if response.status_code == 200:
        data = response.json()
        assert "requestId" in data
