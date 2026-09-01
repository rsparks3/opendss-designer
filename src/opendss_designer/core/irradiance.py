"""Regional solar irradiance via the NLR NSRDB (PSM v4).

Fetches hourly GHI for weather year 2018 — the same actual-meteorological
year the NREL/NLR End-Use Load Profiles were simulated against, so PV output
stays correlated with the building load shapes in yearly runs — from the
GOES Aggregated v4 endpoint and converts it into an irradiance LoadShapeSpec.

Users need a free NLR Developer Network API key (https://developer.nlr.gov/);
the key and email are supplied per request from the UI, never stored here.
Raw CSVs are cached on disk keyed by rounded coordinates (the response
depends only on location/year, not on whose key fetched it).

Place-name search is proxied to the free Open-Meteo geocoder (no key).
"""
from __future__ import annotations

import csv
import io
import json
import urllib.error
import urllib.parse
import urllib.request

from ..settings import settings
from . import cache

# Same weather year as the EULP building-stock load shapes.
WEATHER_YEAR = 2018

NSRDB_URL = ("https://developer.nlr.gov/api/nsrdb/v2/solar/"
             "nsrdb-GOES-aggregated-v4-0-0-download.csv")
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"

CACHE_DIR = settings.effective_cache_dir / "nsrdb_cache"


class IrradianceError(Exception):
    """User-facing failure (bad key/selection or upstream problem)."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def geocode(query: str) -> list[dict]:
    """Place-name search -> candidate locations (name, region, lat, lon)."""
    params = urllib.parse.urlencode({"name": query, "count": 6})
    try:
        with urllib.request.urlopen(f"{GEOCODE_URL}?{params}", timeout=30) as r:
            payload = json.load(r)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise IrradianceError(
            f"Place search failed (network problem?): {exc}") from exc
    return [
        {
            "name": hit.get("name", ""),
            "region": ", ".join(x for x in (hit.get("admin1"), hit.get("country_code")) if x),
            "lat": hit.get("latitude"),
            "lon": hit.get("longitude"),
        }
        for hit in payload.get("results", [])
        if hit.get("latitude") is not None
    ]


def _nsrdb_csv(lat: float, lon: float, api_key: str, email: str) -> str:
    """Raw PSM4 CSV for the location (disk cache keyed by rounded coords)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"ghi_{lat:.3f}_{lon:.3f}_{WEATHER_YEAR}.csv"
    if cache_file.exists():
        return cache_file.read_text(encoding="utf-8")

    params = urllib.parse.urlencode({
        "api_key": api_key, "email": email,
        "wkt": f"POINT({lon:.4f} {lat:.4f})", "names": str(WEATHER_YEAR),
        "attributes": "ghi", "interval": "60",
        "utc": "false", "leap_day": "false",
    })
    try:
        with urllib.request.urlopen(f"{NSRDB_URL}?{params}", timeout=180) as r:
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = "; ".join(json.load(exc).get("errors", []))
        except Exception:
            pass
        if exc.code in (401, 403):
            raise IrradianceError(
                f"NSRDB rejected the API key: {detail or exc}. Get a free key "
                "at https://developer.nlr.gov/signup/.", status=400) from exc
        if exc.code == 429:
            raise IrradianceError(
                "NSRDB rate limit hit — wait a moment and retry "
                f"({detail or exc}).", status=429) from exc
        raise IrradianceError(
            f"NSRDB request failed (HTTP {exc.code}): {detail or exc}. The "
            "location may be outside NSRDB coverage (the Americas).",
            status=400 if exc.code == 400 else 502) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise IrradianceError(f"Could not reach the NSRDB (network problem?): {exc}") from exc

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache.write_atomic(cache_file, text)
    cache.sweep(CACHE_DIR, settings.nsrdb_cache_bytes)
    return text


def _parse_ghi(text: str) -> tuple[list[float], dict]:
    """SAM-CSV layout: metadata field names, metadata values, data header
    (Year,Month,Day,Hour,Minute,GHI), then 8760 hourly rows."""
    buf = io.StringIO(text)
    meta_fields = next(csv.reader([buf.readline()]), [])
    meta_values = next(csv.reader([buf.readline()]), [])
    meta = dict(zip(meta_fields, meta_values, strict=False))
    reader = csv.DictReader(buf)
    if not reader.fieldnames or "GHI" not in reader.fieldnames:
        raise IrradianceError("Unexpected NSRDB response layout (no GHI column).")
    ghi: list[float] = []
    for row in reader:
        try:
            ghi.append(float(row["GHI"] or 0))
        except (TypeError, ValueError):
            continue
    if len(ghi) < 8760:
        raise IrradianceError(
            f"Unexpected NSRDB response: only {len(ghi)} hourly rows.")
    return ghi, meta


def fetch_ghi(lat: float, lon: float, api_key: str, email: str,
              scaling: str = "kwm2", label: str | None = None) -> dict:
    """Fetch + convert one location's hourly GHI into an irradiance shape."""
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise IrradianceError("Latitude/longitude out of range.", status=400)
    if not api_key.strip():
        raise IrradianceError("An NLR API key is required — get a free one at "
                              "https://developer.nlr.gov/signup/.", status=400)
    if scaling not in ("kwm2", "peak"):
        raise IrradianceError("scaling must be 'kwm2' or 'peak'.", status=400)

    ghi, meta = _parse_ghi(_nsrdb_csv(lat, lon, api_key.strip(), email.strip()))

    peak_wm2 = max(ghi)
    divisor = 1000.0 if scaling == "kwm2" else (peak_wm2 or 1.0)
    points = [round(v / divisor, 5) for v in ghi]

    slug = "".join(c if c.isalnum() else "_" for c in (label or "").lower()).strip("_")
    name = f"ghi_{slug}" if slug else f"ghi_{lat:.2f}_{lon:.2f}".replace("-", "m").replace(".", "p")
    return {
        "name": name,
        "kind": "irradiance",
        "intervalMin": 60.0,
        "points": points,
        "source": f"nsrdb:{lat:.4f},{lon:.4f}/{WEATHER_YEAR}",
        "stats": {
            "peakWm2": round(peak_wm2, 0),
            "annualKwhM2": round(sum(ghi) / 1000.0, 1),
            # Grid-cell coordinates the NSRDB actually resolved to.
            "resolvedLat": float(meta.get("Latitude", lat) or lat),
            "resolvedLon": float(meta.get("Longitude", lon) or lon),
            "points": len(points),
        },
    }
