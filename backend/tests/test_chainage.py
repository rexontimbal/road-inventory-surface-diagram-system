import pytest

from app.chainage import make_row, parse_station, validate_section_rows


def test_parse_station_k_plus_mmm_compact():
    s = parse_station("K1259+881")
    assert s.position_m == 1259881
    assert s.display_text == "K1259+881"


def test_parse_station_k_plus_mmm_spaced():
    s = parse_station("K1259 + 881")
    assert s.position_m == 1259881


def test_parse_station_negative_offset():
    s = parse_station("K1259 + (-166)")
    assert s.position_m == 1259000 - 166


def test_parse_station_offset_over_1000():
    s = parse_station("K1261 + 1009")
    assert s.position_m == 1261000 + 1009


def test_parse_station_decimal_offset():
    s = parse_station("K1379 + 224.78")
    assert s.position_m == pytest.approx(1379224.78)


def test_parse_station_plain_int_cell():
    s = parse_station(254)
    assert s.position_m == 254
    assert s.display_text == "254"


def test_parse_station_plain_text_number():
    s = parse_station("254")
    assert s.position_m == 254


def test_parse_station_zero():
    s = parse_station(0)
    assert s.position_m == 0
    assert s.display_text == "0"


def test_parse_station_chainage_text():
    s = parse_station("Chainage 105")
    assert s.position_m == 105
    assert s.display_text == "Chainage 105"


def test_parse_station_unparseable():
    with pytest.raises(ValueError):
        parse_station("not-a-station")


def test_parse_station_blank():
    with pytest.raises(ValueError):
        parse_station(None)
    with pytest.raises(ValueError):
        parse_station("   ")


def _row(row_number, start_raw, end_raw, **overrides):
    defaults = dict(
        row_number=row_number,
        section_id="S001",
        road_name="Test Road",
        classification="Tertiary",
        deo="Test DEO",
        ld="Test LD",
        start=parse_station(start_raw),
        end=parse_station(end_raw),
        num_lanes=2,
        surface_type="concrete",
        shoulder_left="gravel",
        shoulder_right="gravel",
    )
    defaults.update(overrides)
    return make_row(**defaults)


def test_make_row_computes_length_and_irregular_flag():
    row = _row(3, "K1+000", "K1+500")
    assert row.length_m == 500
    assert row.irregular_km_post is False


def test_make_row_flags_irregular_when_end_before_start():
    row = _row(3, "K1+500", "K1+300")
    assert row.length_m == 0
    assert row.irregular_km_post is True


def test_validate_contiguous_rows_no_errors_no_warnings():
    rows = [_row(3, "K0+000", "K5+000"), _row(4, "K5+000", "K8+000")]
    errors, warnings = validate_section_rows(rows)
    assert errors == []
    assert warnings == []


def test_validate_detects_gap_as_warning_not_error():
    rows = [_row(3, "K0+000", "K5+000"), _row(4, "K6+000", "K8+000")]
    errors, warnings = validate_section_rows(rows)
    assert errors == []
    assert any("Gap" in w.message for w in warnings)


def test_validate_detects_overlap_as_warning_not_error():
    rows = [_row(3, "K0+000", "K5+000"), _row(4, "K4+000", "K8+000")]
    errors, warnings = validate_section_rows(rows)
    assert errors == []
    assert any("overlaps" in w.message for w in warnings)


def test_validate_irregular_km_post_is_a_warning_not_error():
    rows = [_row(9, "K18+000", "K15+000")]
    errors, warnings = validate_section_rows(rows)
    assert errors == []
    assert any(w.row == 9 and "Irregular km post" in w.message for w in warnings)
    assert rows[0].length_m == 0


def test_validate_rejects_invalid_surface_type():
    rows = [_row(3, "K0+000", "K5+000", surface_type="dirt")]
    errors, _ = validate_section_rows(rows)
    assert any("Invalid surface type" in e.message for e in errors)


def test_validate_rejects_invalid_shoulder_type():
    rows = [_row(3, "K0+000", "K5+000", shoulder_left="dirt")]
    errors, _ = validate_section_rows(rows)
    assert any("Invalid shoulder surface type" in e.message for e in errors)


def test_validate_rejects_non_positive_lanes():
    rows = [_row(3, "K0+000", "K5+000", num_lanes=0)]
    errors, _ = validate_section_rows(rows)
    assert any("Number of Lanes" in e.message for e in errors)


def test_validate_blank_shoulder_is_a_warning():
    rows = [_row(3, "K0+000", "K5+000", shoulder_left="none", shoulder_left_was_blank=True)]
    errors, warnings = validate_section_rows(rows)
    assert errors == []
    assert any("Blank left shoulder" in w.message for w in warnings)


def test_validate_literal_none_shoulder_is_not_a_warning():
    # The literal text "None" is a valid DPWH value (explicitly "no
    # shoulder") -- only a truly empty cell should warn.
    rows = [_row(3, "K0+000", "K5+000", shoulder_left="none", shoulder_left_was_blank=False)]
    errors, warnings = validate_section_rows(rows)
    assert errors == []
    assert warnings == []


def test_validate_rejects_section_with_multiple_deo():
    rows = [
        _row(3, "K0+000", "K5+000", deo="DEO A"),
        _row(4, "K5+000", "K8+000", deo="DEO B"),
    ]
    errors, _ = validate_section_rows(rows)
    assert any("multiple District Engineering Offices" in e.message for e in errors)


def test_validate_rejects_section_with_multiple_ld():
    rows = [
        _row(3, "K0+000", "K5+000", ld="LD A"),
        _row(4, "K5+000", "K8+000", ld="LD B"),
    ]
    errors, _ = validate_section_rows(rows)
    assert any("multiple Legislative Districts" in e.message for e in errors)
