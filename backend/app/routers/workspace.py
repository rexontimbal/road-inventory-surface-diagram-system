from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import User, WorkspaceShare
from app.schemas import (
    MarkNotificationsSeenIn,
    NotificationsOut,
    ShareIn,
    ShareNotificationOut,
    ShareOut,
    ShareOwnerOut,
    ShareRoleIn,
    SharedWorkspaceOut,
    SharesListOut,
    WorkspaceContextOut,
    WorkspaceSwitchIn,
)
from app.scope import (
    ACTIVE_WORKSPACE_COOKIE_NAME,
    Scope,
    get_scope,
    normalize_email,
    owner_kwargs,
    require_owner,
    set_active_workspace_cookie,
    user_kwargs,
)
from app.upload_log import write_log_entry

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


def _require_signed_in_user(request: Request, db: Session) -> User:
    user = get_current_user(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required")
    return user


def _role_label(role: str) -> str:
    return "Editor" if role == "editor" else "Viewer"


def _share_out(row: WorkspaceShare, person: User | None) -> ShareOut:
    return ShareOut(
        id=row.id,
        email=person.email if person else row.invited_email,
        role=row.role,
        name=person.name if person else None,
        avatar_url=person.avatar_url if person else None,
        pending=row.user_id is None,
    )


def _log_share_action(db: Session, scope: Scope, sentence: str) -> None:
    write_log_entry(
        db,
        kind="share",
        status="completed",
        file_name=sentence,
        **owner_kwargs(scope),
        **user_kwargs(scope),
    )


def _mark_new(row: WorkspaceShare, last_change: str) -> None:
    """Flags a share as unseen again -- called on creation and on every role
    change (not just creation), since both are things the recipient hasn't
    looked at yet and the badge/dropdown/toast all need to represent."""
    row.seen_at = None
    row.last_change = last_change


@router.get("/context", response_model=WorkspaceContextOut)
def get_context(request: Request, response: Response, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Drives the workspace switcher and the "Viewing X's data" banner: the
    ACTIVE workspace (own, or someone else's via the active_workspace
    cookie -- see get_scope) plus the full list of workspaces shared with
    this account, so the switcher can list all of them regardless of which
    one happens to be active right now.

    Also the one place that detects and reports "the workspace you were
    viewing isn't shared with you anymore" -- get_scope itself already
    fell back silently (every route needs that to just keep working), but
    only this endpoint is polled/fetched by the frontend specifically to
    learn about the active workspace, so it's the right (and only) place
    to both clear the now-stale cookie and report it, exactly once."""
    user = _require_signed_in_user(request, db)

    access_removed_owner_name = None
    raw_cookie = request.cookies.get(ACTIVE_WORKSPACE_COOKIE_NAME)
    if raw_cookie and scope.workspace_owner_user_id is None:
        try:
            cookie_owner_id = int(raw_cookie)
        except ValueError:
            cookie_owner_id = None
        if cookie_owner_id is not None and cookie_owner_id != user.id:
            # get_scope already fell back to "own" for this exact reason --
            # the cookie names a workspace but no grant matches anymore.
            removed_owner = db.query(User).filter(User.id == cookie_owner_id).first()
            access_removed_owner_name = removed_owner.name if removed_owner else "that workspace's owner"
            set_active_workspace_cookie(request, response, None)

    shared_rows = (
        db.query(WorkspaceShare, User)
        .join(User, User.id == WorkspaceShare.owner_user_id)
        .filter(WorkspaceShare.user_id == user.id)
        .order_by(User.name)
        .all()
    )
    shared_with_me = [
        SharedWorkspaceOut(
            share_id=share.id,
            owner_user_id=owner.id,
            owner_name=owner.name,
            owner_email=owner.email,
            owner_avatar_url=owner.avatar_url,
            role=share.role,
            is_new=share.seen_at is None,
            last_change=share.last_change,
        )
        for share, owner in shared_rows
    ]

    if scope.workspace_owner_user_id is not None:
        return WorkspaceContextOut(
            mode="shared",
            role=scope.role,
            owner_user_id=scope.workspace_owner_user_id,
            owner_name=scope.workspace_owner_name,
            owner_email=scope.workspace_owner_email,
            shared_with_me=shared_with_me,
            access_removed_owner_name=access_removed_owner_name,
        )
    return WorkspaceContextOut(
        mode="own", role="owner", shared_with_me=shared_with_me, access_removed_owner_name=access_removed_owner_name
    )


@router.get("/notifications", response_model=NotificationsOut)
def get_notifications(request: Request, db: Session = Depends(get_db)):
    """Lightweight endpoint for the 60s background poll (Part 6) and the
    avatar badge/toast -- scoped to shares made TO the caller (as
    recipient), the mirror image of GET /shares (made BY the caller, as
    owner). Always only the current user's own notifications; there's no
    way to pass whose you want to see."""
    user = _require_signed_in_user(request, db)
    rows = (
        db.query(WorkspaceShare, User)
        .join(User, User.id == WorkspaceShare.owner_user_id)
        .filter(WorkspaceShare.user_id == user.id)
        .order_by(WorkspaceShare.updated_at.desc())
        .all()
    )
    items = [
        ShareNotificationOut(
            share_id=share.id,
            owner_user_id=owner.id,
            owner_name=owner.name,
            owner_email=owner.email,
            owner_avatar_url=owner.avatar_url,
            role=share.role,
            last_change=share.last_change,
            is_new=share.seen_at is None,
        )
        for share, owner in rows
    ]
    return NotificationsOut(new_count=sum(1 for i in items if i.is_new), items=items)


@router.post("/notifications/seen")
def mark_notifications_seen(body: MarkNotificationsSeenIn, request: Request, db: Session = Depends(get_db)):
    """share_id=None marks every unseen share of the caller's own seen (the
    avatar dropdown closing); a specific share_id marks just that one
    (switch_workspace calls this path itself when switching INTO a shared
    workspace, so opening it from the toast's "Open" action -- which
    switches straight there without ever opening the dropdown -- still
    clears that one notification)."""
    user = _require_signed_in_user(request, db)
    now = datetime.now(timezone.utc).isoformat()
    q = db.query(WorkspaceShare).filter(WorkspaceShare.user_id == user.id, WorkspaceShare.seen_at.is_(None))
    if body.share_id is not None:
        q = q.filter(WorkspaceShare.id == body.share_id)
    marked = q.update({"seen_at": now}, synchronize_session=False)
    db.commit()
    return {"marked": marked}


@router.post("/switch")
def switch_workspace(body: WorkspaceSwitchIn, request: Request, response: Response, db: Session = Depends(get_db)):
    """Sets (or clears) the active_workspace cookie that get_scope reads on
    every later request. Validates the grant exists NOW, at switch time --
    but that's a courtesy 403 for the switcher UI, not the real enforcement:
    get_scope re-checks the same grant on every subsequent request too, so
    access removed after switching still takes effect immediately, not just
    on the next explicit switch.

    Also marks that one share seen (Part 5, "opens that workspace") -- the
    only other seen-marking path is the dropdown closing, which this
    doesn't depend on, so switching straight in from the notification
    toast's "Open" action clears it too."""
    user = _require_signed_in_user(request, db)
    if body.owner_user_id is None or body.owner_user_id == user.id:
        set_active_workspace_cookie(request, response, None)
        return {"ok": True}

    share = (
        db.query(WorkspaceShare)
        .filter(WorkspaceShare.owner_user_id == body.owner_user_id, WorkspaceShare.user_id == user.id)
        .first()
    )
    if share is None:
        raise HTTPException(status_code=403, detail="You don't have access to that workspace")
    if share.seen_at is None:
        share.seen_at = datetime.now(timezone.utc).isoformat()
        db.commit()
    set_active_workspace_cookie(request, response, body.owner_user_id)
    return {"ok": True}


@router.get("/shares", response_model=SharesListOut)
def list_shares(db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Who has access to the ACTIVE workspace -- available to owner, editor,
    and viewer alike (same as Google Sheets showing every collaborator the
    full list of who else is on the doc), not just the owner."""
    owner_user_id = scope.workspace_owner_user_id if scope.workspace_owner_user_id is not None else scope.user_id
    if owner_user_id is None:
        raise HTTPException(status_code=401, detail="Sign in required")
    owner_user = db.query(User).filter(User.id == owner_user_id).first()
    if owner_user is None:
        raise HTTPException(status_code=404, detail="Workspace not found")

    rows = (
        db.query(WorkspaceShare)
        .filter(WorkspaceShare.owner_user_id == owner_user_id)
        .order_by(WorkspaceShare.created_at)
        .all()
    )
    people = []
    for row in rows:
        person = db.query(User).filter(User.id == row.user_id).first() if row.user_id else None
        people.append(_share_out(row, person))

    return SharesListOut(
        owner=ShareOwnerOut(
            user_id=owner_user.id, name=owner_user.name, email=owner_user.email, avatar_url=owner_user.avatar_url
        ),
        people=people,
    )


@router.post("/shares", response_model=ShareOut)
def create_or_update_share(body: ShareIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Shares the CALLER's own workspace (never the active one -- only
    reachable with scope.role=='owner' to begin with, so scope.user_id IS
    the workspace being shared) with an email as Viewer or Editor. Sharing
    again with an email that already has access updates its role in place
    rather than creating a second grant (owner_user_id, invited_email) is
    unique. If that email already belongs to a signed-in account, access is
    immediate; otherwise it's a pending invite, activated automatically the
    first time that email signs in (app/routers/auth.py)."""
    require_owner(scope)
    email = normalize_email(body.email)
    if scope.user_email and email == normalize_email(scope.user_email):
        raise HTTPException(status_code=400, detail="You already own this workspace")

    now = datetime.now(timezone.utc).isoformat()
    matched_user = db.query(User).filter(func.lower(User.email) == email).first()

    existing = (
        db.query(WorkspaceShare)
        .filter(WorkspaceShare.owner_user_id == scope.user_id, WorkspaceShare.invited_email == email)
        .first()
    )
    role_changed = existing is not None and existing.role != body.role

    if existing is not None:
        existing.role = body.role
        if matched_user is not None:
            existing.user_id = matched_user.id
        existing.updated_at = now
        if role_changed:
            _mark_new(existing, "role_changed")
        row = existing
    else:
        row = WorkspaceShare(
            owner_user_id=scope.user_id,
            invited_email=email,
            user_id=matched_user.id if matched_user else None,
            role=body.role,
            invited_by_user_id=scope.user_id,
            created_at=now,
            updated_at=now,
            seen_at=None,
            last_change="shared",
        )
        db.add(row)
    db.flush()

    target_label = matched_user.name if matched_user else email
    verb = "Changed" if role_changed else "Shared"
    sentence = (
        f"{verb} {target_label}'s role to {_role_label(body.role)}"
        if role_changed
        else f"Shared with {target_label} as {_role_label(body.role)}"
    )
    _log_share_action(db, scope, sentence)

    db.commit()
    db.refresh(row)
    return _share_out(row, matched_user)


@router.patch("/shares/{share_id}", response_model=ShareOut)
def change_share_role(share_id: int, body: ShareRoleIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    require_owner(scope)
    row = (
        db.query(WorkspaceShare)
        .filter(WorkspaceShare.id == share_id, WorkspaceShare.owner_user_id == scope.user_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Share not found")

    person = db.query(User).filter(User.id == row.user_id).first() if row.user_id else None
    target_label = person.name if person else row.invited_email
    role_changed = row.role != body.role
    row.role = body.role
    row.updated_at = datetime.now(timezone.utc).isoformat()
    if role_changed:
        _mark_new(row, "role_changed")
    _log_share_action(db, scope, f"Changed {target_label}'s role to {_role_label(body.role)}")

    db.commit()
    db.refresh(row)
    return _share_out(row, person)


@router.delete("/shares/{share_id}")
def remove_share(share_id: int, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Deletes the grant outright. The person who lost access never gets a
    fresh 403 "mid-session" surprise beyond what get_scope already does on
    their very next request -- it re-checks this same table every time, so
    there's no cache to invalidate and no delay. GET /workspace/context is
    what notices and reports it to them (see that endpoint's docstring)."""
    require_owner(scope)
    row = (
        db.query(WorkspaceShare)
        .filter(WorkspaceShare.id == share_id, WorkspaceShare.owner_user_id == scope.user_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Share not found")

    person = db.query(User).filter(User.id == row.user_id).first() if row.user_id else None
    target_label = person.name if person else row.invited_email
    db.delete(row)
    _log_share_action(db, scope, f"Removed {target_label}'s access")

    db.commit()
    return {"ok": True}
