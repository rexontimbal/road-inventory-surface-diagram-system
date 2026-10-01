from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.db import get_db
from app.excel_import import TemplateError, parse_upload
from app.models import Road, RoadSegment
from app.schemas import (
    RoadDetail,
    RoadImportedOut,
    RoadRejectionOut,
    RoadSummary,
    RowErrorOut,
    SegmentOut,
    SegmentRecord,
    SegmentsPage,
    UploadResult,
)

router = APIRouter(prefix="/api/roads", tags=["roads"])


def _derive_status(surface_type: str) -> str:
    return "Complete" if surface_type == "asphalt" else "Incomplete"


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
    db: Session = Depends(get_db),
):
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be >= 1")
    if page_size < 1 or page_size > 500:
        raise HTTPException(status_code=400, detail="page_size must be between 1 and 500")
    if status is not None and status not in ("Complete", "Incomplete"):
        raise HTTPException(status_code=400, detail="status must be 'Complete' or 'Incomplete'")

    base_query = db.query(RoadSegment, Road.road_name).join(Road, Road.road_id == RoadSegment.road_id)

    if road_id:
        base_query = base_query.filter(RoadSegment.road_id == road_id)
    if surface_type:
        base_query = base_query.filter(RoadSegment.surface_type == surface_type)
    if status == "Complete":
        base_query = base_query.filter(RoadSegment.surface_type == "asphalt")
    elif status == "Incomplete":
        base_query = base_query.filter(RoadSegment.surface_type != "asphalt")

    total_records = base_query.count()
    total_pages = max(1, (total_records + page_size - 1) // page_size)

    rows = (
        base_query.order_by(RoadSegment.road_id, RoadSegment.seq_no)
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
