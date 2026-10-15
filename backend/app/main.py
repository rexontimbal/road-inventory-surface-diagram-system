from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from app.db import Base, engine, ensure_schema
from app.routers import auth, backup, roads

Base.metadata.create_all(bind=engine)
ensure_schema()

app = FastAPI(title="Road Inventory & Surface Diagram System")

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


@app.get("/api/health")
def health():
    return {"status": "ok"}


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
