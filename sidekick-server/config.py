"""Configuration settings for the server."""

import tomllib
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Server configuration from environment variables."""

    # Server settings
    port: int = 3456

    # Cache settings
    cache_ttl_ms: int = 30000
    cache_max_size: int = 100

    # Rate limiting settings
    rate_limit_window_ms: int = 60000
    rate_limit_max_requests: int = 60

    # Logging settings
    log_retention_days: int = 7

    # Completion settings
    completion_timeout_ms: Optional[int] = None

    class Config:
        env_prefix = ""
        case_sensitive = False


# Singleton settings instance
settings = Settings()


def get_version() -> str:
    """Read version from pyproject.toml."""
    try:
        pyproject_path = Path(__file__).parent / "pyproject.toml"
        with open(pyproject_path, "rb") as f:
            data = tomllib.load(f)
        return data.get("project", {}).get("version", "unknown")
    except Exception:
        return "unknown"


# Server version (read from pyproject.toml)
VERSION = get_version()
