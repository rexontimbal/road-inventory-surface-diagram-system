import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.auth import LOCAL_HOSTNAMES, get_current_user
from app.db import get_db
from app.models import WORKSPACE_OWNER_ID, GuestSession, Road, UploadLogEntry, User, WorkspaceShare

GUEST_COOKIE_NAME = "guest_id"
GUEST_DATA_TTL_MINUTES = int(os.environ.get("GUEST_DATA_TTL_MINUTES", "15"))
GUEST_CLEANUP_INTERVAL_MINUTES = int(os.environ.get("GUEST_CLEANUP_INTERVAL_MINUTES", "5"))
# 30 days -- long enough that the guest_id cookie itself basically never
# expires during normal use; the actual data lifetime is GUEST_DATA_TTL_MINUTES,
# enforced by the cleanup job below, completely independent of this cookie.
GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

# Which workspace a signed-in user is currently viewing -- "my own" (no
# cookie) or someone else's shared-with-me workspace (their user id, as a
# string). Separate from the session cookie so switching workspaces never
# touches auth. Not itself the source of truth for "do I have access" --
# get_scope re-checks the WorkspaceShare grant on every request, so a
# stale/forged cookie just falls back to the caller's own workspace rather
# than being trusted.
ACTIVE_WORKSPACE_COOKIE_NAME = "active_workspace"
ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60


def normalize_email(email: str) -> str:
    """Case-insensitive matching for invited_email <-> a signing-in Google
    account's email -- Google emails aren't stored lowercased, and the
    person sharing can't be expected to type it in the exact case the
    other account happens to use."""
    return email.strip().lower()


@dataclass(frozen=True)
class Scope:
    owner_type: str  # "user" | "guest" (plus the legacy "workspace", only
    # ever read from pre-existing rows -- no live request produces it anymore)
    owner_id: str | None  # guest_id for guest scope, str(<workspace owner's user id>) for a signed-in user
    is_guest: bool
    # The signed-in user who made THIS request, for "who did it" logging --
    # None for a guest. Stays the real caller even when owner_id points at
    # someone else's shared workspace (an Editor's actions are logged under
    # the Editor's own name, in the OWNER's history -- see user_kwargs).
    user_id: int | None = None
    user_name: str | None = None
    user_email: str | None = None
    user_avatar_url: str | None = None
    # The caller's permission level on the ACTIVE workspace (owner_id above).
    # "owner" for a guest (always their own sandbox) and for a signed-in
    # user viewing their own data; "editor"/"viewer" only when owner_id
    # belongs to someone else, via an active WorkspaceShare grant.
    role: str = "owner"
    # Set only when owner_id belongs to someone OTHER than the caller --
    # lets routers/the frontend show "Viewing <name>'s data" without a
    # second lookup.
    workspace_owner_user_id: int | None = None
    workspace_owner_name: str | None = None
    workspace_owner_email: str | None = None


def _resolve_active_workspace(request: Request, db: Session, user: User) -> Scope:
    """A signed-in user's own workspace, UNLESS the active_workspace cookie
    names a different user AND an active WorkspaceShare grants this user
    access to it -- in which case owner_id/role switch to that workspace
    while user_id/user_name etc. stay the real caller's own identity.

    Any reason the cookie can't be honored (missing, not a valid int, names
    the caller's own id, or no matching/longer-valid share) falls straight
    back to the caller's own workspace rather than raising -- exactly the
    "fall back to My data if access was removed" behavior the switcher UI
    wants, without a round trip through an error path."""
    own_scope = Scope(
        owner_type="user",
        owner_id=str(user.id),
        is_guest=False,
        user_id=user.id,
        user_name=user.name,
        user_email=user.email,
        user_avatar_url=user.avatar_url,
        role="owner",
    )

    raw = request.cookies.get(ACTIVE_WORKSPACE_COOKIE_NAME)
    if not raw:
        return own_scope
    try:
        active_owner_id = int(raw)
    except ValueError:
        return own_scope
    if active_owner_id == user.id:
        return own_scope

    share = (
        db.query(WorkspaceShare)
        .filter(WorkspaceShare.owner_user_id == active_owner_id, WorkspaceShare.user_id == user.id)
        .first()
    )
    if share is None:
        return own_scope
    owner_user = db.query(User).filter(User.id == active_owner_id).first()
    if owner_user is None:
        return own_scope

    return Scope(
        owner_type="user",
        owner_id=str(active_owner_id),
        is_guest=False,
        user_id=user.id,
        user_name=user.name,
        user_email=user.email,
        user_avatar_url=user.avatar_url,
        role=share.role,
        workspace_owner_user_id=active_owner_id,
        workspace_owner_name=owner_user.name,
        workspace_owner_email=owner_user.email,
    )


def get_scope(request: Request, response: Response, db: Session = Depends(get_db)) -> Scope:
    """FastAPI dependency resolving which data a request can see/write:
    - A signed-in user -> their own workspace by default (owner_id =
      str(user.id)), or -- if the active_workspace cookie names a workspace
      shared with them -- that workspace instead, with role set to the
      grant's role. See _resolve_active_workspace for the exact fallback
      rules.
    - Anyone else -> their own private "guest" sandbox, identified by a
      random cookie, created on first visit and refreshed (last_activity_at)
      on every request so the TTL cleanup job measures idle time correctly."""
    user = get_current_user(request, db)
    if user is not None:
        return _resolve_active_workspace(request, db, user)

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
    """No live Scope has owner_id=None anymore (user -> str(user.id), guest ->
    the guest cookie) -- this translation only matters for reading legacy
    owner_type='workspace' rows that predate per-user workspaces, where the
    DB column stores '' instead of NULL (see WORKSPACE_OWNER_ID's docstring
    in app/models.py for why: NULL can't be used in a uniqueness-enforcing
    key). Kept as a safety net, not something any current caller triggers."""
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
    owner_type, not via anything stored on this dict.

    Combined with owner_kwargs(scope) (which stamps owner_id as whichever
    workspace is ACTIVE), this is what makes an Editor's upload/edit/delete
    land in the OWNER's workspace while still being logged under the
    Editor's own name -- owner_kwargs uses scope.owner_id (the workspace),
    this uses scope.user_id/user_name (the real caller); no router needs to
    special-case "am I acting on someone else's behalf" itself."""
    return {
        "user_id": scope.user_id,
        "actor_name": scope.user_name,
        "actor_email": scope.user_email,
        "actor_avatar_url": scope.user_avatar_url,
    }


def require_editor(scope: Scope) -> None:
    """Raises 403 unless the caller can write to the active workspace
    (owner or editor). Guests are always "owner" of their own sandbox, so
    this never blocks guest actions."""
    if scope.role not in ("owner", "editor"):
        raise HTTPException(status_code=403, detail="View-only access")


def require_owner(scope: Scope) -> None:
    """Raises 403 unless the caller owns the active workspace -- for
    actions even an Editor can't do: managing sharing, and bulk/irreversible
    deletes (clearing the whole upload history)."""
    if scope.role != "owner":
        raise HTTPException(status_code=403, detail="Only the workspace owner can do this")


def set_active_workspace_cookie(request: Request, response: Response, owner_user_id: int | None) -> None:
    """owner_user_id=None clears the cookie (back to "my own data")."""
    if owner_user_id is None:
        response.delete_cookie(ACTIVE_WORKSPACE_COOKIE_NAME, path="/")
        return
    response.set_cookie(
        ACTIVE_WORKSPACE_COOKIE_NAME,
        str(owner_user_id),
        httponly=True,
        secure=request.url.hostname not in LOCAL_HOSTNAMES,
        samesite="lax",
        path="/",
        max_age=ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS,
    )


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
