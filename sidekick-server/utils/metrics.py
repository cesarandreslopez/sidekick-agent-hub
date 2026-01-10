"""Server metrics tracking for observability."""

from models.response import MetricsSnapshot

# Maximum response times to keep for averaging
MAX_RESPONSE_TIMES = 1000


class Metrics:
    """
    Tracks server metrics for observability and monitoring.
    Maintains rolling averages for response times.
    """

    def __init__(self):
        self._total_requests = 0
        self._cache_hits = 0
        self._response_times: list[float] = []
        self._requests_by_model: dict[str, int] = {}
        self._error_count = 0

    def record_request(
        self,
        model: str,
        response_time_ms: float,
        cache_hit: bool,
        error: bool,
    ) -> None:
        """
        Record a completed request.

        Args:
            model: The model used for the request
            response_time_ms: How long the request took in milliseconds
            cache_hit: Whether the request was served from cache
            error: Whether the request resulted in an error
        """
        self._total_requests += 1

        if cache_hit:
            self._cache_hits += 1

        if error:
            self._error_count += 1

        # Track by model
        self._requests_by_model[model] = self._requests_by_model.get(model, 0) + 1

        # Track response time (rolling window)
        self._response_times.append(response_time_ms)
        if len(self._response_times) > MAX_RESPONSE_TIMES:
            self._response_times.pop(0)

    def get_metrics(self) -> MetricsSnapshot:
        """Get a snapshot of current metrics."""
        avg_response_time_ms = (
            round(sum(self._response_times) / len(self._response_times))
            if self._response_times
            else 0
        )

        cache_hit_rate = (
            round((self._cache_hits / self._total_requests) * 100) / 100
            if self._total_requests > 0
            else 0
        )

        return MetricsSnapshot(
            totalRequests=self._total_requests,
            cacheHits=self._cache_hits,
            cacheHitRate=cache_hit_rate,
            avgResponseTimeMs=avg_response_time_ms,
            requestsByModel=dict(self._requests_by_model),
            errorCount=self._error_count,
        )

    def reset(self) -> None:
        """Reset all metrics. Useful for testing."""
        self._total_requests = 0
        self._cache_hits = 0
        self._response_times = []
        self._requests_by_model = {}
        self._error_count = 0


# Singleton metrics instance
metrics = Metrics()
