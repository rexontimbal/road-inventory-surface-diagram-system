from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.db import Base

SURFACE_TYPES = ("unpaved", "paved", "gravel", "asphalt")


class Road(Base):
    __tablename__ = "roads"

    road_id = Column(String, primary_key=True)
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
    road_id = Column(String, ForeignKey("roads.road_id", ondelete="CASCADE"), nullable=False)
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
        UniqueConstraint("road_id", "seq_no", name="uq_road_seq"),
        CheckConstraint(f"surface_type IN {SURFACE_TYPES}", name="ck_surface_type"),
        CheckConstraint(f"shoulder_left IN {SURFACE_TYPES}", name="ck_shoulder_left"),
        CheckConstraint(f"shoulder_right IN {SURFACE_TYPES}", name="ck_shoulder_right"),
        Index("idx_segments_road_start", "road_id", "start_m"),
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


class User(Base):
    """A signed-in Google account. Schema only for now -- nothing writes or
    reads this table until the auth endpoints (Part 2) exist."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    google_id = Column(String, nullable=False, unique=True)
    email = Column(String, nullable=False)
    name = Column(String, nullable=False)
    avatar_url = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    last_login_at = Column(String, nullable=False)


class GuestSession(Base):
    """One row per guest cookie. Tracks last_activity_at so a cleanup pass
    (Part 4) can find and delete guests idle past GUEST_DATA_TTL_MINUTES,
    along with whatever roads/segments/log entries they own -- schema only
    for now, nothing writes or reads this table until guest mode exists."""

    __tablename__ = "guest_sessions"

    guest_id = Column(String, primary_key=True)
    created_at = Column(String, nullable=False)
    last_activity_at = Column(String, nullable=False)
