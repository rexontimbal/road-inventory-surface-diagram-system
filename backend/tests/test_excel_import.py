from pathlib import Path

import pytest

from app.excel_import import TemplateError, parse_upload

SAMPLE_XLSX = (
    Path(__file__).resolve().parent.parent.parent / "sample_road_inventory.xlsx"
)


@pytest.fixture()
def sample_bytes():
    return SAMPLE_XLSX.read_bytes()


def test_sample_file_parses_with_required_columns(sample_bytes):
    result = parse_upload(sample_bytes)
    # File has 24 data rows total (SD00001: 14 rows, SD00002: 10 rows).
    assert result.total_rows_processed == 24


def test_sample_file_rejects_road_with_reversed_station(sample_bytes):
    result = parse_upload(sample_bytes)
    rejected_ids = {r.road_id for r in result.rejected}
    assert "SD00001" in rejected_ids

    sd1 = next(r for r in result.rejected if r.road_id == "SD00001")
    assert any("must be after" in e.message for e in sd1.errors)


def test_sample_file_accepts_the_clean_road(sample_bytes):
    result = parse_upload(sample_bytes)
    accepted_ids = {p.road_id for p in result.accepted}
    assert "SD00002" in accepted_ids

    sd2 = next(p for p in result.accepted if p.road_id == "SD00002")
    assert sd2.road_name == "Surigao-Davao Coastal Road"
    assert sd2.segments[0].start_m == 0
    assert sd2.total_length_m == 30000
    # segments must come out sorted by start_m
    starts = [s.start_m for s in sd2.segments]
    assert starts == sorted(starts)


def test_missing_required_column_raises_template_error(sample_bytes, tmp_path):
    import openpyxl

    wb = openpyxl.load_workbook(pd_bytes_to_path(sample_bytes, tmp_path))
    ws = wb.active
    ws.cell(row=2, column=7).value = "Something Else"  # was 'LEFT'
    out_path = tmp_path / "broken.xlsx"
    wb.save(out_path)

    with pytest.raises(TemplateError, match="Missing required column"):
        parse_upload(out_path.read_bytes())


def pd_bytes_to_path(data: bytes, tmp_path) -> Path:
    p = tmp_path / "orig.xlsx"
    p.write_bytes(data)
    return p
