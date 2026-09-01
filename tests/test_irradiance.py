"""NSRDB irradiance fetch/convert — SAM-CSV parsing, both scalings, disk
cache, error mapping. No network: the HTTP layer is monkeypatched."""
import io
import json
import math
import urllib.error

import pytest

from opendss_designer.core import irradiance


def _psm4_csv() -> str:
    """Real SAM-CSV layout: metadata fields, metadata values, data header,
    8760 hourly rows with a solar-ish GHI curve peaking at 1000 W/m^2."""
    lines = [
        "Source,Location ID,City,State,Country,Latitude,Longitude,Time Zone,Elevation,GHI Units",
        "NSRDB,484607,-,-,-,39.73,-104.98,-7,1607,w/m2",
        "Year,Month,Day,Hour,Minute,GHI",
    ]
    for _day in range(365):
        for h in range(24):
            ghi = max(0.0, round(1000 * math.sin(math.pi * (h - 6) / 12), 1)) if 6 <= h <= 18 else 0.0
            lines.append(f"2018,1,1,{h},30,{ghi}")
    return "\n".join(lines) + "\n"


@pytest.fixture()
def patched(tmp_path, monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(url, timeout=0):
        calls["n"] += 1
        return io.BytesIO(_psm4_csv().encode())

    monkeypatch.setattr(irradiance, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(irradiance.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_kwm2_scaling_is_absolute(patched):
    r = irradiance.fetch_ghi(39.74, -104.99, "KEY", "user@site.com")
    assert r["kind"] == "irradiance"
    assert r["intervalMin"] == 60.0
    assert len(r["points"]) == 8760
    assert max(r["points"]) == pytest.approx(1.0)  # 1000 W/m2 / 1000
    assert r["points"][0] == 0.0  # midnight
    assert r["stats"]["peakWm2"] == pytest.approx(1000)
    assert r["stats"]["resolvedLat"] == pytest.approx(39.73)
    assert r["source"] == "nsrdb:39.7400,-104.9900/2018"


def test_peak_scaling_and_label_naming(patched):
    r = irradiance.fetch_ghi(39.74, -104.99, "KEY", "user@site.com",
                             scaling="peak", label="Denver CO")
    assert max(r["points"]) == pytest.approx(1.0)
    assert r["name"] == "ghi_denver_co"


def test_cache_hit_skips_fetch(patched):
    irradiance.fetch_ghi(39.74, -104.99, "KEY", "a@b.com")
    irradiance.fetch_ghi(39.74, -104.99, "OTHER_KEY", "c@d.com", scaling="peak")
    assert patched["n"] == 1  # cached by location, not by key/scaling


def test_bad_inputs_are_400(patched):
    with pytest.raises(irradiance.IrradianceError) as e:
        irradiance.fetch_ghi(95, 0, "KEY", "a@b.com")
    assert e.value.status == 400
    with pytest.raises(irradiance.IrradianceError):
        irradiance.fetch_ghi(39, -104, "  ", "a@b.com")


def test_rejected_key_maps_to_400(tmp_path, monkeypatch):
    def deny(url, timeout=0):
        raise urllib.error.HTTPError(
            url, 403, "Forbidden", None,
            io.BytesIO(json.dumps({"errors": ["API key not valid"]}).encode()))

    monkeypatch.setattr(irradiance, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(irradiance.urllib.request, "urlopen", deny)
    with pytest.raises(irradiance.IrradianceError) as e:
        irradiance.fetch_ghi(39.74, -104.99, "BAD", "a@b.com")
    assert e.value.status == 400
    assert "API key" in str(e.value)


def test_geocode_maps_results(monkeypatch):
    payload = {"results": [{"name": "Denver", "admin1": "Colorado",
                            "country_code": "US", "latitude": 39.74,
                            "longitude": -104.98}]}

    monkeypatch.setattr(
        irradiance.urllib.request, "urlopen",
        lambda url, timeout=0: io.BytesIO(json.dumps(payload).encode()))
    hits = irradiance.geocode("denver")
    assert hits == [{"name": "Denver", "region": "Colorado, US",
                     "lat": 39.74, "lon": -104.98}]
