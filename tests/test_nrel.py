"""NREL EULP fetch/convert logic — CSV parsing, downsampling, normalization,
disk cache. No test touches the network: the download step is monkeypatched."""
import pytest

from opendss_designer.core import nrel

DAYS = 2
ROWS = DAYS * 96  # 15-min rows


def _fixture_csv() -> str:
    """Real column layout (abridged): total column present plus end uses that
    must be ignored when the total exists."""
    header = ("in.ashrae_iecc_climate_zone_2004,in.geometry_building_type_recs,"
              "timestamp,models_used,units_represented,"
              "out.electricity.cooling.energy_consumption,"
              "out.electricity.total.energy_consumption,"
              "out.natural_gas.total.energy_consumption")
    lines = [header]
    for i in range(ROWS):
        # Total ramps 1..ROWS so sums/peaks are easy to reason about.
        total = float(i + 1)
        lines.append(f"3A,single-family_detached,2018-01-01,10,100,999,{total},888")
    return "\n".join(lines) + "\n"


@pytest.fixture()
def patched(tmp_path, monkeypatch):
    downloads = {"n": 0}

    def fake_download(url: str, dest) -> None:
        downloads["n"] += 1
        dest.write_text(_fixture_csv(), encoding="utf-8")

    monkeypatch.setattr(nrel, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(nrel, "_download", fake_download)
    return downloads


def test_hourly_downsample_sums_energy(patched):
    r = nrel.fetch_profile("resstock", "3A", "single-family_detached")
    assert r["intervalMin"] == 60.0
    assert len(r["points"]) == DAYS * 24
    # First hour = rows 1+2+3+4 = 10 kWh; peak hour = last 4 rows.
    peak_hour_kwh = sum(range(ROWS - 3, ROWS + 1))
    assert r["points"][0] == pytest.approx(10 / peak_hour_kwh, abs=1e-5)
    assert max(r["points"]) == pytest.approx(1.0)
    assert r["stats"]["annualKwh"] == pytest.approx(ROWS * (ROWS + 1) / 2)
    assert r["stats"]["peakKw"] == pytest.approx(peak_hour_kwh, rel=1e-3)
    assert r["name"] == "nrel_3a_single_family_detached"
    assert r["source"] == "nrel:resstock/3a/single-family_detached"


def test_native_15min_keeps_all_rows(patched):
    r = nrel.fetch_profile("resstock", "3a", "single-family_detached", step_min=15)
    assert r["intervalMin"] == 15.0
    assert len(r["points"]) == ROWS
    assert max(r["points"]) == pytest.approx(1.0)  # peak-normalized
    # kWh-per-15min converts to kW with a x4 factor.
    assert r["stats"]["peakKw"] == pytest.approx(ROWS * 4, rel=1e-3)


def test_average_normalization(patched):
    r = nrel.fetch_profile("resstock", "3a", "single-family_detached",
                           normalize="average")
    mean = sum(r["points"]) / len(r["points"])
    assert mean == pytest.approx(1.0, rel=1e-3)


def test_cache_hit_skips_download(patched):
    nrel.fetch_profile("resstock", "3a", "single-family_detached")
    nrel.fetch_profile("resstock", "3a", "single-family_detached", step_min=15)
    assert patched["n"] == 1  # same raw CSV serves both resolutions


def test_bad_selection_is_400(patched):
    with pytest.raises(nrel.NrelError) as e:
        nrel.fetch_profile("resstock", "9z", "single-family_detached")
    assert e.value.status == 400
    with pytest.raises(nrel.NrelError):
        nrel.fetch_profile("comstock", "3a", "single-family_detached")


def test_total_column_fallback(tmp_path, monkeypatch):
    """Without the total column, electricity end uses are summed."""
    header = ("timestamp,out.electricity.cooling.energy_consumption,"
              "out.electricity.heating.energy_consumption,"
              "out.natural_gas.total.energy_consumption")
    rows = "\n".join(f"t,{i},{i},50" for i in range(1, 97))
    monkeypatch.setattr(nrel, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        nrel, "_download",
        lambda url, dest: dest.write_text(header + "\n" + rows, encoding="utf-8"))
    r = nrel.fetch_profile("resstock", "3a", "single-family_detached", step_min=15)
    # cooling+heating summed, gas ignored; ramp 2..192 normalized by 192.
    assert r["points"][0] == pytest.approx(2 / 192, abs=1e-5)
    assert r["points"][-1] == pytest.approx(1.0)
