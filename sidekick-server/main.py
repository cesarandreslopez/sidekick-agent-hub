"""Sidekick for Max Server - FastAPI Application."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html, get_redoc_html
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import settings, VERSION
from routers.completion import router as completion_router
from utils.logger import log

# Static files directory
STATIC_DIR = Path(__file__).parent / "static"
FAVICON_PATH = STATIC_DIR / "favicon.ico"

# Shutdown timeout in seconds
SHUTDOWN_TIMEOUT_SECONDS = 10


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Handle startup and shutdown events for the FastAPI application.
    
    This async context manager manages the application lifecycle, performing
    initialization tasks on startup and cleanup tasks on shutdown.
    
    Args:
        app: The FastAPI application instance.
        
    Yields:
        None: Control is yielded to the application after startup completes.
        
    Note:
        Uvicorn handles graceful shutdown of in-flight requests automatically.
        The shutdown phase only logs the event and closes the logger.
    """
    # Startup
    log.info(f"Server started on http://localhost:{settings.port}")
    log.info("Sidekick for Max - using your Claude Max subscription")
    log.info("Endpoints: POST /inline, POST /transform, GET /health")
    log.info(f"Logging to: {log.get_log_file_path()}")

    yield

    # Shutdown (uvicorn handles graceful shutdown of in-flight requests)
    log.info("Server shutting down gracefully...")
    log.close()


app = FastAPI(
    title="Sidekick for Max Server",
    description="AI-powered code completion and transformation server for Claude Max subscribers",
    version=VERSION,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """Serve favicon for browser tabs and docs pages."""
    return FileResponse(FAVICON_PATH, media_type="image/x-icon")


@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui_html():
    """Serve Swagger UI with custom favicon."""
    return get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=f"{app.title} - Swagger UI",
        swagger_favicon_url="/favicon.ico",
    )


@app.get("/redoc", include_in_schema=False)
async def custom_redoc_html():
    """Serve ReDoc with custom favicon."""
    return get_redoc_html(
        openapi_url=app.openapi_url,
        title=f"{app.title} - ReDoc",
        redoc_favicon_url="/favicon.ico",
    )

# CORS middleware for VS Code extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS", "GET"],
    allow_headers=["Content-Type"],
)

# Include routers
app.include_router(completion_router)

# Serve static files (icon, etc.)
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    # Uvicorn handles graceful shutdown:
    # - SIGTERM/SIGINT triggers shutdown
    # - Stops accepting new connections
    # - Waits for in-flight requests (up to timeout)
    # - Calls lifespan shutdown
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=True,
        timeout_graceful_shutdown=SHUTDOWN_TIMEOUT_SECONDS,
    )
