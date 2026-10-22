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


class ShareIn(BaseModel):
    email: str
    role: Literal["viewer", "editor"]


class ShareRoleIn(BaseModel):
    role: Literal["viewer", "editor"]


class ShareOut(BaseModel):
    id: int
    email: str
    role: Literal["viewer", "editor"]
    name: str | None = None
    avatar_url: str | None = None
    pending: bool


class ShareOwnerOut(BaseModel):
    user_id: int
    name: str
    email: str
    avatar_url: str | None = None


class SharesListOut(BaseModel):
    owner: ShareOwnerOut
    people: list[ShareOut]


class WorkspaceSwitchIn(BaseModel):
    # None (or omitted) switches back to the caller's own workspace.
    owner_user_id: int | None = None


class SharedWorkspaceOut(BaseModel):
    share_id: int
    owner_user_id: int
    owner_name: str
    owner_email: str
    owner_avatar_url: str | None = None
    role: Literal["viewer", "editor"]
    # Drives the avatar-dropdown "New" pill / muted role-change line (Part 3)
    # straight off the same list the switcher already renders, no second
    # fetch needed just for that.
    is_new: bool
    last_change: Literal["shared", "role_changed"] | None = None


class WorkspaceContextOut(BaseModel):
    mode: Literal["own", "shared"]
    role: Literal["owner", "editor", "viewer"]
    owner_user_id: int | None = None
    owner_name: str | None = None
    owner_email: str | None = None
    shared_with_me: list[SharedWorkspaceOut]
    # Set (once) when the active_workspace cookie named a workspace that's
    # no longer actually shared with this account -- the request already
    # fell back to "my data" silently; this is just what lets the frontend
    # tell the user why, with one info toast, instead of their view
    # changing with no explanation. Cleared cookie-side the same request
    # it's reported in, so it's never reported twice.
    access_removed_owner_name: str | None = None


class ShareNotificationOut(BaseModel):
    share_id: int
    owner_user_id: int
    owner_name: str
    owner_email: str
    owner_avatar_url: str | None = None
    role: Literal["viewer", "editor"]
    last_change: Literal["shared", "role_changed"] | None = None
    is_new: bool


class NotificationsOut(BaseModel):
    new_count: int
    items: list[ShareNotificationOut]


class MarkNotificationsSeenIn(BaseModel):
    # None (or omitted) marks every unseen share seen; a specific id marks
    # just that one (used when switching into that workspace).
    share_id: int | None = None


class RoadSummary(BaseModel):
    section_id: str
    road_name: str
    classification: str | None = None
    deo: str | None = None
    ld: str | None = None


class SegmentOut(BaseModel):
    id: int
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
    start_m: float
    end_m: float
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
    kind: Literal["upload", "delete", "restore", "edit", "share"]
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


# ===== Delete all / delete by district =====
# "Delete all data" (optionally scoped to one District) -- distinct from
# single-section DELETE /{section_id}, which is untouched by this.


class DistrictDeleteStat(BaseModel):
    deo: str
    sections: int
    segments: int
    total_length_m: float


class DeletePreviewOut(BaseModel):
    total_sections: int
    total_segments: int
    total_length_m: float
    districts: list[DistrictDeleteStat]


class DeleteAllResult(BaseModel):
    deleted_sections: int
    deleted_segments: int
    total_length_m: float


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


class BackupDistrict(BaseModel):
    deo: str
    ld: str | None = None


class BackupExport(BaseModel):
    app_name: str = APP_NAME
    backup_version: int = BACKUP_VERSION
    exported_at: str
    # "all" (whole active workspace) or "district" (one DEO only) -- set by
    # GET /api/backup/export's optional ?district= param. Carried through
    # restore preview/commit so a district backup's "Replace this District"
    # mode knows which district to scope its delete to, without re-deriving
    # it from the (freeform) roads list.
    scope: Literal["all", "district"] = "all"
    district: BackupDistrict | None = None
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
