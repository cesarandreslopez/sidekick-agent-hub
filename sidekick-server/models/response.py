"""Response models for the completion API."""

from typing import Dict, Optional

from pydantic import BaseModel, Field


class MetricsSnapshot(BaseModel):
    """Snapshot of server metrics."""

    totalRequests: int = Field(default=0, description="Total request count")
    cacheHits: int = Field(default=0, description="Number of cache hits")
    cacheHitRate: float = Field(default=0.0, description="Cache hit percentage")
    avgResponseTimeMs: float = Field(default=0.0, description="Average response time")
    requestsByModel: Dict[str, int] = Field(
        default_factory=dict, description="Requests per model"
    )
    errorCount: int = Field(default=0, description="Total error count")


class CompletionResponse(BaseModel):
    """Response model for code completion."""

    completion: str = Field(default="", description="Generated code completion")
    error: Optional[str] = Field(default=None, description="Error message if failed")
    requestId: Optional[str] = Field(default=None, description="Request tracking ID")


class ModifyResponse(BaseModel):
    """Response model for code modification."""

    modified_code: str = Field(default="", description="Modified code")
    error: Optional[str] = Field(default=None, description="Error message if failed")
    requestId: Optional[str] = Field(default=None, description="Request tracking ID")


class HealthResponse(BaseModel):
    """Response model for health check endpoint."""

    status: str = Field(default="ok", description="Server status")
    version: str = Field(description="Server version")
    uptime: float = Field(description="Uptime in seconds")
    uptimeHuman: str = Field(description="Human-readable uptime")
    logFile: str = Field(description="Path to current log file")
    metrics: MetricsSnapshot = Field(description="Current metrics snapshot")
