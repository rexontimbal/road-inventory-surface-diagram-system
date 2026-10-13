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
def export_backup(db: Session = Depends(get_db)):
    roads = db.query(Road).order_by(Road.road_id).all()
    backup_roads: list[BackupRoad] = []
    total_segments = 0
    for road in roads:
        segments = [
            BackupSegment(
                seq_no=seg.seq_no,
                start_station_raw=seg.start_station_raw,
                end_station_raw=seg.end_station_raw,
                start_m=seg.start_m,
                end_m=seg.end_m,
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
                road_id=road.road_id,
                road_name=road.road_name,
                updated_at=road.updated_at,
                uploaded_at=road.uploaded_at,
                source_file=road.source_file,
                segment_count=road.segment_count,
                total_length_m=road.total_length_m,
                segments=segments,
            )
        )

    log_entries = db.query(UploadLogEntry).order_by(UploadLogEntry.timestamp.desc()).all()
    log_out = [entry_to_out(e) for e in log_entries]

    return BackupExport(
        app_name=APP_NAME,
        backup_version=BACKUP_VERSION,
        exported_at=datetime.now(timezone.utc).isoformat(),
        counts=BackupCounts(roads=len(backup_roads), segments=total_segments, logs=len(log_out)),
        roads=backup_roads,
        upload_log=log_out,
    )


@router.post("/restore/preview", response_model=RestorePreview)
def restore_preview(body: RestorePreviewIn, db: Session = Depends(get_db)):
    backup = body.backup
    if backup.app_name != APP_NAME:
        raise HTTPException(status_code=400, detail="This file is not a Road Inventory & Surface Diagram backup.")
    if backup.backup_version != BACKUP_VERSION:
        raise HTTPException(status_code=400, detail=f"Unsupported backup version: {backup.backup_version}")

    _prune_pending_restores()
    token = str(uuid4())
    _PENDING_RESTORES[token] = (backup, time.time() + _PENDING_TTL_SECONDS)

    existing_by_key = {road.road_id.strip().lower(): road for road in db.query(Road).all()}

    new_roads: list[RoadPreviewNew] = []
    duplicates: list[RoadPreviewDuplicate] = []
    for br in backup.roads:
        existing = existing_by_key.get(br.road_id.strip().lower())
        if existing is None:
            new_roads.append(
                RoadPreviewNew(
                    road_id=br.road_id,
                    road_name=br.road_name,
                    segment_count=br.segment_count,
                    total_length_m=br.total_length_m,
                )
            )
        else:
            duplicates.append(
                RoadPreviewDuplicate(
                    road_id=br.road_id,
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

    current_segments_count = db.query(RoadSegment).count()
    current_logs_count = db.query(UploadLogEntry).count()

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
def restore_commit(body: RestoreCommitIn, db: Session = Depends(get_db)):
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
    existing_roads = {road.road_id.strip().lower(): road for road in db.query(Road).all()}
    pre_existing_keys = set(existing_roads.keys())

    if body.mode == "replace_all":
        db.query(RoadSegment).delete()
        db.query(Road).delete()

    added = replaced = kept = 0
    log_details: list[dict] = []

    for br in backup.roads:
        key = br.road_id.strip().lower()
        existed_before = key in pre_existing_keys
        action = body.decisions.get(br.road_id, "replace") if body.mode == "merge" else "replace"

        if body.mode == "merge" and existed_before and action == "keep":
            kept += 1
            log_details.append(
                {
                    "road_id": br.road_id,
                    "road_name": br.road_name,
                    "action": "kept_existing",
                    "segment_count": existing_roads[key].segment_count,
                }
            )
            continue

        uploaded_at = br.uploaded_at or now
        if body.mode == "merge" and existed_before and existing_roads[key].uploaded_at:
            uploaded_at = existing_roads[key].uploaded_at

        db.query(RoadSegment).filter(RoadSegment.road_id == br.road_id).delete()
        db.query(Road).filter(Road.road_id == br.road_id).delete()

        road = Road(
            road_id=br.road_id,
            road_name=br.road_name,
            updated_at=now,
            uploaded_at=uploaded_at,
            source_file=br.source_file,
            segment_count=br.segment_count,
            total_length_m=br.total_length_m,
        )
        db.add(road)
        for seg in br.segments:
            db.add(
                RoadSegment(
                    road_id=br.road_id,
                    seq_no=seg.seq_no,
                    start_station_raw=seg.start_station_raw,
                    end_station_raw=seg.end_station_raw,
                    start_m=seg.start_m,
                    end_m=seg.end_m,
                    num_lanes=seg.num_lanes,
                    surface_type=seg.surface_type,
                    shoulder_left=seg.shoulder_left,
                    shoulder_right=seg.shoulder_right,
                    source_row_number=seg.seq_no + 1,
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
                "road_id": br.road_id,
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
    )
    db.commit()

    total_roads = db.query(Road).count()
    return RestoreResult(added=added, replaced=replaced, kept=kept, total_roads=total_roads)
