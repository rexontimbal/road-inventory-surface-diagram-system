from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import GuestSession, Road, UploadLogEntry
from app.schemas import GuestStatusOut
from app.scope import GUEST_COOKIE_NAME, GUEST_DATA_TTL_MINUTES

router = APIRouter(prefix="/api/guest", tags=["guest"])


def _guest_id(request: Request) -> str | None:
    return request.cookies.get(GUEST_COOKIE_NAME)


def _guest_roads(db: Session, guest_id: str):
    return db.query(Road).filter(Road.owner_type == "guest", Road.owner_id == guest_id).all()


@router.get("/status", response_model=GuestStatusOut)
def guest_status(request: Request, db: Session = Depends(get_db)):
    """Whether THIS browser's guest cookie has any data and when it expires
    -- drives the "guest mode, clears in N min" banner, and (right after
    signing in) the one-time "your guest data wasn't moved" toast. Guest
    data is never merged into an account -- it just stays in the guest
    sandbox and expires on its own TTL, same as any other guest session.
    is_guest reflects current auth state; has_data/expires_at describe the
    guest cookie's own data regardless of it."""
    guest_id = _guest_id(request)
    session_row = db.query(GuestSession).filter(GuestSession.guest_id == guest_id).first() if guest_id else None
    if session_row is None:
        return GuestStatusOut(is_guest=get_current_user(request, db) is None, has_data=False, expires_at=None)

    has_data = len(_guest_roads(db, guest_id)) > 0
    expires_at = (
        datetime.fromisoformat(session_row.last_activity_at) + timedelta(minutes=GUEST_DATA_TTL_MINUTES)
    ).isoformat()
    return GuestStatusOut(
        is_guest=get_current_user(request, db) is None,
        has_data=has_data,
        expires_at=expires_at,
    )


@router.post("/discard")
def guest_discard(request: Request, db: Session = Depends(get_db)):
    """Deletes the caller's guest-sandbox data outright -- any guest who
    wants to clear their own sandbox before its TTL, independent of sign-in."""
    guest_id = _guest_id(request)
    if guest_id:
        _teardown_guest(db, guest_id)
        db.commit()
    return {"ok": True}


def _teardown_guest(db: Session, guest_id: str):
    """Deletes every remaining road (segments cascade) and log entry still
    owned by this guest, and the GuestSession row itself -- called once the
    guest's sandbox is no longer needed (discarded or expired)."""
    db.query(Road).filter(Road.owner_type == "guest", Road.owner_id == guest_id).delete()
    db.query(UploadLogEntry).filter(UploadLogEntry.owner_type == "guest", UploadLogEntry.owner_id == guest_id).delete()
    db.query(GuestSession).filter(GuestSession.guest_id == guest_id).delete()
