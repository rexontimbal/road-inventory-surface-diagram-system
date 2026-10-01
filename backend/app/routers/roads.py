import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import case, func
from sqlalchemy.orm import Session
from starlette.responses import StreamingResponse

from app.db import get_db
from app.excel_import import TemplateError, parse_upload
from app.models import Road, RoadSegment
from app.schemas import (
    NetworkSummary,
    RoadDetail,
    RoadImportedOut,
    RoadRejectionOut,
    RoadSummary,
    RoadSummaryStat,
    RowErrorOut,
    SegmentOut,
    SegmentRecord,
    SegmentsPage,
    UploadResult,
)

router = APIRouter(prefix="/api/roads", tags=["roads"])


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


@router.post("/upload", response_model=UploadResult)
async def upload_roads(file: UploadFile, db: Session = Depends(get_db)):
    contents = await file.read()
    try:
        result = parse_upload(contents)
    except TemplateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    imported: list[RoadImportedOut] = []
    now = datetime.now(timezone.utc).isoformat()

    for plan in result.accepted:
        db.query(RoadSegment).filter(RoadSegment.road_id == plan.road_id).delete()
        db.query(Road).filter(Road.road_id == plan.road_id).delete()

        total_length_m = plan.total_length_m
        road = Road(
            road_id=plan.road_id,
            road_name=plan.road_name,
            updated_at=now,
            segment_count=len(plan.segments),
            total_length_m=total_length_m,
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

        imported.append(
            RoadImportedOut(
                road_id=plan.road_id,
                road_name=plan.road_name,
                segment_count=len(plan.segments),
            )
        )

    db.commit()

    rejected = [
        RoadRejectionOut(
            road_id=r.road_id,
            errors=[RowErrorOut(row=e.row, field=e.field, message=e.message) for e in r.errors],
        )
        for r in result.rejected
    ]

    return UploadResult(
        imported=imported,
        rejected=rejected,
        total_rows_processed=result.total_rows_processed,
        ignored_columns=result.ignored_columns,
    )


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
    db.delete(road)
    db.commit()
    return {"deleted": road_id}
