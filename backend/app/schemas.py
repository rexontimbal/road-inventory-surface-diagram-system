from typing import Literal

from pydantic import BaseModel


class GoogleAuthIn(BaseModel):
    id_token: str


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    avatar_url: str | None = None


class MeOut(BaseModel):
    authenticated: bool
    user: UserOut | None = None


class GuestStatusOut(BaseModel):
    is_guest: bool
    has_data: bool
    expires_at: str | None = None


class GuestMergePreview(BaseModel):
    new_roads: list["RoadPreviewNew"]
    duplicates: list["RoadPreviewDuplicate"]


class GuestMergeCommitIn(BaseModel):
    decisions: dict[str, Literal["replace", "keep"]] = {}


class GuestMergeResult(BaseModel):
    moved: int
    replaced: int
    kept: int


class RoadSummary(BaseModel):
    section_id: str
    road_name: str
    classification: str | None = None
    deo: str | None = None
    ld: str | None = None


class SegmentOut(BaseModel):
    seq_no: int
    start_station: str
    end_station: str
    start_m: float
    end_m: float
    length_m: float
    irregular_km_post: bool
    num_lanes: int
    surface_type: str
    shoulder_left: str
    shoulder_right: str


class RoadDetail(BaseModel):
    section_id: str
    road_name: str
    classification: str | None = None
    deo: str | None = None
    ld: str | None = None
    total_length_m: float
    segments: list[SegmentOut]


class SegmentRecord(BaseModel):
    id: int
    index: int
    section_id: str
    road_name: str
    classification: str | None = None
    deo: str | None = None
    ld: str | None = None
    start_station: str
    end_station: str
    length_m: float
    irregular_km_post: bool
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


class RowWarningOut(BaseModel):
    row: int
    field: str
    message: str
    kind: str


class WarningGroupOut(BaseModel):
    kind: str
    label: str
    count: int


class RoadRejectionOut(BaseModel):
    section_id: str
    errors: list[RowErrorOut]


class RoadImportedOut(BaseModel):
    section_id: str
    road_name: str
    segment_count: int
    action: Literal["added", "replaced", "up_to_date"] = "added"
    warnings: list[RowWarningOut] = []
    warning_groups: list[WarningGroupOut] = []


class RoadSkippedOut(BaseModel):
    section_id: str
    road_name: str


class UploadResult(BaseModel):
    imported: list[RoadImportedOut]
    rejected: list[RoadRejectionOut]
    skipped: list[RoadSkippedOut] = []
    total_rows_processed: int
    ignored_columns: list[str]
    log_id: int | None = None
    # Grouped across every imported section, for one summary line in the
    # upload-result toast ("51 irregular km post · 184 gaps/overlaps · 1
    # blank shoulder") instead of one line per row.
    warning_groups: list[WarningGroupOut] = []


class RoadPreviewNew(BaseModel):
    section_id: str
    road_name: str
    segment_count: int
    total_length_m: float


class RoadPreviewDuplicate(BaseModel):
    section_id: str
    existing_road_name: str
    new_road_name: str
    name_changed: bool
    existing_segment_count: int
    existing_total_length_m: float
    existing_updated_at: str
    existing_source_file: str | None
    new_segment_count: int
    new_total_length_m: float


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
    section_id: str
    road_name: str
    action: Literal["added", "replaced", "kept_existing", "up_to_date", "rejected", "deleted", "edited"]
    segment_count: int | None = None
    change_summary: str | None = None
    rejection_reasons: list[str] = []
    warning_groups: list[WarningGroupOut] = []


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
    # "Who did it" (Part 5). user_id/actor_* are None for BOTH a guest
    # action and a pre-tracking workspace action -- is_guest_action is what
    # the frontend uses to tell those two "None" cases apart (Guest vs
    # Unknown) without re-deriving owner_type itself.
    is_guest_action: bool
    user_id: int | None = None
    actor_name: str | None = None
    actor_email: str | None = None
    actor_avatar_url: str | None = None


class LogUserOut(BaseModel):
    user_id: int
    name: str | None


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
    section_id: str
    road_name: str
    deo: str | None = None
    total_length_m: float
    asphalt_length_m: float
    pct: int


class NetworkSummary(BaseModel):
    total_length_m: float
    asphalt_length_m: float
    pct: int
    roads: list[RoadSummaryStat]


class FilteredSegmentsSummary(BaseModel):
    total_length_m: float
    asphalt_length_m: float
    pct: int
    # Only set when a surface_type filter was applied -- the same filters'
    # total length WITHOUT that surface_type narrowing, so the frontend can
    # show "<Surface>: X km of Y km" (X = total_length_m here, Y = this).
    baseline_length_m: float | None = None


class LaneCountsOut(BaseModel):
    lanes: list[int]


# ===== Backup / Restore =====
# A backup is a full snapshot of what's in the backend DB -- road data was
# never stored client-side, so this is what actually protects against the
# Render free-tier DB reset on every redeploy (not browser storage limits).

APP_NAME = "road-inventory-surface-diagram-system"
BACKUP_VERSION = 1


class BackupSegment(BaseModel):
    seq_no: int
    start_text: str
    end_text: str
    start_m: float
    end_m: float
    length_m: float
    irregular_km_post: bool
    num_lanes: int
    surface_type: str
    shoulder_left: str
    shoulder_right: str


class BackupRoad(BaseModel):
    section_id: str
    road_name: str
    classification: str | None = None
    deo: str | None = None
    ld: str | None = None
    updated_at: str
    uploaded_at: str | None = None
    source_file: str | None = None
    segment_count: int
    total_length_m: float
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
