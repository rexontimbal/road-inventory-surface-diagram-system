import re
from dataclasses import dataclass

from app.models import SHOULDER_TYPES, SURFACE_TYPES

# DPWH "K<km post> + <offset>" station notation, e.g. "K1259+881",
# "K1259 + (-166)" (negative offset), "K1261 + 1009" (offset >= 1000, meaning
# the next km post's marker hasn't been planted yet), "K1379 + 224.78"
# (decimal offset). The offset may be wrapped in parentheses only to carry a
# leading minus sign -- "(-166)" -- never for a positive value.
K_STATION_RE = re.compile(r"^[Kk]\s*(\d+)\s*\+\s*\(?(-?\d+(?:\.\d+)?)\)?\s*$")

# A handful of sections measure chainage in plain meters with the word
# "Chainage" in front instead of the usual "K+offset" notation, e.g.
# "Chainage 105" -> 105 meters (not 105 * 1000).
CHAINAGE_RE = re.compile(r"chainage\s*(\d+(?:\.\d+)?)", re.IGNORECASE)


@dataclass
class ParsedStation:
    position_m: float
    display_text: str


def _format_plain_number(raw) -> str:
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float) and raw.is_integer():
        return str(int(raw))
    return str(raw)


def parse_station(raw) -> ParsedStation:
    """Parse a DPWH station cell into (position in meters, original display
    text). Accepts every variant seen in the real data: 'K+offset' notation
    (with negative/decimal/>=1000 offsets), 'Chainage N' text, and plain
    numeric cells (meters already) -- see chainage.py module docstring-level
    comments above each pattern for examples."""
    if raw is None:
        raise ValueError("Station value is blank")

    if isinstance(raw, (int, float)):
        return ParsedStation(position_m=float(raw), display_text=_format_plain_number(raw))

    text = str(raw).strip()
    if not text:
        raise ValueError("Station value is blank")

    chainage_match = CHAINAGE_RE.search(text)
    if chainage_match:
        return ParsedStation(position_m=float(chainage_match.group(1)), display_text=text)

    k_match = K_STATION_RE.match(text)
    if k_match:
        km_post = int(k_match.group(1))
        offset = float(k_match.group(2))
        return ParsedStation(position_m=km_post * 1000 + offset, display_text=text)

    # Plain numeric text (a meters value typed as text rather than a numeric cell).
    try:
        value = float(text)
    except ValueError as exc:
        raise ValueError(
            f"Invalid station format '{raw}', expected 'K<post>+<offset>' e.g. 'K1259+881', "
            f"'Chainage <n>', or a plain number of meters"
        ) from exc
    return ParsedStation(position_m=value, display_text=text)


@dataclass
class RowError:
    row: int
    field: str
    message: str


#: Warning kinds, for grouping by type in the UI ("51 irregular km post ·
#: 184 gaps/overlaps · 1 blank shoulder") instead of showing one line per row.
WARNING_KIND_IRREGULAR_KM_POST = "irregular_km_post"
WARNING_KIND_GAP = "gap"
WARNING_KIND_OVERLAP = "overlap"
WARNING_KIND_BLANK_SHOULDER = "blank_shoulder"


@dataclass
class RowWarning:
    row: int
    field: str
    message: str
    kind: str


# Gap and overlap warnings share one summary bucket ("gaps/overlaps") since
# they're the same underlying issue (a section's segments aren't perfectly
# contiguous) -- the per-row `kind` stays distinct so a detail view could
# still tell them apart if needed.
_WARNING_BUCKETS = {
    WARNING_KIND_IRREGULAR_KM_POST: ("irregular_km_post", "irregular km post"),
    WARNING_KIND_GAP: ("gap_overlap", "gaps/overlaps"),
    WARNING_KIND_OVERLAP: ("gap_overlap", "gaps/overlaps"),
    WARNING_KIND_BLANK_SHOULDER: ("blank_shoulder", "blank shoulder"),
}


def summarize_warnings(warnings: list[RowWarning]) -> list[dict]:
    """Groups a flat list of RowWarnings into [{kind, label, count}, ...],
    e.g. for "51 irregular km post · 184 gaps/overlaps · 1 blank shoulder" --
    so the UI shows one summary instead of one line per row."""
    counts: dict[str, int] = {}
    labels: dict[str, str] = {}
    order: list[str] = []
    for w in warnings:
        bucket_kind, label = _WARNING_BUCKETS.get(w.kind, (w.kind, w.kind))
        if bucket_kind not in counts:
            order.append(bucket_kind)
        counts[bucket_kind] = counts.get(bucket_kind, 0) + 1
        labels[bucket_kind] = label
    return [{"kind": k, "label": labels[k], "count": counts[k]} for k in order]


@dataclass
class ParsedRow:
    row_number: int
    section_id: str
    road_name: str
    classification: str
    deo: str
    ld: str
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
    # True only when the source cell was truly empty -- the literal text
    # "None" is a valid DPWH value (explicitly "no shoulder") and must NOT
    # warn, even though both normalize to the stored value "none".
    shoulder_left_was_blank: bool = False
    shoulder_right_was_blank: bool = False


def make_row(
    *,
    row_number: int,
    section_id: str,
    road_name: str,
    classification: str,
    deo: str,
    ld: str,
    start: ParsedStation,
    end: ParsedStation,
    num_lanes: int,
    surface_type: str,
    shoulder_left: str,
    shoulder_right: str,
    shoulder_left_was_blank: bool = False,
    shoulder_right_was_blank: bool = False,
) -> ParsedRow:
    """Builds a ParsedRow from already-parsed start/end stations, computing
    length_m and irregular_km_post. A non-positive length (end at or before
    start -- a bad km post in the source data) is not rejected: it's flagged
    and its length is zeroed so it doesn't corrupt total-length sums."""
    raw_length = end.position_m - start.position_m
    irregular = raw_length <= 0
    return ParsedRow(
        row_number=row_number,
        section_id=section_id,
        road_name=road_name,
        classification=classification,
        deo=deo,
        ld=ld,
        start_text=start.display_text,
        end_text=end.display_text,
        start_m=start.position_m,
        end_m=end.position_m,
        length_m=0.0 if irregular else raw_length,
        irregular_km_post=irregular,
        num_lanes=num_lanes,
        surface_type=surface_type,
        shoulder_left=shoulder_left,
        shoulder_right=shoulder_right,
        shoulder_left_was_blank=shoulder_left_was_blank,
        shoulder_right_was_blank=shoulder_right_was_blank,
    )


def validate_section_rows(rows: list[ParsedRow]) -> tuple[list[RowError], list[RowWarning]]:
    """Given all already-parsed rows for a single Section ID, returns
    (errors, warnings). Errors mean the whole section is rejected; warnings
    mean it imports anyway. Rows are sorted by start_m before the
    gap/overlap check runs -- file order is not trusted."""
    errors: list[RowError] = []
    warnings: list[RowWarning] = []

    for row in rows:
        if row.surface_type not in SURFACE_TYPES:
            errors.append(
                RowError(
                    row.row_number,
                    "Surface type",
                    f"Invalid surface type '{row.surface_type}', must be one of {sorted(SURFACE_TYPES)}",
                )
            )
        if row.shoulder_left not in SHOULDER_TYPES:
            errors.append(
                RowError(
                    row.row_number,
                    "LEFT",
                    f"Invalid shoulder surface type '{row.shoulder_left}', must be one of {sorted(SHOULDER_TYPES)}",
                )
            )
        if row.shoulder_right not in SHOULDER_TYPES:
            errors.append(
                RowError(
                    row.row_number,
                    "RIGHT",
                    f"Invalid shoulder surface type '{row.shoulder_right}', must be one of {sorted(SHOULDER_TYPES)}",
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
        if row.irregular_km_post:
            warnings.append(
                RowWarning(
                    row.row_number,
                    "Start/End",
                    f"Irregular km post: end station {row.end_text} is not after start station {row.start_text}",
                    kind=WARNING_KIND_IRREGULAR_KM_POST,
                )
            )
        # Only a truly empty cell warns -- the literal text "None" is a valid
        # DPWH value (explicitly "no shoulder"), not missing data.
        if row.shoulder_left_was_blank:
            warnings.append(
                RowWarning(row.row_number, "LEFT", "Blank left shoulder, treated as None", kind=WARNING_KIND_BLANK_SHOULDER)
            )
        if row.shoulder_right_was_blank:
            warnings.append(
                RowWarning(row.row_number, "RIGHT", "Blank right shoulder, treated as None", kind=WARNING_KIND_BLANK_SHOULDER)
            )

    deo_values = {r.deo for r in rows if r.deo}
    if len(deo_values) > 1:
        errors.append(
            RowError(
                rows[0].row_number,
                "DEO",
                f"Section has multiple District Engineering Offices: {sorted(deo_values)}",
            )
        )
    ld_values = {r.ld for r in rows if r.ld}
    if len(ld_values) > 1:
        errors.append(
            RowError(
                rows[0].row_number,
                "LD",
                f"Section has multiple Legislative Districts: {sorted(ld_values)}",
            )
        )

    sorted_rows = sorted(rows, key=lambda r: r.start_m)
    for prev, curr in zip(sorted_rows, sorted_rows[1:]):
        if curr.start_m < prev.end_m:
            warnings.append(
                RowWarning(
                    curr.row_number,
                    "Start",
                    f"Station {curr.start_text} overlaps with previous segment ending at "
                    f"{prev.end_text} (row {prev.row_number})",
                    kind=WARNING_KIND_OVERLAP,
                )
            )
        elif curr.start_m > prev.end_m:
            warnings.append(
                RowWarning(
                    curr.row_number,
                    "Start",
                    f"Gap between previous segment ending at {prev.end_text} (row {prev.row_number}) "
                    f"and this segment starting at {curr.start_text}",
                    kind=WARNING_KIND_GAP,
                )
            )

    return errors, warnings
