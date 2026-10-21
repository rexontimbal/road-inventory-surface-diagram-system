"""Shared pytest fixtures for API-level tests.

Points the app at a throwaway SQLite file instead of the real local dev DB
(backend/data/road_inventory.db) or whatever DATABASE_URL is configured for
this machine. This can't be done via the DATABASE_URL env var -- app/db.py
treats "DATABASE_URL is set at all" as "assume Postgres" regardless of the
URL's actual scheme (IS_SQLITE = not bool(env var)), so a sqlite:// value
there would make it run Postgres-dialect migration SQL against a SQLite
file and crash. Instead: import app.db on its own (triggering its normal
module-level setup, including building an engine against whatever the real
default would be -- harmless, since create_engine() doesn't connect until
first use), then overwrite its engine/SessionLocal/IS_SQLITE in place
BEFORE anything else (app.main in particular, which imports `engine` by
value at its own import time) gets a chance to read them."""

import os
import tempfile
from pathlib import Path

os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
os.environ.setdefault("SESSION_SECRET", "test-only-session-secret-not-for-production")
os.environ.setdefault("GUEST_DATA_TTL_MINUTES", "15")
os.environ.setdefault("GUEST_CLEANUP_INTERVAL_MINUTES", "5")
# Isolates tests from whatever backend/.env has configured for local dev --
# a real value would be harmless here too (a fresh test DB never has
# owner_type='workspace' rows to migrate), but pinning it empty keeps the
# test environment fully self-contained either way.
os.environ["LEGACY_DATA_OWNER_EMAIL"] = ""

from sqlalchemy import create_engine, event  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import app.db as db_module  # noqa: E402

_tmp_db_path = Path(tempfile.mkdtemp(prefix="road_inventory_test_")) / "test.db"
_test_engine = create_engine(f"sqlite:///{_tmp_db_path}", connect_args={"check_same_thread": False})


@event.listens_for(_test_engine, "connect")
def _set_test_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


db_module.engine = _test_engine
db_module.IS_SQLITE = True
db_module.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_test_engine)

import contextlib  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Only imported now, after the patch above -- app.main runs
# Base.metadata.create_all(bind=engine)/ensure_schema() at its own import
# time, so it must see the patched engine/IS_SQLITE, not the original.
from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402
from app.scope import Scope, get_scope  # noqa: E402

FIXTURE_XLSX = Path(__file__).resolve().parent / "fixtures" / "dpwh_sample.xlsx"


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def make_user():
    """Inserts a real User row (so actor-name snapshotting on log entries
    has something real to read) and returns a Scope for it, ready to hand
    to the `as_user` fixture."""

    def _make(name: str, email: str) -> Scope:
        db = SessionLocal()
        try:
            user = User(
                google_id=f"test-google-id-{email}",
                email=email,
                name=name,
                avatar_url=None,
                created_at="2026-01-01T00:00:00+00:00",
                last_login_at="2026-01-01T00:00:00+00:00",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            return Scope(
                owner_type="user",
                owner_id=str(user.id),
                is_guest=False,
                user_id=user.id,
                user_name=user.name,
                user_email=user.email,
                user_avatar_url=user.avatar_url,
            )
        finally:
            db.close()

    return _make


@pytest.fixture()
def as_user(client):
    """`with as_user(scope_a): ...` makes every request in that block look
    like it came from a signed-in request for scope_a, via FastAPI's
    dependency_overrides on get_scope -- not a real session cookie.

    This app's actual sign-in mechanics (Google ID-token verification, JWT
    cookie issuance/decoding in app/auth.py) are exercised by hand against
    real Google accounts per the project's own test plan, not re-derived
    here. What these tests are for is the data-isolation guarantee that
    every route builds on top of get_scope (apply_scope/owner_kwargs) --
    overriding get_scope exercises exactly that code path end-to-end
    through the real HTTP routes, just without needing a real OAuth token."""

    @contextlib.contextmanager
    def _as(scope: Scope):
        app.dependency_overrides[get_scope] = lambda: scope
        try:
            yield
        finally:
            app.dependency_overrides.pop(get_scope, None)

    return _as


@pytest.fixture()
def upload_fixture_as(client, as_user):
    """upload_fixture_as(scope) runs the real preview -> commit upload flow
    (the same two-step flow the frontend uses) against the shared DPWH
    sample fixture, as the given user. Returns the commit response JSON."""

    def _upload(scope: Scope):
        with as_user(scope):
            with FIXTURE_XLSX.open("rb") as fh:
                preview_res = client.post(
                    "/api/roads/upload/preview",
                    files={
                        "file": (
                            "dpwh_sample.xlsx",
                            fh,
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        )
                    },
                )
            assert preview_res.status_code == 200, preview_res.text
            token = preview_res.json()["token"]
            commit_res = client.post("/api/roads/upload/commit", json={"token": token, "decisions": {}})
            assert commit_res.status_code == 200, commit_res.text
            return commit_res.json()

    return _upload
