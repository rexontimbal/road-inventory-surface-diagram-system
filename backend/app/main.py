import asyncio
import contextlib
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse, JSONResponse

from app import config  # noqa: F401 -- loads backend/.env before the os.environ reads below (this app, db, auth)
from app.db import IS_SQLITE, Base, SessionLocal, engine, ensure_schema
from app.routers import auth, backup, guest, roads, workspace
from app.scope import GUEST_CLEANUP_INTERVAL_MINUTES, cleanup_expired_guests

Base.metadata.create_all(bind=engine)
ensure_schema()

GOOGLE_CLIENT_ID_CONFIGURED = bool(os.environ.get("GOOGLE_CLIENT_ID"))
SESSION_SECRET_CONFIGURED = bool(os.environ.get("SESSION_SECRET"))
# Values are never logged -- only whether each var is present, so this is
# safe to leave in production logs.
print(f"GOOGLE_CLIENT_ID configured: {'yes' if GOOGLE_CLIENT_ID_CONFIGURED else 'no'}")
print(f"SESSION_SECRET configured: {'yes' if SESSION_SECRET_CONFIGURED else 'no'}")

async def _guest_cleanup_loop():
    """Runs for the lifetime of the process, reaping guest data idle past
    GUEST_DATA_TTL_MINUTES -- once immediately on startup (so a restart
    during testing with a short TTL doesn't leave stale data sitting until
    the first tick), then every GUEST_CLEANUP_INTERVAL_MINUTES after that. A
    fresh session is opened per tick (not reused across sleeps) since this
    is a long-lived background loop, not a per-request session."""
    interval_seconds = GUEST_CLEANUP_INTERVAL_MINUTES * 60
    while True:
        db = SessionLocal()
        try:
            reaped = cleanup_expired_guests(db)
            if reaped:
                print(f"Guest cleanup: removed {reaped} expired guest session(s)")
        except Exception as exc:  # noqa: BLE001 -- a bad tick must not kill the loop
            print(f"Guest cleanup tick failed: {exc}")
        finally:
            db.close()
        await asyncio.sleep(interval_seconds)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_guest_cleanup_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Road Inventory & Surface Diagram System", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Only matters for local dev, where the Vite dev server (5173) and the
    # backend (8000) are different origins -- in production the built
    # frontend is served by this same app (see FRONTEND_DIST below), so
    # there's no cross-origin request to allow. allow_credentials requires
    # an explicit origin list (no "*"), since auth now relies on cookies.
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(roads.router)
app.include_router(backup.router)
app.include_router(auth.router)
app.include_router(guest.router)
app.include_router(workspace.router)

_logger = logging.getLogger("app")


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """FastAPI's own default for an exception that escapes a route handler
    (anything that isn't an HTTPException, which it already turns into a
    proper JSON response on its own) is a bare "Internal Server Error" text
    body -- unhelpful to the user and, worse, a dead end for debugging since
    nothing about the failure is written anywhere. This logs the full
    traceback server-side (exc_info=exc, so it prints the real stack, not
    just the exception's str()) and returns one generic, friendly message
    instead -- the real detail belongs in the server log, not the response
    body, so a bug's internals are never exposed to whoever hit it."""
    _logger.error("Unhandled exception on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on our end. Please try again."})


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "auth_configured": GOOGLE_CLIENT_ID_CONFIGURED,
        # Lets a deploy be confirmed as actually using the configured
        # DATABASE_URL (Postgres) rather than silently falling back to the
        # local SQLite file -- no secret in this, just which engine.
        "database": "sqlite" if IS_SQLITE else "postgres",
    }


# Serve the built React app (frontend/dist) when present, so the whole
# system runs as a single process/URL in production/hosted deployments.
# In local dev, the frontend runs separately via its own Vite dev server
# instead, so `dist` won't exist and this block is skipped.
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
