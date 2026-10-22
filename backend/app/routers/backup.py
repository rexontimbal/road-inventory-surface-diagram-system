import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Road, RoadSegment, UploadLogEntry
from app.schemas import (
    APP_NAME,
    BACKUP_VERSION,
    BackupCounts,
    BackupDistrict,
    BackupExport,
    BackupRoad,
    BackupSegment,
    RestoreCommitIn,
    RestorePreview,
    RestorePreviewIn,
    RestoreResult,
    RoadPreviewDuplicate,
    RoadPreviewNew,
)
from app.scope import Scope, apply_scope, get_scope, owner_kwargs, require_editor, user_kwargs
from app.upload_log import entry_to_out, write_log_entry

router = APIRouter(prefix="/api/backup", tags=["backup"])

# Same in-process, single-use-token pattern as the upload preview/commit
# flow in routers/roads.py: the parsed backup (which can be large) is kept
# server-side between preview and commit so the client only exchanges small
# summaries, not the full payload twice.
_PENDING_RESTORES: dict[str, tuple[BackupExport, float]] = {}
_PENDING_TTL_SECONDS = 15 * 60


def _prune_pending_restores():
    now = time.time()
    expired = [token for token, (_, expires_at) in _PENDING_RESTORES.items() if expires_at < now]
    for token in expired:
        _PENDING_RESTORES.pop(token, None)


@router.get("/export", response_model=BackupExport)
def export_backup(district: str | None = None, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Exports the active workspace -- or, with ?district=<DEO>, just that
    one District's sections/segments. Upload History is only ever included
    for a whole-workspace export: log entries aren't attributable to a
    single District, so a District backup carries none (counts.logs=0)
    rather than either the whole log or a misleadingly filtered slice."""
    query = apply_scope(db.query(Road), Road, scope)
    if district:
        query = query.filter(Road.deo == district)
    roads = query.order_by(Road.section_id).all()
    if not roads:
        detail = f"There's no data in {district} yet." if district else "There's no data to back up yet."
        raise HTTPException(status_code=400, detail=detail)
    backup_roads: list[BackupRoad] = []
    total_segments = 0
    for road in roads:
        segments = [
            BackupSegment(
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
            )
            for seg in road.segments
        ]
        total_segments += len(segments)
        backup_roads.append(
            BackupRoad(
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
                segments=segments,
            )
        )

    if district:
        log_out = []
    else:
        log_entries = (
            apply_scope(db.query(UploadLogEntry), UploadLogEntry, scope)
            .order_by(UploadLogEntry.timestamp.desc())
            .all()
        )
        log_out = [entry_to_out(e) for e in log_entries]

    return BackupExport(
        app_name=APP_NAME,
        backup_version=BACKUP_VERSION,
        exported_at=datetime.now(timezone.utc).isoformat(),
        scope="district" if district else "all",
        district=BackupDistrict(deo=district, ld=roads[0].ld) if district else None,
        counts=BackupCounts(roads=len(backup_roads), segments=total_segments, logs=len(log_out)),
        roads=backup_roads,
        upload_log=log_out,
    )


@router.post("/restore/preview", response_model=RestorePreview)
def restore_preview(body: RestorePreviewIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    require_editor(scope)
    backup = body.backup
    if backup.app_name != APP_NAME:
        raise HTTPException(status_code=400, detail="This file is not a Road Inventory & Surface Diagram backup.")
    if backup.backup_version != BACKUP_VERSION:
        raise HTTPException(status_code=400, detail=f"Unsupported backup version: {backup.backup_version}")

    _prune_pending_restores()
    token = str(uuid4())
    _PENDING_RESTORES[token] = (backup, time.time() + _PENDING_TTL_SECONDS)

    existing_by_key = {
        road.section_id.strip().lower(): road for road in apply_scope(db.query(Road), Road, scope).all()
    }

    new_roads: list[RoadPreviewNew] = []
    duplicates: list[RoadPreviewDuplicate] = []
    for br in backup.roads:
        existing = existing_by_key.get(br.section_id.strip().lower())
        if existing is None:
            new_roads.append(
                RoadPreviewNew(
                    section_id=br.section_id,
                    road_name=br.road_name,
                    segment_count=br.segment_count,
                    total_length_m=br.total_length_m,
                )
            )
        else:
            duplicates.append(
                RoadPreviewDuplicate(
                    section_id=br.section_id,
                    existing_road_name=existing.road_name,
                    new_road_name=br.road_name,
                    name_changed=existing.road_name.strip().lower() != br.road_name.strip().lower(),
                    existing_segment_count=existing.segment_count,
                    existing_total_length_m=existing.total_length_m,
                    existing_updated_at=existing.updated_at,
                    existing_source_file=existing.source_file,
                    new_segment_count=br.segment_count,
                    new_total_length_m=br.total_length_m,
                )
            )

    current_segments_count = apply_scope(db.query(RoadSegment), RoadSegment, scope).count()
    current_logs_count = apply_scope(db.query(UploadLogEntry), UploadLogEntry, scope).count()

    return RestorePreview(
        token=token,
        backup_exported_at=backup.exported_at,
        backup_counts=backup.counts,
        current_counts=BackupCounts(
            roads=len(existing_by_key), segments=current_segments_count, logs=current_logs_count
        ),
        new_roads=new_roads,
        duplicates=duplicates,
    )


@router.post("/restore/commit", response_model=RestoreResult)
def restore_commit(body: RestoreCommitIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    require_editor(scope)
    _prune_pending_restores()
    entry = _PENDING_RESTORES.pop(body.token, None)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail="This restore session has expired. Please re-select the backup file.",
        )
    backup, _ = entry

    now = datetime.now(timezone.utc).isoformat()

    # Captured before any delete -- scalar columns are already loaded into
    # memory from this query, so reading them later is safe even after a
    # bulk delete below (we never touch the .segments relationship on them).
    existing_roads = {
        road.section_id.strip().lower(): road for road in apply_scope(db.query(Road), Road, scope).all()
    }
    pre_existing_keys = set(existing_roads.keys())

    if body.mode == "replace_all":
        if backup.scope == "district" and backup.district:
            # A District backup's "Replace this District" must only ever wipe
            # that one District's sections -- never the rest of the active
            # workspace. RoadSegment has no deo column of its own, so its
            # rows are targeted by section_id (collected from the matching
            # Road rows) rather than filtered directly.
            district_query = apply_scope(db.query(Road), Road, scope).filter(Road.deo == backup.district.deo)
            district_section_ids = [r.section_id for r in district_query.all()]
            if district_section_ids:
                apply_scope(db.query(RoadSegment), RoadSegment, scope).filter(
                    RoadSegment.section_id.in_(district_section_ids)
                ).delete(synchronize_session=False)
                district_query.delete(synchronize_session=False)
        else:
            # Scoped deletes -- a guest's "Replace all data" must only ever wipe
            # their own sandbox, and a signed-in user's must only wipe the
            # shared workspace. An unscoped .delete() here would nuke every
            # scope's data at once.
            apply_scope(db.query(RoadSegment), RoadSegment, scope).delete()
            apply_scope(db.query(Road), Road, scope).delete()

    added = replaced = kept = 0
    log_details: list[dict] = []

    for br in backup.roads:
        key = br.section_id.strip().lower()
        existed_before = key in pre_existing_keys
        action = body.decisions.get(br.section_id, "replace") if body.mode == "merge" else "replace"

        if body.mode == "merge" and existed_before and action == "keep":
            kept += 1
            log_details.append(
                {
                    "section_id": br.section_id,
                    "road_name": br.road_name,
                    "action": "kept_existing",
                    "segment_count": existing_roads[key].segment_count,
                }
            )
            continue

        uploaded_at = br.uploaded_at or now
        if body.mode == "merge" and existed_before and existing_roads[key].uploaded_at:
            uploaded_at = existing_roads[key].uploaded_at

        apply_scope(db.query(RoadSegment), RoadSegment, scope).filter(RoadSegment.section_id == br.section_id).delete()
        apply_scope(db.query(Road), Road, scope).filter(Road.section_id == br.section_id).delete()

        road = Road(
            section_id=br.section_id,
            road_name=br.road_name,
            classification=br.classification,
            deo=br.deo,
            ld=br.ld,
            updated_at=now,
            uploaded_at=uploaded_at,
            source_file=br.source_file,
            segment_count=br.segment_count,
            total_length_m=br.total_length_m,
            **owner_kwargs(scope),
        )
        db.add(road)
        for seg in br.segments:
            db.add(
                RoadSegment(
                    section_id=br.section_id,
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
                    source_row_number=seg.seq_no + 1,
                    **owner_kwargs(scope),
                )
            )

        if existed_before:
            replaced += 1
            row_action = "replaced"
        else:
            added += 1
            row_action = "added"
        log_details.append(
            {
                "section_id": br.section_id,
                "road_name": br.road_name,
                "action": row_action,
                "segment_count": br.segment_count,
            }
        )

    write_log_entry(
        db,
        kind="restore",
        status="completed",
        file_name=f"Backup from {backup.exported_at}",
        total_rows=sum(len(r.segments) for r in backup.roads),
        details=log_details,
        **owner_kwargs(scope),
        **user_kwargs(scope),
    )
    db.commit()

    total_roads = apply_scope(db.query(Road), Road, scope).count()
    return RestoreResult(added=added, replaced=replaced, kept=kept, total_roads=total_roads)
