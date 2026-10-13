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
    id: int
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
    action: Literal["added", "replaced", "kept_existing", "up_to_date", "rejected", "deleted", "edited"]
    segment_count: int | None = None
    change_summary: str | None = None
    rejection_reasons: list[str] = []


class UploadLogOut(BaseModel):
    id: int
    timestamp: str
    kind: Literal["upload", "delete", "restore", "edit"]
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
    edited_count: int
    details: list[LogRoadDetail]


class SegmentEditIn(BaseModel):
    num_lanes: int | None = None
    surface_type: str | None = None
    shoulder_left: str | None = None
    shoulder_right: str | None = None


class SegmentFieldChange(BaseModel):
    field: str
    old: str
    new: str


class SegmentEditOut(BaseModel):
    segment: SegmentRecord
    changes: list[SegmentFieldChange]


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


# ===== Backup / Restore =====
# A backup is a full snapshot of what's in the backend DB -- road data was
# never stored client-side, so this is what actually protects against the
# Render free-tier DB reset on every redeploy (not browser storage limits).

APP_NAME = "road-inventory-surface-diagram-system"
BACKUP_VERSION = 1


class BackupSegment(BaseModel):
    seq_no: int
    start_station_raw: str
    end_station_raw: str
    start_m: int
    end_m: int
    num_lanes: int
    surface_type: str
    shoulder_left: str
    shoulder_right: str


class BackupRoad(BaseModel):
    road_id: str
    road_name: str
    updated_at: str
    uploaded_at: str | None = None
    source_file: str | None = None
    segment_count: int
    total_length_m: int
    segments: list[BackupSegment]


class BackupCounts(BaseModel):
    roads: int
    segments: int
    logs: int


class BackupExport(BaseModel):
    app_name: str = APP_NAME
    backup_version: int = BACKUP_VERSION
    exported_at: str
    counts: BackupCounts
    roads: list[BackupRoad]
    upload_log: list[UploadLogOut] = []


class RestorePreviewIn(BaseModel):
    backup: BackupExport


class RestorePreview(BaseModel):
    token: str
    backup_exported_at: str
    backup_counts: BackupCounts
    current_counts: BackupCounts
    new_roads: list[RoadPreviewNew]
    duplicates: list[RoadPreviewDuplicate]


class RestoreCommitIn(BaseModel):
    token: str
    mode: Literal["replace_all", "merge"]
    decisions: dict[str, Literal["replace", "keep"]] = {}


class RestoreResult(BaseModel):
    added: int
    replaced: int
    kept: int
    total_roads: int
