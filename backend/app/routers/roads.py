import csv
import io
import time
from datetime import datetime, timezone
from uuid import uuid4

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import case, func
from sqlalchemy.orm import Session
from starlette.responses import StreamingResponse

from app.db import get_db
from app.chainage import summarize_warnings
from app.excel_import import ImportResult, TemplateError, parse_upload
from app.models import SHOULDER_TYPES, SURFACE_TYPES, Road, RoadSegment, UploadLogEntry  # noqa: F401 -- UploadLogEntry import registers the table for create_all
from app.scope import Scope, apply_scope, get_scope, owner_kwargs, user_kwargs
from app.schemas import (
    LogUserOut,
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
    RowWarningOut,
    SegmentEditIn,
    WarningGroupOut,
    SegmentEditOut,
    SegmentFieldChange,
    SegmentOut,
    SegmentRecord,
    SegmentsPage,
    UploadCancelIn,
    UploadCommitIn,
    UploadLogPage,
    UploadPreview,
    UploadResult,
)
from app.upload_log import compare_segments, export_log_csv, list_log_users, query_log, write_log_entry

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
    "section_id": RoadSegment.section_id,
    "road_name": Road.road_name,
    # Sorted on the parsed numeric-meters columns, not the raw station text,
    # so stations order numerically rather than lexically.
    "start_station": RoadSegment.start_m,
    "end_station": RoadSegment.end_m,
    "length_m": RoadSegment.length_m,
    "num_lanes": RoadSegment.num_lanes,
    "surface_type": RoadSegment.surface_type,
    "shoulder_left": RoadSegment.shoulder_left,
    "shoulder_right": RoadSegment.shoulder_right,
    "status": _STATUS_RANK,
}


def _filtered_segments_query(db, scope: Scope, section_id, district, classification, status, surface_type):
    if status is not None and status not in ("Complete", "Incomplete"):
        raise HTTPException(status_code=400, detail="status must be 'Complete' or 'Incomplete'")

    # section_id alone is no longer unique across scopes (see Road's composite
    # primary key) -- the join must match the full (section_id, owner_type,
    # owner_id) triple, or a guest's segment could join against the
    # workspace's same-section_id road (or vice versa) and leak its road_name.
    query = db.query(RoadSegment, Road.road_name, Road.classification, Road.deo, Road.ld).join(
        Road,
        (Road.section_id == RoadSegment.section_id)
        & (Road.owner_type == RoadSegment.owner_type)
        & (Road.owner_id == RoadSegment.owner_id),
    )
    query = apply_scope(query, Road, scope)

    if section_id:
        query = query.filter(RoadSegment.section_id == section_id)
    if district:
        query = query.filter(Road.deo == district)
    if classification:
        query = query.filter(Road.classification == classification)
    if surface_type:
        query = query.filter(RoadSegment.surface_type == surface_type)
    if status == "Complete":
        query = query.filter(RoadSegment.surface_type == "asphalt")
    elif status == "Incomplete":
        query = query.filter(RoadSegment.surface_type != "asphalt")

    return query


def _apply_sort(query, sort_by, sort_dir):
    if sort_by is None:
        return query.order_by(RoadSegment.section_id, RoadSegment.seq_no)

    column = _SORT_COLUMNS.get(sort_by)
    if column is None:
        raise HTTPException(
            status_code=400, detail=f"sort_by must be one of {sorted(_SORT_COLUMNS)}"
        )
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sort_dir must be 'asc' or 'desc'")

    ordered = column.desc() if sort_dir == "desc" else column.asc()
    # Secondary key keeps same-value rows in a stable, predictable sequence.
    return query.order_by(ordered, RoadSegment.section_id, RoadSegment.seq_no)


def _rejected_out(result: ImportResult) -> list[RoadRejectionOut]:
    return [
        RoadRejectionOut(
            section_id=r.section_id,
            errors=[RowErrorOut(row=e.row, field=e.field, message=e.message) for e in r.errors],
        )
        for r in result.rejected
    ]


_TEMPLATE_COLUMNS = [
    "Section ID",
    "Classification",
    "DEO",
    "LD",
    "Road Name",
    "Start",
    "End",
    "Number of Lanes",
    "Surface type",
    "LEFT",
    "RIGHT",
]


@router.get("/template")
def download_template():
    """A blank DPWH-format workbook the user can fill in and re-upload --
    single header row (no decorative group-header row) is fine since the
    parser finds the header row by content, not by a fixed row number."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Road Data"
    ws.append(_TEMPLATE_COLUMNS)
    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=road_inventory_template.xlsx"},
    )


@router.post("/upload/preview", response_model=UploadPreview)
async def upload_preview(file: UploadFile, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Parses and validates the file (same rules as before) but writes
    nothing. Splits accepted roads into brand-new vs. Section-ID conflicts
    with an existing road (trimmed, case-insensitive match) so the frontend
    can ask the user how to handle each conflict before anything is saved.
    "Existing" only ever means within the caller's own scope -- a guest's
    upload can never conflict with (or even see) the shared workspace's
    roads, and vice versa."""
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
            **owner_kwargs(scope),
            **user_kwargs(scope),
        )
        db.commit()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _prune_pending_uploads()
    token = str(uuid4())
    _PENDING_UPLOADS[token] = (result, file.filename, len(contents), time.time() + _PENDING_TTL_SECONDS)

    existing_by_key = {
        road.section_id.strip().lower(): road for road in apply_scope(db.query(Road), Road, scope).all()
    }

    new_roads: list[RoadPreviewNew] = []
    duplicates: list[RoadPreviewDuplicate] = []
    for plan in result.accepted:
        existing = existing_by_key.get(plan.section_id.strip().lower())
        if existing is None:
            new_roads.append(
                RoadPreviewNew(
                    section_id=plan.section_id,
                    road_name=plan.road_name,
                    segment_count=len(plan.segments),
                    total_length_m=plan.total_length_m,
                )
            )
        else:
            duplicates.append(
                RoadPreviewDuplicate(
                    section_id=plan.section_id,
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
def upload_commit(body: UploadCommitIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    """Applies a previously-previewed upload. `decisions` only needs entries
    for section IDs that were flagged as duplicates in the preview -- any
    accepted road with no decision (i.e. it was new, no conflict) is always
    added. 'keep' leaves the existing road completely untouched; 'replace'
    deletes its old segments and inserts the new ones (no mixing).

    Segment rows are bulk-inserted in one transaction (bulk_insert_mappings,
    not one ORM object + db.add() per row) -- a real DPWH file runs to
    ~11,200 rows, and per-row ORM object construction/flush tracking is the
    bottleneck at that volume."""
    _prune_pending_uploads()
    entry = _PENDING_UPLOADS.pop(body.token, None)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail="This upload session has expired or was already applied. Please re-upload the file.",
        )
    result, source_file, file_size, _ = entry

    existing_by_key = {
        road.section_id.strip().lower(): road for road in apply_scope(db.query(Road), Road, scope).all()
    }

    now = datetime.now(timezone.utc).isoformat()
    imported: list[RoadImportedOut] = []
    skipped: list[RoadSkippedOut] = []
    log_details: list[dict] = []
    segment_mappings: list[dict] = []
    all_warnings = []
    owner = owner_kwargs(scope)

    for plan in result.accepted:
        existing = existing_by_key.get(plan.section_id.strip().lower())
        action = body.decisions.get(plan.section_id, "replace")

        if existing is not None and action == "keep":
            skipped.append(RoadSkippedOut(section_id=plan.section_id, road_name=plan.road_name))
            log_details.append(
                {
                    "section_id": plan.section_id,
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

        apply_scope(db.query(RoadSegment), RoadSegment, scope).filter(
            RoadSegment.section_id == plan.section_id
        ).delete()
        apply_scope(db.query(Road), Road, scope).filter(Road.section_id == plan.section_id).delete()

        road = Road(
            section_id=plan.section_id,
            road_name=plan.road_name,
            classification=plan.classification,
            deo=plan.deo,
            ld=plan.ld,
            updated_at=now,
            uploaded_at=uploaded_at,
            source_file=source_file,
            segment_count=len(plan.segments),
            total_length_m=plan.total_length_m,
            **owner,
        )
        db.add(road)

        for seq_no, seg in enumerate(plan.segments):
            segment_mappings.append(
                {
                    "section_id": plan.section_id,
                    "owner_type": owner["owner_type"],
                    "owner_id": owner["owner_id"],
                    "seq_no": seq_no,
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
                    "source_row_number": seg.row_number,
                }
            )

        row_action = "up_to_date" if is_up_to_date else ("replaced" if existing is not None else "added")
        section_warning_groups = [WarningGroupOut(**g) for g in summarize_warnings(plan.warnings)]
        all_warnings.extend(plan.warnings)
        imported.append(
            RoadImportedOut(
                section_id=plan.section_id,
                road_name=plan.road_name,
                segment_count=len(plan.segments),
                action=row_action,
                warnings=[
                    RowWarningOut(row=w.row, field=w.field, message=w.message, kind=w.kind) for w in plan.warnings
                ],
                warning_groups=section_warning_groups,
            )
        )
        log_details.append(
            {
                "section_id": plan.section_id,
                "road_name": plan.road_name,
                "action": row_action,
                "segment_count": len(plan.segments),
                "change_summary": change_summary,
                "warning_groups": [g.model_dump() for g in section_warning_groups],
            }
        )

    for rejection in result.rejected:
        log_details.append(
            {
                "section_id": rejection.section_id,
                "road_name": rejection.section_id,
                "action": "rejected",
                "rejection_reasons": [f"Row {e.row} ({e.field}): {e.message}" for e in rejection.errors],
            }
        )

    # Flush Road rows first so the segments' FK (section_id, owner_type,
    # owner_id -> roads) resolves, then bulk-insert every segment in one
    # round trip instead of one db.add() per row.
    db.flush()
    if segment_mappings:
        db.bulk_insert_mappings(RoadSegment, segment_mappings)

    log_entry = write_log_entry(
        db,
        kind="upload",
        status="completed",
        file_name=source_file,
        file_size=file_size,
        total_rows=result.total_rows_processed,
        details=log_details,
        **owner_kwargs(scope),
        **user_kwargs(scope),
    )

    db.commit()

    return UploadResult(
        imported=imported,
        rejected=_rejected_out(result),
        skipped=skipped,
        total_rows_processed=result.total_rows_processed,
        ignored_columns=result.ignored_columns,
        log_id=log_entry.id,
        warning_groups=[WarningGroupOut(**g) for g in summarize_warnings(all_warnings)],
    )


@router.post("/upload/cancel")
def upload_cancel(body: UploadCancelIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
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
                {
                    "section_id": plan.section_id,
                    "road_name": plan.road_name,
                    "action": "added",
                    "segment_count": len(plan.segments),
                }
            )
        for rejection in result.rejected:
            log_details.append(
                {
                    "section_id": rejection.section_id,
                    "road_name": rejection.section_id,
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
        **owner_kwargs(scope),
        **user_kwargs(scope),
    )
    db.commit()
    return {"logged": True}


@router.get("", response_model=list[RoadSummary])
def list_roads(db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    roads = apply_scope(db.query(Road), Road, scope).order_by(Road.section_id).all()
    return [
        RoadSummary(
            section_id=r.section_id,
            road_name=r.road_name,
            classification=r.classification,
            deo=r.deo,
            ld=r.ld,
        )
        for r in roads
    ]


@router.get("/segments", response_model=SegmentsPage)
def list_segments(
    page: int = 1,
    page_size: int = 20,
    section_id: str | None = None,
    district: str | None = None,
    classification: str | None = None,
    status: str | None = None,
    surface_type: str | None = None,
    sort_by: str | None = None,
    sort_dir: str = "asc",
    db: Session = Depends(get_db),
    scope: Scope = Depends(get_scope),
):
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")
    if page_size < 1 or page_size > 500:
        raise HTTPException(status_code=400, detail="page_size must be between 1 and 500")

    base_query = _filtered_segments_query(db, scope, section_id, district, classification, status, surface_type)
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
            id=seg.id,
            index=(page - 1) * page_size + i + 1,
            section_id=seg.section_id,
            road_name=road_name,
            classification=seg_classification,
            deo=seg_deo,
            ld=seg_ld,
            start_station=seg.start_text,
            end_station=seg.end_text,
            length_m=seg.length_m,
            irregular_km_post=seg.irregular_km_post,
            num_lanes=seg.num_lanes,
            surface_type=seg.surface_type,
            shoulder_left=seg.shoulder_left,
            shoulder_right=seg.shoulder_right,
            status=_derive_status(seg.surface_type),
        )
        for i, (seg, road_name, seg_classification, seg_deo, seg_ld) in enumerate(rows)
    ]

    return SegmentsPage(
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        total_records=total_records,
        records=records,
    )


_EDITABLE_FIELD_LABELS = {
    "num_lanes": "Number of Lanes",
    "surface_type": "Surface Type",
    "shoulder_left": "Left Shoulder",
    "shoulder_right": "Right Shoulder",
}


@router.patch("/segments/{segment_id}", response_model=SegmentEditOut)
def edit_segment(
    segment_id: int, body: SegmentEditIn, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)
):
    """Inline table edit for a single segment -- stations are intentionally
    not editable here (that risks creating gaps/overlaps with neighboring
    segments; those still require a full Excel re-upload). Any actual change
    bumps the parent road's updated_at and writes one 'edit' log entry so
    there's an audit trail, same as every other data-changing action."""
    # id alone is globally unique (not part of the scoping key), so without
    # the scope filter a guest could edit another scope's segment just by
    # guessing/incrementing an id -- scoped out here means "not found",
    # same as if it never existed, rather than a separate 403.
    seg = apply_scope(db.query(RoadSegment), RoadSegment, scope).filter(RoadSegment.id == segment_id).first()
    if seg is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    road = apply_scope(db.query(Road), Road, scope).filter(Road.section_id == seg.section_id).first()

    if body.num_lanes is not None and not (1 <= body.num_lanes <= 12):
        raise HTTPException(status_code=400, detail="Number of Lanes must be between 1 and 12")
    if body.surface_type is not None and body.surface_type not in SURFACE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"{_EDITABLE_FIELD_LABELS['surface_type']} must be one of {sorted(SURFACE_TYPES)}",
        )
    for field_name in ("shoulder_left", "shoulder_right"):
        value = getattr(body, field_name)
        if value is not None and value not in SHOULDER_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"{_EDITABLE_FIELD_LABELS[field_name]} must be one of {sorted(SHOULDER_TYPES)}",
            )

    changes: list[SegmentFieldChange] = []
    change_dicts: list[dict] = []
    for field_name, label in _EDITABLE_FIELD_LABELS.items():
        new_value = getattr(body, field_name)
        if new_value is None:
            continue
        old_value = getattr(seg, field_name)
        if str(new_value) == str(old_value):
            continue
        setattr(seg, field_name, new_value)
        changes.append(SegmentFieldChange(field=label, old=str(old_value), new=str(new_value)))
        change_dicts.append({"field": label, "old": str(old_value), "new": str(new_value)})

    if changes:
        road.updated_at = datetime.now(timezone.utc).isoformat()
        write_log_entry(
            db,
            kind="edit",
            status="completed",
            file_name=f"Inline edit: {seg.section_id} ({seg.start_text}–{seg.end_text})",
            details=[
                {
                    "section_id": seg.section_id,
                    "road_name": road.road_name,
                    "action": "edited",
                    "change_summary": "; ".join(f"{c['field']}: {c['old']} → {c['new']}" for c in change_dicts),
                }
            ],
            **owner_kwargs(scope),
            **user_kwargs(scope),
        )

    db.commit()
    db.refresh(seg)

    return SegmentEditOut(
        segment=SegmentRecord(
            id=seg.id,
            index=0,
            section_id=seg.section_id,
            road_name=road.road_name,
            start_station=seg.start_text,
            end_station=seg.end_text,
            num_lanes=seg.num_lanes,
            surface_type=seg.surface_type,
            shoulder_left=seg.shoulder_left,
            shoulder_right=seg.shoulder_right,
            status=_derive_status(seg.surface_type),
        ),
        changes=changes,
    )


@router.get("/segments/export")
def export_segments(
    section_id: str | None = None,
    district: str | None = None,
    classification: str | None = None,
    status: str | None = None,
    surface_type: str | None = None,
    sort_by: str | None = None,
    sort_dir: str = "asc",
    db: Session = Depends(get_db),
    scope: Scope = Depends(get_scope),
):
    base_query = _filtered_segments_query(db, scope, section_id, district, classification, status, surface_type)
    rows = _apply_sort(base_query, sort_by, sort_dir).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "Section ID",
            "Road Name",
            "Classification",
            "DEO",
            "LD",
            "Start Station",
            "End Station",
            "Length (m)",
            "Number of Lanes",
            "Surface Type",
            "Left Shoulder",
            "Right Shoulder",
            "Status",
        ]
    )
    for seg, road_name, seg_classification, seg_deo, seg_ld in rows:
        writer.writerow(
            [
                seg.section_id,
                road_name,
                seg_classification,
                seg_deo,
                seg_ld,
                seg.start_text,
                seg.end_text,
                seg.length_m,
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
def get_network_summary(db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    road_stats = (
        apply_scope(
            db.query(
                Road.section_id,
                Road.road_name,
                Road.deo,
                func.sum(RoadSegment.length_m).label("total_length_m"),
                func.sum(
                    case(
                        (RoadSegment.surface_type == "asphalt", RoadSegment.length_m),
                        else_=0,
                    )
                ).label("asphalt_length_m"),
            ),
            Road,
            scope,
        )
        # Full composite join -- see _filtered_segments_query's comment on
        # why section_id alone is not enough to match the right scope's rows.
        .join(
            RoadSegment,
            (RoadSegment.section_id == Road.section_id)
            & (RoadSegment.owner_type == Road.owner_type)
            & (RoadSegment.owner_id == Road.owner_id),
        )
        .group_by(Road.section_id, Road.road_name, Road.deo)
        .order_by(Road.section_id)
        .all()
    )

    roads = []
    network_total = 0.0
    network_asphalt = 0.0
    for section_id, road_name, deo, total_length_m, asphalt_length_m in road_stats:
        total_length_m = total_length_m or 0.0
        asphalt_length_m = asphalt_length_m or 0.0
        pct = round((asphalt_length_m / total_length_m) * 100) if total_length_m > 0 else 0
        roads.append(
            RoadSummaryStat(
                section_id=section_id,
                road_name=road_name,
                deo=deo,
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
    by_user: str | None = None,
    page: int = 1,
    page_size: int = 10,
    db: Session = Depends(get_db),
    scope: Scope = Depends(get_scope),
):
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")
    if page_size < 1 or page_size > 200:
        raise HTTPException(status_code=400, detail="page_size must be between 1 and 200")
    return query_log(
        db, scope=scope, search=search, action=action, date_range=date_range, by_user=by_user, page=page, page_size=page_size
    )


@router.get("/upload-log/users", response_model=list[LogUserOut])
def get_upload_log_users(db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    return list_log_users(db, scope=scope)


@router.get("/upload-log/export")
def export_upload_log(
    search: str | None = None,
    action: str | None = None,
    date_range: str | None = None,
    by_user: str | None = None,
    db: Session = Depends(get_db),
    scope: Scope = Depends(get_scope),
):
    csv_text = export_log_csv(db, scope=scope, search=search, action=action, date_range=date_range, by_user=by_user)
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=upload_history.csv"},
    )


@router.delete("/upload-log")
def clear_upload_log(db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    count = apply_scope(db.query(UploadLogEntry), UploadLogEntry, scope).delete()
    db.commit()
    return {"cleared": count}


@router.get("/{section_id}", response_model=RoadDetail)
def get_road_detail(section_id: str, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    road = apply_scope(db.query(Road), Road, scope).filter(Road.section_id == section_id).first()
    if road is None:
        raise HTTPException(status_code=404, detail=f"Section '{section_id}' not found")

    segments = [
        SegmentOut(
            seq_no=seg.seq_no,
            start_station=seg.start_text,
            end_station=seg.end_text,
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

    return RoadDetail(
        section_id=road.section_id,
        road_name=road.road_name,
        classification=road.classification,
        deo=road.deo,
        ld=road.ld,
        total_length_m=road.total_length_m,
        segments=segments,
    )


@router.delete("/{section_id}")
def delete_road(section_id: str, db: Session = Depends(get_db), scope: Scope = Depends(get_scope)):
    road = apply_scope(db.query(Road), Road, scope).filter(Road.section_id == section_id).first()
    if road is None:
        raise HTTPException(status_code=404, detail=f"Section '{section_id}' not found")
    road_name = road.road_name
    db.delete(road)
    write_log_entry(
        db,
        kind="delete",
        status="completed",
        details=[{"section_id": section_id, "road_name": road_name, "action": "deleted"}],
        **owner_kwargs(scope),
        **user_kwargs(scope),
    )
    db.commit()
    return {"deleted": section_id}
