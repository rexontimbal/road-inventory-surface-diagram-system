import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from app.auth import LOCAL_HOSTNAMES, get_current_user
from app.db import get_db
from app.models import WORKSPACE_OWNER_ID, GuestSession, Road, UploadLogEntry

GUEST_COOKIE_NAME = "guest_id"
GUEST_DATA_TTL_MINUTES = int(os.environ.get("GUEST_DATA_TTL_MINUTES", "15"))
GUEST_CLEANUP_INTERVAL_MINUTES = int(os.environ.get("GUEST_CLEANUP_INTERVAL_MINUTES", "5"))
# 30 days -- long enough that the guest_id cookie itself basically never
# expires during normal use; the actual data lifetime is GUEST_DATA_TTL_MINUTES,
# enforced by the cleanup job below, completely independent of this cookie.
GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60


@dataclass(frozen=True)
class Scope:
    owner_type: str  # "workspace" | "guest"
    owner_id: str | None  # guest_id for guest scope, always None for workspace
    is_guest: bool
    # The signed-in user who made this request, for "who did it" logging
    # (Part 5) -- None for a guest. Name/email/avatar are carried here too
    # so write_log_entry can snapshot them without a second DB lookup.
    user_id: int | None = None
    user_name: str | None = None
    user_email: str | None = None
    user_avatar_url: str | None = None


def get_scope(request: Request, response: Response, db: Session = Depends(get_db)) -> Scope:
    """FastAPI dependency resolving which data a request can see/write:
    - A signed-in user -> the one shared "workspace" (every signed-in user
      sees the same data, including everything uploaded before accounts
      existed).
    - Anyone else -> their own private "guest" sandbox, identified by a
      random cookie, created on first visit and refreshed (last_activity_at)
      on every request so the TTL cleanup job measures idle time correctly."""
    user = get_current_user(request, db)
    if user is not None:
        return Scope(
            owner_type="workspace",
            owner_id=None,
            is_guest=False,
            user_id=user.id,
            user_name=user.name,
            user_email=user.email,
            user_avatar_url=user.avatar_url,
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    guest_id = request.cookies.get(GUEST_COOKIE_NAME)
    session_row = db.query(GuestSession).filter(GuestSession.guest_id == guest_id).first() if guest_id else None

    if session_row is None:
        # No cookie, or the cookie points at a session the cleanup job
        # already reaped -- either way, start a fresh one.
        guest_id = secrets.token_hex(16)
        db.add(GuestSession(guest_id=guest_id, created_at=now_iso, last_activity_at=now_iso))
        db.commit()
        response.set_cookie(
            GUEST_COOKIE_NAME,
            guest_id,
            httponly=True,
            secure=request.url.hostname not in LOCAL_HOSTNAMES,
            samesite="lax",
            path="/",
            max_age=GUEST_COOKIE_MAX_AGE_SECONDS,
        )
    else:
        session_row.last_activity_at = now_iso
        db.commit()

    return Scope(owner_type="guest", owner_id=guest_id, is_guest=True)


def _db_owner_id(scope: Scope) -> str:
    """Scope.owner_id is None (at the API/app layer) for the workspace, but
    the DB column stores '' there instead -- see WORKSPACE_OWNER_ID's
    docstring in app/models.py for why (NULL can't be used in a
    uniqueness-enforcing key)."""
    return scope.owner_id if scope.owner_id is not None else WORKSPACE_OWNER_ID


def apply_scope(query, model, scope: Scope):
    """Filters a query to only the rows the given scope can see."""
    return query.filter(model.owner_type == scope.owner_type, model.owner_id == _db_owner_id(scope))


def owner_kwargs(scope: Scope) -> dict:
    """Stamp kwargs for constructing a new Road/UploadLogEntry row in the
    caller's current scope."""
    return {"owner_type": scope.owner_type, "owner_id": _db_owner_id(scope)}


def user_kwargs(scope: Scope) -> dict:
    """Actor-stamp kwargs for write_log_entry (Part 5) -- separate from
    owner_kwargs because only UploadLogEntry has these columns; applying
    this to a Road(...) constructor would fail with an unknown-column
    error. All None for a guest action (UI shows "Guest") or for a
    workspace action from before this tracking existed (UI shows
    "Unknown") -- those two read the same four Nones differently via
    owner_type, not via anything stored on this dict."""
    return {
        "user_id": scope.user_id,
        "actor_name": scope.user_name,
        "actor_email": scope.user_email,
        "actor_avatar_url": scope.user_avatar_url,
    }


def cleanup_expired_guests(db: Session) -> int:
    """Deletes every guest session idle past GUEST_DATA_TTL_MINUTES, along
    with their roads (segments cascade via the FK), and their upload-log
    entries. Returns how many guest sessions were reaped. Called both by the
    periodic background task (app/main.py) and opportunistically so a very
    long-idle backend (dev reload, etc.) doesn't accumulate a huge backlog
    before the next timer tick."""
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=GUEST_DATA_TTL_MINUTES)).isoformat()
    expired = db.query(GuestSession).filter(GuestSession.last_activity_at < cutoff).all()
    for session_row in expired:
        db.query(Road).filter(Road.owner_type == "guest", Road.owner_id == session_row.guest_id).delete()
        db.query(UploadLogEntry).filter(
            UploadLogEntry.owner_type == "guest", UploadLogEntry.owner_id == session_row.guest_id
        ).delete()
        db.delete(session_row)
    if expired:
        db.commit()
    return len(expired)
