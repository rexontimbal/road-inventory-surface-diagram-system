from typing import Literal

from pydantic import BaseModel


class RoadSummary(BaseModel):
    road_id: str
    road_name: str


class SegmentOut(BaseModel):
    seq_no: int
    start_station: str
    end_station: str
    start_m: int
    end_m: int
    num_lanes: int
    surface_type: str
    shoulder_left: str
    shoulder_right: str


class RoadDetail(BaseModel):
    road_id: str
    road_name: str
    total_length_m: int
    segments: list[SegmentOut]


class SegmentRecord(BaseModel):
    index: int
    road_id: str
    road_name: str
    start_station: str
    end_station: str
    num_lanes: int
    surface_type: str
    shoulder_left: str
    shoulder_right: str
    status: str


class SegmentsPage(BaseModel):
    page: int
    page_size: int
    total_pages: int
    total_records: int
    records: list[SegmentRecord]


class RowErrorOut(BaseModel):
    row: int
    field: str
    message: str


class RoadRejectionOut(BaseModel):
    road_id: str
    errors: list[RowErrorOut]


class RoadImportedOut(BaseModel):
    road_id: str
    road_name: str
    segment_count: int
    action: Literal["added", "replaced", "up_to_date"] = "added"


class RoadSkippedOut(BaseModel):
    road_id: str
    road_name: str


class UploadResult(BaseModel):
    imported: list[RoadImportedOut]
    rejected: list[RoadRejectionOut]
    skipped: list[RoadSkippedOut] = []
    total_rows_processed: int
    ignored_columns: list[str]


class RoadPreviewNew(BaseModel):
    road_id: str
    road_name: str
    segment_count: int
    total_length_m: int


class RoadPreviewDuplicate(BaseModel):
    road_id: str
    existing_road_name: str
    new_road_name: str
    name_changed: bool
    existing_segment_count: int
    existing_total_length_m: int
    existing_updated_at: str
    existing_source_file: str | None
    new_segment_count: int
    new_total_length_m: int


class UploadPreview(BaseModel):
    token: str
    source_file: str
    new_roads: list[RoadPreviewNew]
    duplicates: list[RoadPreviewDuplicate]
    rejected: list[RoadRejectionOut]
    total_rows_processed: int
    ignored_columns: list[str]


class UploadCommitIn(BaseModel):
    token: str
    decisions: dict[str, Literal["replace", "keep"]] = {}


class UploadCancelIn(BaseModel):
    token: str


class LogRoadDetail(BaseModel):
    road_id: str
    road_name: str
    action: Literal["added", "replaced", "kept_existing", "up_to_date", "rejected", "deleted"]
    segment_count: int | None = None
    change_summary: str | None = None
    rejection_reasons: list[str] = []


class UploadLogOut(BaseModel):
    id: int
    timestamp: str
    kind: Literal["upload", "delete"]
    status: Literal["completed", "cancelled", "failed"]
    file_name: str | None
    file_size: int | None
    total_rows: int | None
    error_message: str | None
    added_count: int
    replaced_count: int
    kept_count: int
    up_to_date_count: int
    rejected_count: int
    deleted_count: int
    details: list[LogRoadDetail]


class UploadLogPage(BaseModel):
    page: int
    page_size: int
    total_pages: int
    total_records: int
    entries: list[UploadLogOut]


class RoadSummaryStat(BaseModel):
    road_id: str
    road_name: str
    total_length_m: int
    asphalt_length_m: int
    pct: int


class NetworkSummary(BaseModel):
    total_length_m: int
    asphalt_length_m: int
    pct: int
    roads: list[RoadSummaryStat]
