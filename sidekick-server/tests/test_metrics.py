"""Tests for the metrics module."""

import pytest

from utils.metrics import Metrics


@pytest.fixture
def metrics_instance():
    """Create a fresh metrics instance for each test."""
    return Metrics()


def test_start_with_zero_metrics(metrics_instance):
    """Should start with zero metrics."""
    snapshot = metrics_instance.get_metrics()

    assert snapshot.totalRequests == 0
    assert snapshot.cacheHits == 0
    assert snapshot.cacheHitRate == 0
    assert snapshot.avgResponseTimeMs == 0
    assert snapshot.requestsByModel == {}
    assert snapshot.errorCount == 0


def test_track_total_requests(metrics_instance):
    """Should track total requests."""
    metrics_instance.record_request("haiku", 100, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 150, cache_hit=False, error=False)
    metrics_instance.record_request("sonnet", 200, cache_hit=False, error=False)

    snapshot = metrics_instance.get_metrics()
    assert snapshot.totalRequests == 3


def test_track_cache_hits(metrics_instance):
    """Should track cache hits."""
    metrics_instance.record_request("haiku", 5, cache_hit=True, error=False)
    metrics_instance.record_request("haiku", 100, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 3, cache_hit=True, error=False)

    snapshot = metrics_instance.get_metrics()
    assert snapshot.cacheHits == 2
    assert snapshot.cacheHitRate == 0.67  # 2/3 rounded to 2 decimal places


def test_track_errors(metrics_instance):
    """Should track errors."""
    metrics_instance.record_request("haiku", 100, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 5000, cache_hit=False, error=True)
    metrics_instance.record_request("sonnet", 10000, cache_hit=False, error=True)

    snapshot = metrics_instance.get_metrics()
    assert snapshot.errorCount == 2


def test_track_requests_by_model(metrics_instance):
    """Should track requests by model."""
    metrics_instance.record_request("haiku", 100, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 150, cache_hit=False, error=False)
    metrics_instance.record_request("sonnet", 200, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 120, cache_hit=False, error=False)

    snapshot = metrics_instance.get_metrics()
    assert snapshot.requestsByModel == {"haiku": 3, "sonnet": 1}


def test_calculate_average_response_time(metrics_instance):
    """Should calculate average response time."""
    metrics_instance.record_request("haiku", 100, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 200, cache_hit=False, error=False)
    metrics_instance.record_request("haiku", 300, cache_hit=False, error=False)

    snapshot = metrics_instance.get_metrics()
    assert snapshot.avgResponseTimeMs == 200  # (100+200+300)/3


def test_reset_all_metrics(metrics_instance):
    """Should reset all metrics."""
    metrics_instance.record_request("haiku", 100, cache_hit=True, error=False)
    metrics_instance.record_request("sonnet", 200, cache_hit=False, error=True)

    metrics_instance.reset()
    snapshot = metrics_instance.get_metrics()

    assert snapshot.totalRequests == 0
    assert snapshot.cacheHits == 0
    assert snapshot.errorCount == 0
    assert snapshot.requestsByModel == {}


def test_return_copy_of_requests_by_model(metrics_instance):
    """Should return copy of requestsByModel to prevent mutation."""
    metrics_instance.record_request("haiku", 100, cache_hit=False, error=False)

    snapshot = metrics_instance.get_metrics()
    snapshot.requestsByModel["haiku"] = 999

    new_snapshot = metrics_instance.get_metrics()
    assert new_snapshot.requestsByModel["haiku"] == 1
