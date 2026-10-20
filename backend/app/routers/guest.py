from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import GuestSession, Road, RoadSegment, UploadLogEntry, User
from app.schemas import (
    GuestMergeCommitIn,
    GuestMergePreview,
    GuestMergeResult,
    GuestStatusOut,
    RoadPreviewDuplicate,
    RoadPreviewNew,
)
from app.scope import GUEST_COOKIE_NAME, GUEST_DATA_TTL_MINUTES, WORKSPACE_OWNER_ID
from app.upload_log import write_log_entry

router = APIRouter(prefix="/api/guest", tags=["guest"])


def _guest_id(request: Request) -> str | None:
    return request.cookies.get(GUEST_COOKIE_NAME)


def _guest_roads(db: Session, guest_id: str):
    return db.query(Road).filter(Road.owner_type == "guest", Road.owner_id == guest_id).all()


@router.get("/status", response_model=GuestStatusOut)
def guest_status(request: Request, db: Session = Depends(get_db)):
    """Whether THIS browser's guest cookie has any data and when it expires
    -- used for the guest notice banner (while not signed in) AND, right
    after signing in, to decide whether to offer the "keep your guest
    data?" prompt. is_guest reflects current auth state; has_data/
    expires_at describe the guest cookie's own data regardless of it."""
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


def _require_signed_in(request: Request, db: Session) -> User:
    user = get_current_user(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to move guest data into your account")
    return user


@router.post("/merge/preview", response_model=GuestMergePreview)
def guest_merge_preview(request: Request, db: Session = Depends(get_db)):
    _require_signed_in(request, db)
    guest_id = _guest_id(request)
    if not guest_id:
        return GuestMergePreview(new_roads=[], duplicates=[])

    workspace_by_key = {
        road.section_id.strip().lower(): road
        for road in db.query(Road).filter(Road.owner_type == "workspace", Road.owner_id == WORKSPACE_OWNER_ID).all()
    }

    new_roads: list[RoadPreviewNew] = []
    duplicates: list[RoadPreviewDuplicate] = []
    for road in _guest_roads(db, guest_id):
        existing = workspace_by_key.get(road.section_id.strip().lower())
        if existing is None:
            new_roads.append(
                RoadPreviewNew(
                    section_id=road.section_id,
                    road_name=road.road_name,
                    segment_count=road.segment_count,
                    total_length_m=road.total_length_m,
                )
            )
        else:
            duplicates.append(
                RoadPreviewDuplicate(
                    section_id=road.section_id,
                    existing_road_name=existing.road_name,
                    new_road_name=road.road_name,
                    name_changed=existing.road_name.strip().lower() != road.road_name.strip().lower(),
                    existing_segment_count=existing.segment_count,
                    existing_total_length_m=existing.total_length_m,
                    existing_updated_at=existing.updated_at,
                    existing_source_file=existing.source_file,
                    new_segment_count=road.segment_count,
                    new_total_length_m=road.total_length_m,
                )
            )

    return GuestMergePreview(new_roads=new_roads, duplicates=duplicates)


@router.post("/merge/commit", response_model=GuestMergeResult)
def guest_merge_commit(body: GuestMergeCommitIn, request: Request, db: Session = Depends(get_db)):
    """Moves the caller's guest-sandbox roads into the shared workspace.
    'Keep' (the existing workspace road wins) just means that one guest road
    is NOT moved -- it, and everything else left in the guest sandbox, is
    torn down at the end regardless of outcome, same as a plain discard."""
    user = _require_signed_in(request, db)
    guest_id = _guest_id(request)
    moved = replaced = kept = 0

    if guest_id:
        workspace_by_key = {
            road.section_id.strip().lower(): road
            for road in db.query(Road)
            .filter(Road.owner_type == "workspace", Road.owner_id == WORKSPACE_OWNER_ID)
            .all()
        }
        log_details: list[dict] = []

        for road in _guest_roads(db, guest_id):
            key = road.section_id.strip().lower()
            existing = workspace_by_key.get(key)
            decision = body.decisions.get(road.section_id, "replace")

            if existing is not None and decision == "keep":
                kept += 1
                log_details.append(
                    {"section_id": road.section_id, "road_name": road.road_name, "action": "kept_existing"}
                )
                continue

            segments = list(road.segments)
            if existing is not None:
                db.query(RoadSegment).filter(
                    RoadSegment.section_id == existing.section_id,
                    RoadSegment.owner_type == "workspace",
                    RoadSegment.owner_id == WORKSPACE_OWNER_ID,
                ).delete()
                db.delete(existing)
                replaced += 1
                row_action = "replaced"
            else:
                moved += 1
                row_action = "added"

            new_road = Road(
                section_id=road.section_id,
                road_name=road.road_name,
                classification=road.classification,
                deo=road.deo,
                ld=road.ld,
                updated_at=road.updated_at,
                uploaded_at=road.uploaded_at,
                source_file=road.source_file,
                segment_count=road.segment_count,
                total_length_m=road.total_length_m,
                owner_type="workspace",
                owner_id=WORKSPACE_OWNER_ID,
            )
            db.add(new_road)
            for seg in segments:
                db.add(
                    RoadSegment(
                        section_id=seg.section_id,
                        seq_no=seg.seq_no,
                        start_text=seg.start_text,
                        end_text=seg.end_text,
                        start_m=seg.start_m,
                        end_m=seg.end_m,
                        length_m=seg.length_m,
                        irregular_km_post=seg.irregular_km_post,
                        num_lanes=seg.num_lanes,
                        surface_type=seg.surface_type,
                        shoulder_left=seg.shoulder_left,
                        shoulder_right=seg.shoulder_right,
                        source_row_number=seg.source_row_number,
                        owner_type="workspace",
                        owner_id=WORKSPACE_OWNER_ID,
                    )
                )
            log_details.append(
                {
                    "section_id": road.section_id,
                    "road_name": road.road_name,
                    "action": row_action,
                    "segment_count": road.segment_count,
                }
            )

        if log_details:
            write_log_entry(
                db,
                kind="restore",
                status="completed",
                file_name="Guest data moved into account",
                total_rows=sum(d.get("segment_count") or 0 for d in log_details),
                details=log_details,
                owner_type="workspace",
                owner_id=WORKSPACE_OWNER_ID,
                user_id=user.id,
                actor_name=user.name,
                actor_email=user.email,
                actor_avatar_url=user.avatar_url,
            )

        _teardown_guest(db, guest_id)

    db.commit()
    return GuestMergeResult(moved=moved, replaced=replaced, kept=kept)


@router.post("/discard")
def guest_discard(request: Request, db: Session = Depends(get_db)):
    """Deletes the caller's guest-sandbox data outright -- used both for the
    post-sign-in "Discard" choice and (harmlessly) by any guest who just
    wants to clear their own sandbox."""
    guest_id = _guest_id(request)
    if guest_id:
        _teardown_guest(db, guest_id)
        db.commit()
    return {"ok": True}


def _teardown_guest(db: Session, guest_id: str):
    """Deletes every remaining road (segments cascade) and log entry still
    owned by this guest, and the GuestSession row itself -- called once the
    guest's sandbox is no longer needed (merged, discarded, or expired)."""
    db.query(Road).filter(Road.owner_type == "guest", Road.owner_id == guest_id).delete()
    db.query(UploadLogEntry).filter(UploadLogEntry.owner_type == "guest", UploadLogEntry.owner_id == guest_id).delete()
    db.query(GuestSession).filter(GuestSession.guest_id == guest_id).delete()
