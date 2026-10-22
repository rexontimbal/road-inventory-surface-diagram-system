import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import pending_ops
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

_logger = logging.getLogger("app")

PENDING_KIND = "restore"


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

    pending_ops.prune_expired(db)
    # Stored in the DB (not an in-process dict) so this token survives a
    # Render free-tier sleep/restart between this preview and the user
    # clicking Confirm a few seconds (or minutes) later -- see
    # app/pending_ops.py's module docstring for the full reasoning.
    token = pending_ops.create_pending(db, PENDING_KIND, scope, backup.model_dump())

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


def _run_restore(backup: BackupExport, mode: str, decisions: dict, db: Session, scope: Scope) -> RestoreResult:
    """The actual write side of a restore commit -- pulled out of the route
    function so `restore_commit` can wrap exactly this (and only this) in
    the claim/timing/error-marking machinery below. Batches every Road and
    RoadSegment insert into one bulk statement each (plus up to one bulk
    delete pass) instead of the previous one-db.add()-per-row loop, which is
    what made an 11k-segment restore slow enough over Neon's network
    latency to expose the double-submit race in the first place -- see
    app/routers/roads.py's upload_commit, which already used this same
    bulk_insert_mappings pattern for segments."""
    now = datetime.now(timezone.utc).isoformat()

    existing_roads = {
        road.section_id.strip().lower(): road for road in apply_scope(db.query(Road), Road, scope).all()
    }
    pre_existing_keys = set(existing_roads.keys())

    if mode == "replace_all":
        if backup.scope == "district" and backup.district:
            # A District backup's "Replace this District" must only ever wipe
            # that one District's sections -- never the rest of the active
            # workspace. RoadSegment has no deo column of its own, so its
            # rows are targeted by section_id (collected from the matching
            # Road rows) rather than filtered directly.
            # No explicit synchronize_session=False here -- the default
            # ("evaluate") strategy keeps the Session's identity map (which
            # already holds every Road this scope has loaded, via
            # existing_roads above) in sync with what was actually deleted.
            # Skipping that left stale identity-mapped Road instances behind
            # with the SAME primary key as the fresh Road objects added
            # below, which SQLAlchemy then reported as a conflicting
            # instance at flush time.
            district_query = apply_scope(db.query(Road), Road, scope).filter(Road.deo == backup.district.deo)
            district_section_ids = [r.section_id for r in district_query.all()]
            if district_section_ids:
                apply_scope(db.query(RoadSegment), RoadSegment, scope).filter(
                    RoadSegment.section_id.in_(district_section_ids)
                ).delete()
                district_query.delete()
        else:
            # Scoped deletes -- a guest's "Replace all data" must only ever wipe
            # their own sandbox, and a signed-in user's must only wipe the
            # shared workspace. An unscoped .delete() here would nuke every
            # scope's data at once.
            apply_scope(db.query(RoadSegment), RoadSegment, scope).delete()
            apply_scope(db.query(Road), Road, scope).delete()

    added = replaced = kept = 0
    log_details: list[dict] = []
    roads_to_insert: list[Road] = []
    segment_rows: list[dict] = []
    # Only merge-mode "replace" of an ALREADY-EXISTING road needs its old row
    # cleared first (replace_all already wiped everything relevant above;
    # a brand-new road has nothing to conflict with) -- collected and
    # deleted in one batch rather than per-row, same reasoning as the bulk
    # inserts below.
    ids_needing_predelete: list[str] = []

    for br in backup.roads:
        key = br.section_id.strip().lower()
        existed_before = key in pre_existing_keys
        action = decisions.get(br.section_id, "replace") if mode == "merge" else "replace"

        if mode == "merge" and existed_before and action == "keep":
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
        if mode == "merge" and existed_before and existing_roads[key].uploaded_at:
            uploaded_at = existing_roads[key].uploaded_at

        if mode == "merge" and existed_before:
            ids_needing_predelete.append(br.section_id)

        roads_to_insert.append(
            Road(
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
        )
        for seg in br.segments:
            segment_rows.append(
                {
                    "section_id": br.section_id,
                    "seq_no": seg.seq_no,
                    "start_text": seg.start_text,
                    "end_text": seg.end_text,
                    "start_m": seg.start_m,
                    "end_m": seg.end_m,
                    "length_m": seg.length_m,
                    "irregular_km_post": seg.irregular_km_post,
                    "num_lanes": seg.num_lanes,
                    "surface_type": seg.surface_type,
                    "shoulder_left": seg.shoulder_left,
                    "shoulder_right": seg.shoulder_right,
                    "source_row_number": seg.seq_no + 1,
                    **owner_kwargs(scope),
                }
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

    if ids_needing_predelete:
        # Same reasoning as the district predelete above -- default
        # synchronize_session so the identity map stays consistent with
        # the Road objects being added for these same section_ids below.
        apply_scope(db.query(RoadSegment), RoadSegment, scope).filter(
            RoadSegment.section_id.in_(ids_needing_predelete)
        ).delete()
        apply_scope(db.query(Road), Road, scope).filter(Road.section_id.in_(ids_needing_predelete)).delete()

    if roads_to_insert:
        db.add_all(roads_to_insert)
        # Segments reference roads via FK -- flushing sends the Road INSERTs
        # to the DB (within this same transaction) before the bulk segment
        # insert below, so the FK constraint is satisfied without needing a
        # second round trip or a commit.
        db.flush()
    if segment_rows:
        db.bulk_insert_mappings(RoadSegment, segment_rows)

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


@router.post("/restore/commit", response_model=RestoreResult)
def restore_commit(body: RestoreCommitIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    require_editor(scope)
    pending_ops.prune_expired(db)

    outcome = pending_ops.claim(db, body.token, PENDING_KIND)
    if outcome.status == "not_found":
        raise HTTPException(
            status_code=400,
            detail="This restore session has expired. Please re-select the backup file.",
        )
    if outcome.status == "done":
        return RestoreResult(**outcome.result)
    if outcome.status == "error":
        _logger.error("restore commit replay of a failed token=%s: %s", body.token, outcome.error_detail)
        raise HTTPException(status_code=400, detail="Restore failed. Please re-select the backup file and try again.")
    if outcome.status == "wait":
        # Another request (an earlier click of the same Restore button,
        # most likely) already claimed this token and is running right now
        # -- wait for IT to finish and replay its result, instead of
        # telling this caller their session "expired" while the real
        # restore is still quietly succeeding in the background.
        outcome = pending_ops.wait_for_result(body.token)
        if outcome.status == "done":
            return RestoreResult(**outcome.result)
        if outcome.status == "error":
            _logger.error("restore commit replay of a failed token=%s: %s", body.token, outcome.error_detail)
            raise HTTPException(
                status_code=400, detail="Restore failed. Please re-select the backup file and try again."
            )
        raise HTTPException(
            status_code=409,
            detail="This restore is still in progress. Please wait a moment and try again.",
        )

    # outcome.status == "claimed" -- this request now owns the token.
    backup = BackupExport.model_validate(outcome.payload)
    t0 = time.perf_counter()
    try:
        result = _run_restore(backup, body.mode, body.decisions, db, scope)
    except Exception as exc:
        db.rollback()
        pending_ops.mark_error(db, body.token, str(exc))
        raise
    duration_s = time.perf_counter() - t0
    total_segments = sum(len(r.segments) for r in backup.roads)
    _logger.info(
        "restore commit completed: token=%s mode=%s roads=%d segments=%d duration=%.2fs",
        body.token,
        body.mode,
        len(backup.roads),
        total_segments,
        duration_s,
    )
    pending_ops.mark_done(db, body.token, result.model_dump())
    return result
