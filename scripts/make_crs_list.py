"""Write frontend/src/lib/crsList.json: the coordinate systems the geographic
view offers by name.

Feeder models keep bus coordinates in State Plane feet, UTM metres or plain
latitude/longitude, and the browser needs a proj4 definition to put any of
them on a map. Bundling the common ones means a user picks "NAD83 / Arizona
Central (ft)" from a list instead of pasting a definition; anything else can
still be pasted. Generated from PROJ's EPSG database with pyproj, which the
app itself does not depend on:

    python scripts/make_crs_list.py
"""
from __future__ import annotations

import json
import re
import warnings
from pathlib import Path

import pyproj
from pyproj.database import query_crs_info
from pyproj.enums import PJType

OUT = Path(__file__).resolve().parent.parent / "frontend" / "src" / "lib" / "crsList.json"

# Projected systems a North American feeder model is likely to be in, plus
# WGS 84 UTM for everywhere else, and the two geographic ones.
_PROJECTED = re.compile(
    r"^(NAD83|NAD83\(HARN\)|NAD83\(2011\)|NAD83\(CSRS\)) / "
    r"|^WGS 84 / UTM zone \d+[NS]$"
    r"|^WGS 84 / Pseudo-Mercator$"
    r"|^ETRS89 / UTM zone \d+N$"
    r"|^GDA2020 / MGA zone \d+$")
_GEOGRAPHIC = {"4326", "4269"}


def main() -> None:
    out = []
    for info in query_crs_info(auth_name="EPSG", pj_types=[PJType.PROJECTED_CRS]):
        if info.deprecated or not _PROJECTED.search(info.name):
            continue
        out.append((info.code, info.name))
    for code in sorted(_GEOGRAPHIC):
        out.append((code, pyproj.CRS.from_epsg(int(code)).name))
    rows = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for code, name in sorted(out, key=lambda r: r[1]):
            crs = pyproj.CRS.from_epsg(int(code))
            proj4 = crs.to_proj4()
            if not proj4:
                continue
            # Lossy for datum shifts proj4js cannot do anyway; the definition
            # positions a feeder on a basemap to well under a metre.
            proj4 = proj4.replace(" +type=crs", "")
            rows.append({"code": f"EPSG:{code}", "name": name, "proj4": proj4})
    OUT.write_text(json.dumps(rows, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(rows)} coordinate systems -> {OUT} ({OUT.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    main()
