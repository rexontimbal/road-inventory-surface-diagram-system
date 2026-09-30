import pytest

from app.chainage import ParsedRow, parse_chainage, validate_road_rows


def test_parse_chainage_valid():
    assert parse_chainage("0+000") == 0
    assert parse_chainage("5+000") == 5000
    assert parse_chainage("18+000") == 18000
    assert parse_chainage(" 15 + 500 ") == 15500


def test_parse_chainage_malformed():
    with pytest.raises(ValueError):
        parse_chainage("not-a-station")
    with pytest.raises(ValueError):
        parse_chainage("5-000")
    with pytest.raises(ValueError):
        parse_chainage("5+1000")  # meters part must be 0-999


def _row(row_number, start_m, end_m, **overrides):
    defaults = dict(
        row_number=row_number,
        road_id="SD00001",
        road_name="Maharlika highway",
        start_station_raw=f"{start_m}",
        end_station_raw=f"{end_m}",
        start_m=start_m,
        end_m=end_m,
        num_lanes=2,
        surface_type="paved",
        shoulder_left="paved",
        shoulder_right="paved",
    )
    defaults.update(overrides)
    return ParsedRow(**defaults)


def test_validate_contiguous_rows_no_errors():
    rows = [_row(3, 0, 5000), _row(4, 5000, 8000), _row(5, 8000, 10000)]
    assert validate_road_rows(rows) == []


def test_validate_detects_gap():
    rows = [_row(3, 0, 5000), _row(4, 6000, 8000)]
    errors = validate_road_rows(rows)
    assert any("Gap" in e.message for e in errors)


def test_validate_detects_overlap():
    rows = [_row(3, 0, 5000), _row(4, 4000, 8000)]
    errors = validate_road_rows(rows)
    assert any("overlaps" in e.message for e in errors)


def test_validate_detects_reversed_range_known_bad_sample_row():
    # Mirrors the real bad row in sample_road_inventory.xlsx: '18+000' -> '15+000'
    # (end station before start station).
    rows = [
        _row(9, 15000, 18000, start_station_raw="15+000", end_station_raw="18+000"),
        _row(10, 18000, 15000, start_station_raw="18+000", end_station_raw="15+000"),
        _row(11, 15000, 20000, start_station_raw="15+000", end_station_raw="20+000"),
    ]
    errors = validate_road_rows(rows)
    assert any(e.row == 10 and "must be after" in e.message for e in errors)


def test_validate_rejects_invalid_surface_type():
    rows = [_row(3, 0, 5000, surface_type="concrete")]
    errors = validate_road_rows(rows)
    assert any("Invalid surface type" in e.message for e in errors)


def test_validate_rejects_non_positive_lanes():
    rows = [_row(3, 0, 5000, num_lanes=0)]
    errors = validate_road_rows(rows)
    assert any("Number of Lanes" in e.message for e in errors)
