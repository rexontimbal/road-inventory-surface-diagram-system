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


class UploadResult(BaseModel):
    imported: list[RoadImportedOut]
    rejected: list[RoadRejectionOut]
    total_rows_processed: int
    ignored_columns: list[str]


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
