from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.db import Base

# Main pavement surface, straight from DPWH's "Surface type" column.
SURFACE_TYPES = ("concrete", "asphalt", "gravel")
# Shoulder surface -- a superset of SURFACE_TYPES: shoulders can additionally
# be unpaved earth or have no shoulder at all ("none", which blank cells and
# the literal text "None" both normalize to).
SHOULDER_TYPES = ("gravel", "concrete", "asphalt", "earth", "none")

# Sentinel used for owner_id on every "workspace" row instead of NULL. SQL
# UNIQUE/PRIMARY KEY constraints treat every NULL as distinct from every
# other NULL, so two workspace rows with the same section_id and owner_id=NULL
# would NOT violate uniqueness -- '' (never a real guest_id, which is always
# a hex token) makes the composite key actually enforce one section_id per
# scope. Scope.owner_id itself stays None at the API/app layer (app/scope.py
# translates between the two at the DB boundary).
WORKSPACE_OWNER_ID = ""


class Road(Base):
    """One DPWH road section (what the source file calls "Section ID")."""

    __tablename__ = "roads"

    # Composite primary key -- section_id is NOT globally unique on its own,
    # only unique within one scope. Without owner_type/owner_id in the key,
    # a guest uploading the same sample file as the shared workspace (an
    # entirely expected, common case) would collide on section_id and corrupt
    # or block each other's data instead of staying isolated.
    section_id = Column(String, primary_key=True)
    owner_type = Column(String, primary_key=True, default="workspace", server_default="workspace")
    owner_id = Column(String, primary_key=True, default=WORKSPACE_OWNER_ID, server_default=WORKSPACE_OWNER_ID)
    road_name = Column(String, nullable=False)
    # DPWH classification/office columns -- one value per section (validated
    # consistent across every row of a section at import time; a section
    # with 2+ distinct DEO or LD values is rejected rather than guessed at).
    classification = Column(String, nullable=True)
    deo = Column(String, nullable=True)
    ld = Column(String, nullable=True)
    updated_at = Column(String, nullable=False)
    uploaded_at = Column(String, nullable=True)
    source_file = Column(String, nullable=True)
    segment_count = Column(Integer, nullable=False, default=0)
    total_length_m = Column(Float, nullable=False, default=0)

    segments = relationship(
        "RoadSegment",
        back_populates="road",
        cascade="all, delete-orphan",
        order_by="RoadSegment.seq_no",
    )


class RoadSegment(Base):
    __tablename__ = "road_segments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    section_id = Column(String, nullable=False)
    owner_type = Column(String, nullable=False, default="workspace", server_default="workspace")
    owner_id = Column(String, nullable=False, default=WORKSPACE_OWNER_ID, server_default=WORKSPACE_OWNER_ID)
    seq_no = Column(Integer, nullable=False)
    # Original station text exactly as it appeared in the source file (e.g.
    # "K1259 + (-166)", "Chainage 105", "254") -- kept for display since the
    # parsed start_m/end_m lose the station's original notation.
    start_text = Column(String, nullable=False)
    end_text = Column(String, nullable=False)
    start_m = Column(Float, nullable=False)
    end_m = Column(Float, nullable=False)
    # end_m - start_m, except when that would be <= 0 (a bad km post in the
    # source data) -- then this is forced to 0 so totals aren't thrown off,
    # and irregular_km_post is set instead of rejecting the row.
    length_m = Column(Float, nullable=False)
    irregular_km_post = Column(Boolean, nullable=False, default=False)
    num_lanes = Column(Integer, nullable=False)
    surface_type = Column(String, nullable=False)
    shoulder_left = Column(String, nullable=False)
    shoulder_right = Column(String, nullable=False)
    source_row_number = Column(Integer, nullable=False)

    road = relationship("Road", back_populates="segments")

    __table_args__ = (
        ForeignKeyConstraint(
            ["section_id", "owner_type", "owner_id"],
            ["roads.section_id", "roads.owner_type", "roads.owner_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint("section_id", "owner_type", "owner_id", "seq_no", name="uq_section_seq"),
        CheckConstraint(f"surface_type IN {SURFACE_TYPES}", name="ck_surface_type"),
        CheckConstraint(f"shoulder_left IN {SHOULDER_TYPES}", name="ck_shoulder_left"),
        CheckConstraint(f"shoulder_right IN {SHOULDER_TYPES}", name="ck_shoulder_right"),
        Index("idx_segments_section_start", "section_id", "owner_type", "owner_id", "start_m"),
    )


class UploadLogEntry(Base):
    """One row per upload attempt or road deletion -- an audit trail kept in
    the same database as the road data it describes (not browser storage),
    so 'Write the log in the same transaction as the data save' is literally
    true, and the history is shared across whoever uses this office tool
    rather than stuck in one browser."""

    __tablename__ = "upload_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(String, nullable=False)
    kind = Column(String, nullable=False)  # "upload" | "delete" | "restore" | "edit"
    status = Column(String, nullable=False)  # "completed" | "cancelled" | "failed"
    file_name = Column(String, nullable=True)
    file_size = Column(Integer, nullable=True)
    total_rows = Column(Integer, nullable=True)
    error_message = Column(Text, nullable=True)
    added_count = Column(Integer, nullable=False, default=0)
    replaced_count = Column(Integer, nullable=False, default=0)
    kept_count = Column(Integer, nullable=False, default=0)
    up_to_date_count = Column(Integer, nullable=False, default=0)
    rejected_count = Column(Integer, nullable=False, default=0)
    deleted_count = Column(Integer, nullable=False, default=0)
    edited_count = Column(Integer, nullable=False, default=0)
    # JSON-encoded list of per-road detail dicts: section_id, road_name, action,
    # segment_count, change_summary, rejection_reasons. Kept as one blob
    # rather than a child table -- it's always read/written as a whole with
    # its parent entry, never queried independently.
    details_json = Column(Text, nullable=False, default="[]")
    # Same scoping as Road.owner_type/owner_id above -- a guest's own
    # upload-history entries, never visible to the shared workspace or to
    # other guests.
    owner_type = Column(String, nullable=False, default="workspace", server_default="workspace")
    owner_id = Column(String, nullable=False, default=WORKSPACE_OWNER_ID, server_default=WORKSPACE_OWNER_ID)
    # Who performed this action (Part 5). No FK constraint -- SQLite can't
    # add one via ALTER TABLE to an already-existing table, and this is an
    # audit trail, not a relation the app needs to join through. NULL here
    # means one of two things the UI tells apart via owner_type, not via
    # this column alone: owner_type='guest' -> "Guest" (no account to
    # attribute to); owner_type='workspace' -> "Unknown" (a workspace
    # action logged before this tracking existed). actor_name/email/
    # avatar_url are a snapshot of the user's profile AT THE TIME of the
    # action, not a live join to users -- so a later Google profile rename
    # doesn't rewrite history, and reading the log never needs a join.
    user_id = Column(Integer, nullable=True)
    actor_name = Column(String, nullable=True)
    actor_email = Column(String, nullable=True)
    actor_avatar_url = Column(String, nullable=True)


class User(Base):
    """A signed-in Google account."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    google_id = Column(String, nullable=False, unique=True)
    email = Column(String, nullable=False)
    name = Column(String, nullable=False)
    avatar_url = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    last_login_at = Column(String, nullable=False)


class GuestSession(Base):
    """One row per guest cookie. Tracks last_activity_at so the periodic
    cleanup job (app/scope.py) can find and delete guests idle past
    GUEST_DATA_TTL_MINUTES, along with whatever roads/segments/log entries
    they own."""

    __tablename__ = "guest_sessions"

    guest_id = Column(String, primary_key=True)
    created_at = Column(String, nullable=False)
    last_activity_at = Column(String, nullable=False)


class WorkspaceShare(Base):
    """Grants one other Google account Viewer/Editor access to a workspace
    owner's data (Google-Sheets-style sharing) -- the owner themselves needs
    no row here, they always have full access to their own owner_id.

    user_id starts NULL when the owner shares with an email that hasn't
    signed in yet (a "pending invite"): the row still exists and already
    carries the role, it just can't be matched to anyone's session until
    that email actually signs in, at which point app/routers/auth.py
    resolves every pending row for that email to the new user_id. Kept
    NULL rather than deleting-and-recreating the row on activation so the
    original invited_email/role/created_at survive unchanged.

    invited_email is stored lowercased (see app/scope.py's
    normalize_email) so matching a freshly-signed-in Google account's email
    is a plain equality check, not a per-query LOWER() call."""

    __tablename__ = "workspace_shares"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    invited_email = Column(String, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    role = Column(String, nullable=False)  # "viewer" | "editor"
    invited_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)
    # NULL = "new"/unseen by the recipient -- set the moment they switch into
    # this workspace, or explicitly mark the whole notification list seen
    # (closing the avatar dropdown). Reset to NULL (re-flagged as new) on a
    # role change, not just on first share -- last_change says which kind of
    # "new" it is, since the badge/dropdown/toast all read differently for
    # a brand-new share vs. an existing one's role changing.
    seen_at = Column(String, nullable=True)
    last_change = Column(String, nullable=True)  # "shared" | "role_changed" | NULL

    __table_args__ = (
        # One share row per (owner, invited email) -- re-sharing with the
        # same email updates this row's role instead of creating a second,
        # conflicting grant.
        UniqueConstraint("owner_user_id", "invited_email", name="uq_workspace_share_owner_email"),
        CheckConstraint("role IN ('viewer', 'editor')", name="ck_workspace_share_role"),
        CheckConstraint(
            "last_change IS NULL OR last_change IN ('shared', 'role_changed')", name="ck_workspace_share_last_change"
        ),
        Index("idx_workspace_shares_user_id", "user_id"),
        Index("idx_workspace_shares_owner", "owner_user_id"),
    )
