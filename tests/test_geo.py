"""Bus coordinates on import and export: kept as the file gave them (`geo`),
in the system the file implies (`crs`), and written back with SetBusXY."""
from __future__ import annotations

from opendss_designer.core.compiler import export_dss
from opendss_designer.core.importer import import_dss_files
from opendss_designer.core.model import Circuit

FEEDER = """
New Circuit.geo basekv=12.47 bus1=a
New Line.l1 bus1=a bus2=b length=1 units=km
New Load.ld bus1=b kv=12.47 kw=10
"""


def _bus(circuit: dict, name: str) -> dict:
    return next(n for n in circuit["nodes"] if n["type"] == "busbar" and n["params"]["name"] == name)


def test_latlongcoords_are_wgs84_kept_exactly():
    res = import_dss_files([
        {"name": "main.dss", "text": FEEDER + "LatLongCoords ll.csv\n"},
        {"name": "ll.csv", "text": "a, 33.4201, -111.9312\nb, 33.4255, -111.9400\n"},
    ])
    c = res["circuit"]
    assert c["crs"] == "EPSG:4326"
    assert _bus(c, "a")["geo"] == {"x": -111.9312, "y": 33.4201}  # x is longitude
    assert _bus(c, "b")["geo"] == {"x": -111.94, "y": 33.4255}


def test_buscoords_come_in_raw_with_no_system():
    res = import_dss_files([
        {"name": "main.dss", "text": FEEDER + "BusCoords xy.csv\n"},
        {"name": "xy.csv", "text": "a, 712000.5, 875000.25\nb, 712900, 875100\n"},
    ])
    c = res["circuit"]
    assert c.get("crs") is None
    assert _bus(c, "a")["geo"] == {"x": 712000.5, "y": 875000.25}


def test_export_writes_setbusxy_and_it_reimports():
    res = import_dss_files([
        {"name": "main.dss", "text": FEEDER + "BusCoords xy.csv\n"},
        {"name": "xy.csv", "text": "a, 712000.5, 875000.25\nb, 712900, 875100\n"},
    ])
    text, _ = export_dss(Circuit.model_validate(res["circuit"]))
    assert "setbusxy bus=a x=712000.5 y=875000.25" in text
    again = import_dss_files([{"name": "export.dss", "text": text}])["circuit"]
    assert _bus(again, "b")["geo"] == {"x": 712900.0, "y": 875100.0}


def test_the_ieee_samples_open_on_the_map():
    """The shipped IEEE samples carry EPRI's bus coordinates, so Map has
    something to show the moment one is opened (the 34 and 123-bus masters
    leave loading them to a run script; tests/ieee_feeders.py adds the line)."""
    from opendss_designer.core import samples

    for key in ("13", "34", "37", "123"):
        nodes = samples.get_sample(f"ieee-{key}-bus")["nodes"]
        buses = [n for n in nodes if n["type"] == "busbar"]
        placed = [n for n in buses if n.get("geo")]
        assert len(placed) >= 0.95 * len(buses), (key, len(placed), len(buses))
