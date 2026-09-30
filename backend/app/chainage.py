import re
from dataclasses import dataclass

CHAINAGE_RE = re.compile(r"^\s*(\d+)\s*\+\s*(\d{1,3})\s*$")


def parse_chainage(raw) -> int:
    """Parse 'K+MMM' road chainage notation (e.g. '5+000') into total meters."""
    m = CHAINAGE_RE.match(str(raw))
    if not m:
        raise ValueError(f"Invalid station format '{raw}', expected 'K+MMM' e.g. '5+000'")
    km, meters = int(m.group(1)), int(m.group(2))
    if meters >= 1000:
        raise ValueError(f"Invalid station '{raw}': meter part must be 0-999")
    return km * 1000 + meters


@dataclass
class RowError:
    row: int
    field: str
    message: str


@dataclass
class ParsedRow:
    row_number: int
    road_id: str
    road_name: str
    start_station_raw: str
    end_station_raw: str
    start_m: int
    end_m: int
    num_lanes: int
    surface_type: str
    shoulder_left: str
    shoulder_right: str


SURFACE_TYPES = {"unpaved", "paved", "gravel", "asphalt"}


def validate_road_rows(rows: list[ParsedRow]) -> list[RowError]:
    """Given all already-parsed rows for a single Road ID, return every validation
    error found (does not stop at the first). Rows are sorted by start_m before
    the continuity/overlap/gap check runs -- file order is not trusted."""
    errors: list[RowError] = []

    for row in rows:
        if row.end_m <= row.start_m:
            errors.append(
                RowError(
                    row.row_number,
                    "End",
                    f"End station {row.end_station_raw} must be after start station "
                    f"{row.start_station_raw}",
                )
            )
        if row.surface_type not in SURFACE_TYPES:
            errors.append(
                RowError(
                    row.row_number,
                    "Surface type",
                    f"Invalid surface type '{row.surface_type}', must be one of "
                    f"{sorted(SURFACE_TYPES)}",
                )
            )
        if row.shoulder_left not in SURFACE_TYPES:
            errors.append(
                RowError(
                    row.row_number,
                    "LEFT",
                    f"Invalid shoulder surface type '{row.shoulder_left}', must be one of "
                    f"{sorted(SURFACE_TYPES)}",
                )
            )
        if row.shoulder_right not in SURFACE_TYPES:
            errors.append(
                RowError(
                    row.row_number,
                    "RIGHT",
                    f"Invalid shoulder surface type '{row.shoulder_right}', must be one of "
                    f"{sorted(SURFACE_TYPES)}",
                )
            )
        if row.num_lanes <= 0:
            errors.append(
                RowError(
                    row.row_number,
                    "Number of Lanes",
                    f"Number of Lanes must be a positive integer, got {row.num_lanes}",
                )
            )

    sorted_rows = sorted(rows, key=lambda r: r.start_m)
    for prev, curr in zip(sorted_rows, sorted_rows[1:]):
        if curr.start_m < prev.end_m:
            errors.append(
                RowError(
                    curr.row_number,
                    "Start",
                    f"Station {curr.start_station_raw} overlaps with previous segment "
                    f"ending at {prev.end_station_raw} (row {prev.row_number})",
                )
            )
        elif curr.start_m > prev.end_m:
            errors.append(
                RowError(
                    curr.row_number,
                    "Start",
                    f"Gap between previous segment ending at {prev.end_station_raw} "
                    f"(row {prev.row_number}) and this segment starting at "
                    f"{curr.start_station_raw}",
                )
            )

    return errors
