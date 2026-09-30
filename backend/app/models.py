from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    String,
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
