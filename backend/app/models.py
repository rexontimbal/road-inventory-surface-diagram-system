from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.db import Base

SURFACE_TYPES = ("unpaved", "paved", "gravel", "asphalt")

# Sentinel used for owner_id on every "workspace" row instead of NULL. SQL
# UNIQUE/PRIMARY KEY constraints treat every NULL as distinct from every
# other NULL, so two workspace rows with the same road_id and owner_id=NULL
# would NOT violate uniqueness -- '' (never a real guest_id, which is always
# a hex token) makes the composite key actually enforce one road_id per
# scope. Scope.owner_id itself stays None at the API/app layer (app/scope.py
# translates between the two at the DB boundary).
WORKSPACE_OWNER_ID = ""


class Road(Base):
    __tablename__ = "roads"

    # Composite primary key -- road_id is NOT globally unique on its own,
    # only unique within one scope. Without owner_type/owner_id in the key,
    # a guest uploading the same sample file as the shared workspace (an
    # entirely expected, common case) would collide on road_id and corrupt
    # or block each other's data instead of staying isolated.
    road_id = Column(String, primary_key=True)
    owner_type = Column(String, primary_key=True, default="workspace", server_default="workspace")
    owner_id = Column(String, primary_key=True, default=WORKSPACE_OWNER_ID, server_default=WORKSPACE_OWNER_ID)
    road_name = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)
    uploaded_at = Column(String, nullable=True)
    source_file = Column(String, nullable=True)
    segment_count = Column(Integer, nullable=False, default=0)
    total_length_m = Column(Integer, nullable=False, default=0)

    segments = relationship(
        "RoadSegment",
        back_populates="road",
        cascade="all, delete-orphan",
        order_by="RoadSegment.seq_no",
    )


class RoadSegment(Base):
    __tablename__ = "road_segments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    road_id = Column(String, nullable=False)
    owner_type = Column(String, nullable=False, default="workspace", server_default="workspace")
    owner_id = Column(String, nullable=False, default=WORKSPACE_OWNER_ID, server_default=WORKSPACE_OWNER_ID)
    seq_no = Column(Integer, nullable=False)
    start_station_raw = Column(String, nullable=False)
    end_station_raw = Column(String, nullable=False)
    start_m = Column(Integer, nullable=False)
    end_m = Column(Integer, nullable=False)
    num_lanes = Column(Integer, nullable=False)
    surface_type = Column(String, nullable=False)
    shoulder_left = Column(String, nullable=False)
    shoulder_right = Column(String, nullable=False)
    source_row_number = Column(Integer, nullable=False)

    road = relationship("Road", back_populates="segments")

    __table_args__ = (
        ForeignKeyConstraint(
            ["road_id", "owner_type", "owner_id"],
            ["roads.road_id", "roads.owner_type", "roads.owner_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint("road_id", "owner_type", "owner_id", "seq_no", name="uq_road_seq"),
        CheckConstraint(f"surface_type IN {SURFACE_TYPES}", name="ck_surface_type"),
        CheckConstraint(f"shoulder_left IN {SURFACE_TYPES}", name="ck_shoulder_left"),
        CheckConstraint(f"shoulder_right IN {SURFACE_TYPES}", name="ck_shoulder_right"),
        Index("idx_segments_road_start", "road_id", "owner_type", "owner_id", "start_m"),
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
    # JSON-encoded list of per-road detail dicts: road_id, road_name, action,
    # segment_count, change_summary, rejection_reasons. Kept as one blob
    # rather than a child table -- it's always read/written as a whole with
    # its parent entry, never queried independently.
    details_json = Column(Text, nullable=False, default="[]")
    # Same scoping as Road.owner_type/owner_id above -- a guest's own
    # upload-history entries, never visible to the shared workspace or to
    # other guests.
    owner_type = Column(String, nullable=False, default="workspace", server_default="workspace")
    owner_id = Column(String, nullable=False, default=WORKSPACE_OWNER_ID, server_default=WORKSPACE_OWNER_ID)


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
