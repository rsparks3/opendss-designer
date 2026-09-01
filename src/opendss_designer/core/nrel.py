"""NREL End-Use Load Profiles (EULP) for the U.S. Building Stock.

Fetches the public 2021 amy2018_release_1 aggregate profiles (15-minute kWh
for a full year, by ASHRAE/IECC climate zone x building type) from the OEDI
S3 data lake — no auth required — and converts them into LoadShapeSpec
multiplier curves. Raw CSVs (~10-30 MB) are cached on disk; the files are
static, so a cache hit never re-downloads.

Dataset: https://data.openei.org/submissions/4520
"""
from __future__ import annotations

import csv
import urllib.error
import urllib.request
from pathlib import Path

from ..settings import settings
from . import cache
from .connectivity import sanitize_name

BASE_URL = ("https://oedi-data-lake.s3.amazonaws.com/nrel-pds-building-stock/"
            "end-use-load-profiles-for-us-building-stock/2021/"
            "{product}_amy2018_release_1/timeseries_aggregates/"
            "by_ashrae_iecc_climate_zone_2004/{zone}-{building_type}.csv")

TOTAL_COLUMN = "out.electricity.total.energy_consumption"

# Zone and type lists verified against the live S3 listings (2026-08-30).
PRODUCTS: dict[str, dict] = {
    "resstock": {
        "label": "Residential",
        "zones": ["1a", "2a", "2b", "3a", "3b", "3c", "4a", "4b", "4c",
                  "5a", "5b", "6a", "6b", "7a", "7b"],
        "buildingTypes": ["mobile_home", "multi-family_with_2_-_4_units",
                          "multi-family_with_5plus_units",
                          "single-family_attached", "single-family_detached"],
    },
    "comstock": {
        "label": "Commercial",
        "zones": ["1a", "2a", "2b", "3a", "3b", "3c", "4a", "4b", "4c",
                  "5a", "5b", "6a", "6b", "7", "7a", "7b", "8"],
        "buildingTypes": ["fullservicerestaurant", "hospital", "largehotel",
                          "largeoffice", "mediumoffice", "outpatient",
                          "primaryschool", "quickservicerestaurant",
                          "retailstandalone", "retailstripmall",
                          "secondaryschool", "smallhotel", "smalloffice",
                          "warehouse"],
    },
}

# Public, static files keyed only by what was requested, so a deployment
# can point every session at one shared volume instead of re-downloading
# 10-30 MB per visitor (settings.cache_dir).
CACHE_DIR = settings.effective_cache_dir / "nrel_cache"


class NrelError(Exception):
    """User-facing failure (bad selection or upstream fetch problem)."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _download(url: str, dest: Path) -> None:
    """Fetch to a temp file then rename, so a failed download never leaves a
    truncated file in the cache."""
    tmp = dest.with_suffix(".part")
    req = urllib.request.Request(url, headers={"User-Agent": "opendss-designer"})
    limit = settings.max_outbound_bytes
    written = 0
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
        while chunk := resp.read(1 << 20):
            written += len(chunk)
            if limit and written > limit:
                f.close()
                tmp.unlink(missing_ok=True)
                raise NrelError(
                    "That dataset file is larger than this deployment allows.")
            f.write(chunk)
    tmp.replace(dest)


def _fetch_csv(product: str, zone: str, building_type: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / f"{product}_{zone}_{sanitize_name(building_type)}.csv"
    if dest.exists():
        return dest
    url = BASE_URL.format(product=product, zone=zone, building_type=building_type)
    try:
        _download(url, dest)
    except urllib.error.HTTPError as exc:
        raise NrelError(f"NREL dataset returned HTTP {exc.code} for "
                        f"{zone}-{building_type} — the file may not exist "
                        "for this zone/type combination.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise NrelError("Could not reach the NREL dataset (network problem?): "
                        f"{exc}") from exc
    cache.sweep(CACHE_DIR, settings.nrel_cache_bytes)
    return dest


def _read_kwh_series(path: Path) -> list[float]:
    """Total-electricity kWh per 15-minute interval, in file (time) order."""
    values: list[float] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []
        if TOTAL_COLUMN in fields:
            cols = [TOTAL_COLUMN]
        else:  # fall back to summing every electricity end use
            cols = [c for c in fields
                    if c.startswith("out.electricity.") and c.endswith(".energy_consumption")]
            if not cols:
                raise NrelError("Unexpected CSV layout: no electricity "
                                f"consumption columns in {path.name}.")
        for row in reader:
            try:
                values.append(sum(float(row[c] or 0) for c in cols))
            except (TypeError, ValueError):
                continue
    if len(values) < 96:  # less than one day of 15-min data is junk
        raise NrelError(f"Unexpected CSV layout: only {len(values)} data rows "
                        f"in {path.name}.")
    return values


def fetch_profile(product: str, climate_zone: str, building_type: str,
                  step_min: int = 60, normalize: str = "peak") -> dict:
    """Fetch + convert one aggregate profile into a ready LoadShapeSpec dict."""
    meta = PRODUCTS.get(product)
    if meta is None:
        raise NrelError(f"Unknown product '{product}'.", status=400)
    zone = climate_zone.lower()
    if zone not in meta["zones"]:
        raise NrelError(f"Unknown climate zone '{climate_zone}' for {product}.",
                        status=400)
    if building_type not in meta["buildingTypes"]:
        raise NrelError(f"Unknown building type '{building_type}' for {product}.",
                        status=400)
    if step_min not in (15, 60):
        raise NrelError("stepMin must be 15 or 60.", status=400)
    if normalize not in ("peak", "average"):
        raise NrelError("normalize must be 'peak' or 'average'.", status=400)

    kwh_15min = _read_kwh_series(_fetch_csv(product, zone, building_type))

    if step_min == 60:  # energy is additive: sum each group of four intervals
        kwh = [sum(kwh_15min[i:i + 4]) for i in range(0, len(kwh_15min) - 3, 4)]
    else:
        kwh = kwh_15min

    annual_kwh = sum(kwh_15min)
    per_hour = 60.0 / step_min  # kWh/interval -> average kW in the interval
    peak_kw = max(kwh) * per_hour
    avg_kw = annual_kwh / (len(kwh_15min) / 4.0)

    divisor = max(kwh) if normalize == "peak" else (sum(kwh) / len(kwh))
    points = [round(v / divisor, 5) if divisor else 0.0 for v in kwh]

    type_slug = sanitize_name(building_type)
    return {
        "name": f"nrel_{zone}_{type_slug}",
        "intervalMin": float(step_min),
        "points": points,
        "source": f"nrel:{product}/{zone}/{building_type}",
        "stats": {
            "peakKw": round(peak_kw, 1),
            "avgKw": round(avg_kw, 1),
            "annualKwh": round(annual_kwh, 0),
            "points": len(points),
        },
    }
