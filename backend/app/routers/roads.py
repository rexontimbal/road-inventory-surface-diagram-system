import csv
import io
import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import case, func
from sqlalchemy.orm import Session
from starlette.responses import StreamingResponse

from app.db import get_db
from app.excel_import import ImportResult, TemplateError, parse_upload
from app.models import Road, RoadSegment, UploadLogEntry  # noqa: F401 -- UploadLogEntry import registers the table for create_all
from app.schemas import (
    NetworkSummary,
    RoadDetail,
    RoadImportedOut,
    RoadPreviewDuplicate,
    RoadPreviewNew,
    RoadRejectionOut,
    RoadSkippedOut,
    RoadSummary,
    RoadSummaryStat,
    RowErrorOut,
    SegmentOut,
    SegmentRecord,
    SegmentsPage,
    UploadCancelIn,
    UploadCommitIn,
    UploadLogPage,
    UploadPreview,
    UploadResult,
)
from app.upload_log import compare_segments, export_log_csv, query_log, write_log_entry

router = APIRouter(prefix="/api/roads", tags=["roads"])

# In-process cache bridging preview -> commit: the parsed plan (which can
# include thousands of segment rows) is kept server-side so the client only
# ever has to send/receive the small per-road summaries, not the full parsed
# file twice. Single-office tool, single process -- an in-memory dict is
# enough; no need for a shared cache/session store. Entries expire so an
# abandoned preview (closed tab, never confirmed) doesn't leak memory.
_PENDING_UPLOADS: dict[str, tuple[ImportResult, str, int, float]] = {}
_PENDING_TTL_SECONDS = 15 * 60


def _prune_pending_uploads():
    now = time.time()
    expired = [token for token, (_, _, _, expires_at) in _PENDING_UPLOADS.items() if expires_at < now]
    for token in expired:
        _PENDING_UPLOADS.pop(token, None)


def _derive_status(surface_type: str) -> str:
    return "Complete" if surface_type == "asphalt" else "Incomplete"


_STATUS_RANK = case((RoadSegment.surface_type == "asphalt", 1), else_=0)

_SORT_COLUMNS = {
    "road_id": RoadSegment.road_id,
    "road_name": Road.road_name,
    "start_station": RoadSegment.start_m,
    "end_station": RoadSegment.end_m,
    "num_lanes": RoadSegment.num_lanes,
    "surface_type": RoadSegment.surface_type,
    "status": _STATUS_RANK,
}


def _filtered_segments_query(db, road_id, status, surface_type):
    if status is not None and status not in ("Complete", "Incomplete"):
        raise HTTPException(status_code=400, detail="status must be 'Complete' or 'Incomplete'")

    query = db.query(RoadSegment, Road.road_name).join(Road, Road.road_id == RoadSegment.road_id)

    if road_id:
        query = query.filter(RoadSegment.road_id == road_id)
    if surface_type:
        query = query.filter(RoadSegment.surface_type == surface_type)
    if status == "Complete":
        query = query.filter(RoadSegment.surface_type == "asphalt")
    elif status == "Incomplete":
        query = query.filter(RoadSegment.surface_type != "asphalt")

    return query


def _apply_sort(query, sort_by, sort_dir):
    if sort_by is None:
        return query.order_by(RoadSegment.road_id, RoadSegment.seq_no)

    column = _SORT_COLUMNS.get(sort_by)
    if column is None:
        raise HTTPException(
            status_code=400, detail=f"sort_by must be one of {sorted(_SORT_COLUMNS)}"
        )
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sort_dir must be 'asc' or 'desc'")

    ordered = column.desc() if sort_dir == "desc" else column.asc()
    # Secondary key keeps same-value rows in a stable, predictable sequence.
    return query.order_by(ordered, RoadSegment.road_id, RoadSegment.seq_no)


def _rejected_out(result: ImportResult) -> list[RoadRejectionOut]:
    return [
        RoadRejectionOut(
            road_id=r.road_id,
            errors=[RowErrorOut(row=e.row, field=e.field, message=e.message) for e in r.errors],
        )
        for r in result.rejected
    ]


@router.post("/upload/preview", response_model=UploadPreview)
async def upload_preview(file: UploadFile, db: Session = Depends(get_db)):
    """Parses and validates the file (same rules as before) but writes
    nothing. Splits accepted roads into brand-new vs. Road-ID conflicts with
    an existing road (trimmed, case-insensitive match) so the frontend can
    ask the user how to handle each conflict before anything is saved."""
    contents = await file.read()
    try:
        result = parse_upload(contents)
    except TemplateError as exc:
        write_log_entry(
            db,
            kind="upload",
            status="failed",
            file_name=file.filename,
            file_size=len(contents),
            error_message=str(exc),
        )
        db.commit()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _prune_pending_uploads()
    token = str(uuid4())
    _PENDING_UPLOADS[token] = (result, file.filename, len(contents), time.time() + _PENDING_TTL_SECONDS)

    existing_by_key = {road.road_id.strip().lower(): road for road in db.query(Road).all()}

    new_roads: list[RoadPreviewNew] = []
    duplicates: list[RoadPreviewDuplicate] = []
    for plan in result.accepted:
        existing = existing_by_key.get(plan.road_id.strip().lower())
        if existing is None:
            new_roads.append(
                RoadPreviewNew(
                    road_id=plan.road_id,
                    road_name=plan.road_name,
                    segment_count=len(plan.segments),
                    total_length_m=plan.total_length_m,
                )
            )
        else:
            duplicates.append(
                RoadPreviewDuplicate(
                    road_id=plan.road_id,
                    existing_road_name=existing.road_name,
                    new_road_name=plan.road_name,
                    name_changed=existing.road_name.strip().lower() != plan.road_name.strip().lower(),
                    existing_segment_count=existing.segment_count,
                    existing_total_length_m=existing.total_length_m,
                    existing_updated_at=existing.updated_at,
                    existing_source_file=existing.source_file,
                    new_segment_count=len(plan.segments),
                    new_total_length_m=plan.total_length_m,
                )
            )

    return UploadPreview(
        token=token,
        source_file=file.filename,
        new_roads=new_roads,
        duplicates=duplicates,
        rejected=_rejected_out(result),
        total_rows_processed=result.total_rows_processed,
        ignored_columns=result.ignored_columns,
    )


@router.post("/upload/commit", response_model=UploadResult)
def upload_commit(body: UploadCommitIn, db: Session = Depends(get_db)):
    """Applies a previously-previewed upload. `decisions` only needs entries
    for road IDs that were flagged as duplicates in the preview -- any
    accepted road with no decision (i.e. it was new, no conflict) is always
    added. 'keep' leaves the existing road completely untouched; 'replace'
    deletes its old segments and inserts the new ones (no mixing)."""
    _prune_pending_uploads()
    entry = _PENDING_UPLOADS.pop(body.token, None)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail="This upload session has expired or was already applied. Please re-upload the file.",
        )
    result, source_file, file_size, _ = entry

    existing_by_key = {road.road_id.strip().lower(): road for road in db.query(Road).all()}

    now = datetime.now(timezone.utc).isoformat()
    imported: list[RoadImportedOut] = []
    skipped: list[RoadSkippedOut] = []
    log_details: list[dict] = []

    for plan in result.accepted:
        existing = existing_by_key.get(plan.road_id.strip().lower())
        action = body.decisions.get(plan.road_id, "replace")

        if existing is not None and action == "keep":
            skipped.append(RoadSkippedOut(road_id=plan.road_id, road_name=plan.road_name))
            log_details.append(
                {
                    "road_id": plan.road_id,
                    "road_name": plan.road_name,
                    "action": "kept_existing",
                    "segment_count": existing.segment_count,
                }
            )
            continue

        # Snapshot the existing segments (and detect whether anything would
        # actually change) BEFORE the bulk delete below evicts them -- this
        # only affects what gets logged, never the replace/keep decision
        # itself or what ends up stored.
        is_up_to_date = False
        change_summary = None
        if existing is not None:
            existing_segments = list(existing.segments)
            is_up_to_date, change_summary = compare_segments(
                existing_segments, plan.segments, existing.road_name, plan.road_name
            )

        uploaded_at = existing.uploaded_at if existing is not None and existing.uploaded_at else now

        db.query(RoadSegment).filter(RoadSegment.road_id == plan.road_id).delete()
        db.query(Road).filter(Road.road_id == plan.road_id).delete()

        road = Road(
            road_id=plan.road_id,
            road_name=plan.road_name,
            updated_at=now,
            uploaded_at=uploaded_at,
            source_file=source_file,
            segment_count=len(plan.segments),
            total_length_m=plan.total_length_m,
        )
        db.add(road)

        for seq_no, seg in enumerate(plan.segments):
            db.add(
                RoadSegment(
                    road_id=plan.road_id,
                    seq_no=seq_no,
                    start_station_raw=seg.start_station_raw,
                    end_station_raw=seg.end_station_raw,
                    start_m=seg.start_m,
                    end_m=seg.end_m,
                    num_lanes=seg.num_lanes,
                    surface_type=seg.surface_type,
                    shoulder_left=seg.shoulder_left,
                    shoulder_right=seg.shoulder_right,
                    source_row_number=seg.row_number,
                )
            )

        row_action = "up_to_date" if is_up_to_date else ("replaced" if existing is not None else "added")
        imported.append(
            RoadImportedOut(
                road_id=plan.road_id,
                road_name=plan.road_name,
                segment_count=len(plan.segments),
                action=row_action,
            )
        )
        log_details.append(
            {
                "road_id": plan.road_id,
                "road_name": plan.road_name,
                "action": row_action,
                "segment_count": len(plan.segments),
                "change_summary": change_summary,
            }
        )

    for rejection in result.rejected:
        log_details.append(
            {
                "road_id": rejection.road_id,
                "road_name": rejection.road_id,
                "action": "rejected",
                "rejection_reasons": [f"Row {e.row} ({e.field}): {e.message}" for e in rejection.errors],
            }
        )

    write_log_entry(
        db,
        kind="upload",
        status="completed",
        file_name=source_file,
        file_size=file_size,
        total_rows=result.total_rows_processed,
        details=log_details,
    )

    db.commit()

    return UploadResult(
        imported=imported,
        rejected=_rejected_out(result),
        skipped=skipped,
        total_rows_processed=result.total_rows_processed,
        ignored_columns=result.ignored_columns,
    )


@router.post("/upload/cancel")
def upload_cancel(body: UploadCancelIn, db: Session = Depends(get_db)):
    """Logs a cancelled upload (whatever the preview found, nothing applied)
    and discards the pending token. Safe to call even if the token already
    expired -- still logs a minimal cancelled entry."""
    _prune_pending_uploads()
    entry = _PENDING_UPLOADS.pop(body.token, None)

    log_details: list[dict] = []
    file_name = None
    file_size = None
    total_rows = None
    if entry is not None:
        result, file_name, file_size, _ = entry
        total_rows = result.total_rows_processed
        for plan in result.accepted:
            log_details.append(
                {"road_id": plan.road_id, "road_name": plan.road_name, "action": "added", "segment_count": len(plan.segments)}
            )
        for rejection in result.rejected:
            log_details.append(
                {
                    "road_id": rejection.road_id,
                    "road_name": rejection.road_id,
                    "action": "rejected",
                    "rejection_reasons": [f"Row {e.row} ({e.field}): {e.message}" for e in rejection.errors],
                }
            )

    write_log_entry(
        db,
        kind="upload",
        status="cancelled",
        file_name=file_name,
        file_size=file_size,
        total_rows=total_rows,
        details=log_details,
    )
    db.commit()
    return {"logged": True}


@router.get("", response_model=list[RoadSummary])
def list_roads(db: Session = Depends(get_db)):
    roads = db.query(Road).order_by(Road.road_id).all()
    return [RoadSummary(road_id=r.road_id, road_name=r.road_name) for r in roads]


@router.get("/segments", response_model=SegmentsPage)
def list_segments(
    page: int = 1,
    page_size: int = 20,
    road_id: str | None = None,
    status: str | None = None,
    surface_type: str | None = None,
    sort_by: str | None = None,
    sort_dir: str = "asc",
    db: Session = Depends(get_db),
):
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")
    if page_size < 1 or page_size > 500:
        raise HTTPException(status_code=400, detail="page_size must be between 1 and 500")

    base_query = _filtered_segments_query(db, road_id, status, surface_type)
    total_records = base_query.count()
    total_pages = max(1, (total_records + page_size - 1) // page_size)

    rows = (
        _apply_sort(base_query, sort_by, sort_dir)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    records = [
        SegmentRecord(
            index=(page - 1) * page_size + i + 1,
            road_id=seg.road_id,
            road_name=road_name,
            start_station=seg.start_station_raw,
            end_station=seg.end_station_raw,
            num_lanes=seg.num_lanes,
            surface_type=seg.surface_type,
            shoulder_left=seg.shoulder_left,
            shoulder_right=seg.shoulder_right,
            status=_derive_status(seg.surface_type),
        )
        for i, (seg, road_name) in enumerate(rows)
    ]

    return SegmentsPage(
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        total_records=total_records,
        records=records,
    )


@router.get("/segments/export")
def export_segments(
    road_id: str | None = None,
    status: str | None = None,
    surface_type: str | None = None,
    sort_by: str | None = None,
    sort_dir: str = "asc",
    db: Session = Depends(get_db),
):
    base_query = _filtered_segments_query(db, road_id, status, surface_type)
    rows = _apply_sort(base_query, sort_by, sort_dir).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "Road ID",
            "Road Name",
            "Start Station",
            "End Station",
            "Number of Lanes",
            "Surface Type",
            "Left Shoulder",
            "Right Shoulder",
            "Status",
        ]
    )
    for seg, road_name in rows:
        writer.writerow(
            [
                seg.road_id,
                road_name,
                seg.start_station_raw,
                seg.end_station_raw,
                seg.num_lanes,
                seg.surface_type,
                seg.shoulder_left,
                seg.shoulder_right,
                _derive_status(seg.surface_type),
            ]
        )
    buffer.seek(0)

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=road_inventory_export.csv"},
    )


@router.get("/summary", response_model=NetworkSummary)
def get_network_summary(db: Session = Depends(get_db)):
    road_stats = (
        db.query(
            Road.road_id,
            Road.road_name,
            func.sum(RoadSegment.end_m - RoadSegment.start_m).label("total_length_m"),
            func.sum(
                case(
                    (RoadSegment.surface_type == "asphalt", RoadSegment.end_m - RoadSegment.start_m),
                    else_=0,
                )
            ).label("asphalt_length_m"),
        )
        .join(RoadSegment, RoadSegment.road_id == Road.road_id)
        .group_by(Road.road_id, Road.road_name)
        .order_by(Road.road_id)
        .all()
    )

    roads = []
    network_total = 0
    network_asphalt = 0
    for road_id, road_name, total_length_m, asphalt_length_m in road_stats:
        total_length_m = total_length_m or 0
        asphalt_length_m = asphalt_length_m or 0
        pct = round((asphalt_length_m / total_length_m) * 100) if total_length_m > 0 else 0
        roads.append(
            RoadSummaryStat(
                road_id=road_id,
                road_name=road_name,
                total_length_m=total_length_m,
                asphalt_length_m=asphalt_length_m,
                pct=pct,
            )
        )
        network_total += total_length_m
        network_asphalt += asphalt_length_m

    network_pct = round((network_asphalt / network_total) * 100) if network_total > 0 else 0

    return NetworkSummary(
        total_length_m=network_total,
        asphalt_length_m=network_asphalt,
        pct=network_pct,
        roads=roads,
    )


@router.get("/upload-log", response_model=UploadLogPage)
def get_upload_log(
    search: str | None = None,
    action: str | None = None,
    date_range: str | None = None,
    page: int = 1,
    page_size: int = 10,
    db: Session = Depends(get_db),
):
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")
    if page_size < 1 or page_size > 200:
        raise HTTPException(status_code=400, detail="page_size must be between 1 and 200")
    return query_log(db, search=search, action=action, date_range=date_range, page=page, page_size=page_size)


@router.get("/upload-log/export")
def export_upload_log(
    search: str | None = None,
    action: str | None = None,
    date_range: str | None = None,
    db: Session = Depends(get_db),
):
    csv_text = export_log_csv(db, search=search, action=action, date_range=date_range)
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=upload_history.csv"},
    )


@router.delete("/upload-log")
def clear_upload_log(db: Session = Depends(get_db)):
    count = db.query(UploadLogEntry).delete()
    db.commit()
    return {"cleared": count}


@router.get("/{road_id}", response_model=RoadDetail)
def get_road_detail(road_id: str, db: Session = Depends(get_db)):
    road = db.query(Road).filter(Road.road_id == road_id).first()
    if road is None:
        raise HTTPException(status_code=404, detail=f"Road '{road_id}' not found")

    segments = [
        SegmentOut(
            seq_no=seg.seq_no,
            start_station=seg.start_station_raw,
            end_station=seg.end_station_raw,
            start_m=seg.start_m,
            end_m=seg.end_m,
            num_lanes=seg.num_lanes,
            surface_type=seg.surface_type,
            shoulder_left=seg.shoulder_left,
            shoulder_right=seg.shoulder_right,
        )
        for seg in road.segments
    ]

    return RoadDetail(
        road_id=road.road_id,
        road_name=road.road_name,
        total_length_m=road.total_length_m,
        segments=segments,
    )


@router.delete("/{road_id}")
def delete_road(road_id: str, db: Session = Depends(get_db)):
    road = db.query(Road).filter(Road.road_id == road_id).first()
    if road is None:
        raise HTTPException(status_code=404, detail=f"Road '{road_id}' not found")
    road_name = road.road_name
    db.delete(road)
    write_log_entry(
        db,
        kind="delete",
        status="completed",
        details=[{"road_id": road_id, "road_name": road_name, "action": "deleted"}],
    )
    db.commit()
    return {"deleted": road_id}
