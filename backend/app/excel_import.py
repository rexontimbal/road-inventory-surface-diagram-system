import re
from dataclasses import dataclass, field
from io import BytesIO

import openpyxl

from app.chainage import ParsedRow, RowError, parse_chainage, validate_road_rows

# Maps normalized (lowercased, whitespace-collapsed) header text -> internal field name.
# Matches the confirmed two-row-header template: row 1 is decorative group labels
# (STATION / SHOULDER), row 2 holds these actual column names.
REQUIRED_COLUMNS = {
    "road id": "road_id",
    "road name": "road_name",
    "start": "start_station",
    "end": "end_station",
    "number of lanes": "num_lanes",
    "surface type": "surface_type",
    "left": "shoulder_left",
    "right": "shoulder_right",
}

HEADER_ROW = 2  # 1-based Excel row holding actual column names (row 1 is group labels)


class TemplateError(Exception):
    """Raised for file-level problems that abort the entire upload."""


def _normalize_header(name) -> str:
    return re.sub(r"\s+", " ", str(name if name is not None else "").strip().lower())


def _is_blank(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


@dataclass
class RoadImportPlan:
    road_id: str
    road_name: str
    segments: list[ParsedRow] = field(default_factory=list)

    @property
    def total_length_m(self) -> int:
        return max((s.end_m for s in self.segments), default=0)


@dataclass
class RoadRejection:
    road_id: str
    errors: list[RowError]


@dataclass
class ImportResult:
    accepted: list[RoadImportPlan]
    rejected: list[RoadRejection]
    total_rows_processed: int
    ignored_columns: list[str]


def parse_upload(file_bytes: bytes) -> ImportResult:
    try:
        wb = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True)
        ws = wb.worksheets[0]
    except Exception as exc:  # noqa: BLE001 - surfaced as a template error to the client
        raise TemplateError(f"Could not read Excel file: {exc}") from exc

    header_cells = next(ws.iter_rows(min_row=HEADER_ROW, max_row=HEADER_ROW))
    found_headers = [c.value for c in header_cells if c.value is not None]
    normalized_to_col_idx: dict[str, int] = {}
    for c in header_cells:
        if c.value is not None:
            normalized_to_col_idx[_normalize_header(c.value)] = c.column

    missing = [req for req in REQUIRED_COLUMNS if req not in normalized_to_col_idx]
    if missing:
        missing_display = [c.upper() if c in ("left", "right") else c.title() for c in missing]
        raise TemplateError(
            f"Missing required column(s): {', '.join(missing_display)}. "
            f"Columns found in file: {found_headers}"
        )

    col_idx = {
        field_name: normalized_to_col_idx[norm] for norm, field_name in REQUIRED_COLUMNS.items()
    }
    used_col_indices = set(col_idx.values())
    ignored_columns = [
        str(c.value) for c in header_cells if c.value is not None and c.column not in used_col_indices
    ]

    rows_by_road: dict[str, list[ParsedRow]] = {}
    errors_by_road: dict[str, list[RowError]] = {}
    total_rows = 0

    def cell(row_cells, field_name):
        return row_cells[col_idx[field_name] - 1].value

    for row_cells in ws.iter_rows(min_row=HEADER_ROW + 1):
        row_number = row_cells[0].row
        if all(c.value is None for c in row_cells):
            continue
        total_rows += 1

        road_id_val = cell(row_cells, "road_id")
        road_id = "" if _is_blank(road_id_val) else str(road_id_val).strip()
        if not road_id:
            errors_by_road.setdefault("(blank Road ID)", []).append(
                RowError(row_number, "ROAD ID", "Road ID is blank")
            )
            continue

        road_name_val = cell(row_cells, "road_name")
        road_name = "" if _is_blank(road_name_val) else str(road_name_val).strip()

        row_errors = errors_by_road.setdefault(road_id, [])

        start_raw = cell(row_cells, "start_station")
        end_raw = cell(row_cells, "end_station")
        try:
            start_m = parse_chainage(start_raw)
        except ValueError as exc:
            row_errors.append(RowError(row_number, "Start", str(exc)))
            continue
        try:
            end_m = parse_chainage(end_raw)
        except ValueError as exc:
            row_errors.append(RowError(row_number, "End", str(exc)))
            continue

        num_lanes_raw = cell(row_cells, "num_lanes")
        try:
            num_lanes = int(num_lanes_raw)
        except (TypeError, ValueError):
            row_errors.append(
                RowError(
                    row_number,
                    "Number of Lanes",
                    f"'{num_lanes_raw}' is not a valid integer",
                )
            )
            continue

        def _norm_surface(value) -> str:
            return "" if _is_blank(value) else str(value).strip().lower()

        parsed = ParsedRow(
            row_number=row_number,
            road_id=road_id,
            road_name=road_name,
            start_station_raw=str(start_raw).strip(),
            end_station_raw=str(end_raw).strip(),
            start_m=start_m,
            end_m=end_m,
            num_lanes=num_lanes,
            surface_type=_norm_surface(cell(row_cells, "surface_type")),
            shoulder_left=_norm_surface(cell(row_cells, "shoulder_left")),
            shoulder_right=_norm_surface(cell(row_cells, "shoulder_right")),
        )
        rows_by_road.setdefault(road_id, []).append(parsed)

    accepted: list[RoadImportPlan] = []
    rejected: list[RoadRejection] = []

    all_road_ids = set(rows_by_road) | set(errors_by_road)
    for road_id in all_road_ids:
        rows = rows_by_road.get(road_id, [])
        pre_errors = list(errors_by_road.get(road_id, []))
        validation_errors = validate_road_rows(rows) if rows else []
        all_errors = pre_errors + validation_errors

        if all_errors:
            rejected.append(RoadRejection(road_id=road_id, errors=all_errors))
            continue

        sorted_rows = sorted(rows, key=lambda r: r.start_m)
        road_name = next((r.road_name for r in sorted_rows if r.road_name), road_id)
        accepted.append(
            RoadImportPlan(road_id=road_id, road_name=road_name, segments=sorted_rows)
        )

    return ImportResult(
        accepted=accepted,
        rejected=rejected,
        total_rows_processed=total_rows,
        ignored_columns=ignored_columns,
    )
