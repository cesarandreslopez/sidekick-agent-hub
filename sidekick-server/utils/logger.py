"""Logger that writes to both console and timestamped log files."""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# Default log retention period in days
DEFAULT_LOG_RETENTION_DAYS = 7

# Log retention period from environment or default
LOG_RETENTION_DAYS = int(os.environ.get("LOG_RETENTION_DAYS", DEFAULT_LOG_RETENTION_DAYS))


class Logger:
    """
    Logger that writes to both console and a timestamped log file.
    A new log file is created each time the server starts.
    Old log files are automatically deleted based on retention period.
    """

    def __init__(self):
        self._log_file: Optional[Any] = None
        self._log_file_path: Optional[str] = None
        self._logs_dir = Path(__file__).parent.parent / "logs"
        self._init_log_file()
        self._clean_old_logs()

    def _init_log_file(self) -> None:
        """Initialize the log file."""
        # Ensure logs directory exists
        self._logs_dir.mkdir(parents=True, exist_ok=True)

        # Create timestamped log file
        timestamp = datetime.now().isoformat().replace(":", "-").replace(".", "-")
        self._log_file_path = str(self._logs_dir / f"server-{timestamp}.log")
        self._log_file = open(self._log_file_path, "a", encoding="utf-8")

    def _clean_old_logs(self) -> None:
        """Delete log files older than the retention period."""
        try:
            max_age_seconds = LOG_RETENTION_DAYS * 24 * 60 * 60
            now = datetime.now().timestamp()

            for file in self._logs_dir.iterdir():
                if not file.suffix == ".log":
                    continue

                try:
                    stat = file.stat()
                    if now - stat.st_mtime > max_age_seconds:
                        file.unlink()
                        print(f"[Logger] Deleted old log file: {file.name}")
                except Exception:
                    # Ignore errors for individual files
                    pass
        except Exception:
            # Ignore errors during cleanup
            pass

    def _write(self, level: str, msg: str, data: Optional[dict[str, Any]] = None) -> None:
        """Write a log message to console and file."""
        timestamp = datetime.now().isoformat()

        # Human-readable format for console
        data_str = " " + json.dumps(data) if data else ""
        console_log = f"[{timestamp}] {level}: {msg}{data_str}"

        if level == "ERROR":
            print(console_log, file=sys.stderr)
        else:
            print(console_log)

        # Structured JSON format for file (JSON Lines)
        if self._log_file:
            structured_log = {
                "timestamp": timestamp,
                "level": level,
                "message": msg,
                **(data or {}),
            }
            self._log_file.write(json.dumps(structured_log) + "\n")
            self._log_file.flush()

    def info(self, msg: str, data: Optional[dict[str, Any]] = None) -> None:
        """Log an info message."""
        self._write("INFO", msg, data)

    def debug(self, msg: str, data: Optional[dict[str, Any]] = None) -> None:
        """Log a debug message."""
        self._write("DEBUG", msg, data)

    def error(self, msg: str, data: Optional[dict[str, Any]] = None) -> None:
        """Log an error message."""
        self._write("ERROR", msg, data)

    def get_log_file_path(self) -> Optional[str]:
        """Get the current log file path."""
        return self._log_file_path

    def close(self) -> None:
        """Close the log stream. Call this during graceful shutdown."""
        if self._log_file:
            self._log_file.close()
            self._log_file = None

    def get_logs_dir(self) -> str:
        """Get the logs directory path."""
        return str(self._logs_dir)


# Singleton logger instance
log = Logger()
