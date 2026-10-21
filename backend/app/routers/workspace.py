from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import User, WorkspaceShare
from app.schemas import (
    ShareIn,
    ShareOut,
    ShareOwnerOut,
    ShareRoleIn,
    SharedWorkspaceOut,
    SharesListOut,
    WorkspaceContextOut,
    WorkspaceSwitchIn,
)
from app.scope import Scope, get_scope, normalize_email, owner_kwargs, require_owner, set_active_workspace_cookie, user_kwargs
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


@router.get("/context", response_model=WorkspaceContextOut)
def get_context(request: Request, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Drives the workspace switcher and the "Viewing X's data" banner: the
    ACTIVE workspace (own, or someone else's via the active_workspace
    cookie -- see get_scope) plus the full list of workspaces shared with
    this account, so the switcher can list all of them regardless of which
    one happens to be active right now."""
    user = _require_signed_in_user(request, db)

    shared_rows = (
        db.query(WorkspaceShare, User)
        .join(User, User.id == WorkspaceShare.owner_user_id)
        .filter(WorkspaceShare.user_id == user.id)
        .order_by(User.name)
        .all()
    )
    shared_with_me = [
        SharedWorkspaceOut(
            owner_user_id=owner.id,
            owner_name=owner.name,
            owner_email=owner.email,
            owner_avatar_url=owner.avatar_url,
            role=share.role,
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
        )
    return WorkspaceContextOut(mode="own", role="owner", shared_with_me=shared_with_me)


@router.post("/switch")
def switch_workspace(body: WorkspaceSwitchIn, request: Request, response: Response, db: Session = Depends(get_db)):
    """Sets (or clears) the active_workspace cookie that get_scope reads on
    every later request. Validates the grant exists NOW, at switch time --
    but that's a courtesy 403 for the switcher UI, not the real enforcement:
    get_scope re-checks the same grant on every subsequent request too, so
    access removed after switching still takes effect immediately, not just
    on the next explicit switch."""
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
    row.role = body.role
    row.updated_at = datetime.now(timezone.utc).isoformat()
    _log_share_action(db, scope, f"Changed {target_label}'s role to {_role_label(body.role)}")

    db.commit()
    db.refresh(row)
    return _share_out(row, person)


@router.delete("/shares/{share_id}")
def remove_share(share_id: int, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Deletes the grant outright. The person who lost access never gets a
    fresh 403 "mid-session" surprise beyond what get_scope already does on
    their very next request -- it re-checks this same table every time, so
    there's no cache to invalidate and no delay."""
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
