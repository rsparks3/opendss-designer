"""MultiSpeak network model import.

MultiSpeak is the co-operative utilities' integration standard, and the
network model its GIS and engineering interfaces exchange (versions 3 and
4) is what WindMil and most co-op GIS products write. This reader takes
that XML and produces OpenDSS text for the ordinary importer, covering
the element classes the network model carries:

* `ohPrimaryLine` / `ugPrimaryLine` (and the `*SecondaryLine` and
  `*Service` variants) with `sectionID`, `parentSectionID`, `phaseCode`,
  `lengthData` and a `conductorList` or `lineCode`;
* `transformerBank` / `transformer` with `kVA`, `highSideVoltage`,
  `lowSideVoltage`, `%Z`;
* `switchDevice`, `fuse`, `recloser`, `sectionalizer`, `breaker`;
* `capacitor` / `capacitorBank` with `kVAR`;
* `substation` / `source`;
* `meter` / `load` / `serviceLocation` with `kW` or `kWh`;
* `gpsLocation` (`latitude`, `longitude`) or `coord` (`x`, `y`).

The topology is the section tree: each element names its own section and
its parent's, so a bus is made at the head of every section. Field names
are matched case-insensitively and by the synonyms below, because the
versions and the vendors' extensions spell them differently.

This reader was written from the specification and verified only against
a synthetic sample (`tests/test_m17.py`); a real export from a co-op GIS
is wanted to confirm it.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any

_LINE_TAGS = {"ohprimaryline": 3, "ugprimaryline": 3, "ohsecondaryline": 1, "ugsecondaryline": 1,
              "ohservice": 1, "ugservice": 1, "line": 3, "linesection": 3}
_SWITCH_TAGS = {"switchdevice": "breaker", "switch": "breaker", "breaker": "breaker", "fuse": "fuse",
                "recloser": "recloser", "sectionalizer": "sectionalizer", "sectionaliser": "sectionalizer"}
_XF_TAGS = {"transformerbank", "transformer", "distributiontransformer"}
_CAP_TAGS = {"capacitor", "capacitorbank"}
_SRC_TAGS = {"substation", "source", "feederhead", "feeder"}
_LOAD_TAGS = {"meter", "load", "servicelocation", "customer", "electricmeter"}
_SYN = {
    "section": ("sectionid", "section", "sectid", "objectid", "id", "name", "deviceid", "equipmentid"),
    "parent": ("parentsectionid", "parentsection", "parentid", "parent", "upstreamsection", "fromsection"),
    "phase": ("phasecode", "phase", "phases", "phasing"),
    "length": ("lengthdata", "length", "len", "conductorlength"),
    "lengthunits": ("lengthunits", "units", "uom"),
    "linecode": ("linecode", "conductorlist", "conductor", "conductortype", "wiretype", "cable"),
    "kva": ("kva", "kvarating", "ratedkva", "nameplatekva", "size"),
    "kvhigh": ("highsidevoltage", "primaryvoltage", "primarykv", "hvkv", "kvh"),
    "kvlow": ("lowsidevoltage", "secondaryvoltage", "secondarykv", "lvkv", "kvl"),
    "pctz": ("%z", "pctz", "impedance", "percentimpedance", "zpercent"),
    "kvar": ("kvar", "kvarrating", "ratedkvar", "size"),
    "kw": ("kw", "demandkw", "peakkw", "connectedkw"),
    "kwh": ("kwh", "annualkwh", "monthlykwh", "consumption"),
    "status": ("normalstatus", "status", "state", "normalposition", "closed", "open"),
    "amps": ("ratedamps", "amps", "ampacity", "continuousrating", "rating"),
    "kv": ("kv", "nominalvoltage", "voltage", "operatingvoltage", "basekv"),
    "lat": ("latitude", "lat", "y"),
    "lon": ("longitude", "lon", "long", "x"),
}


def _local(tag: str) -> str:
    return (tag.split("}", 1)[1] if "}" in tag else tag).lower()


def _fields(el: ET.Element) -> dict[str, str]:
    """Every attribute and leaf child of an element, lowercased names."""
    out: dict[str, str] = {k.lower(): v for k, v in el.attrib.items()}
    for child in el.iter():
        if child is el:
            continue
        name = _local(child.tag)
        if child.text and child.text.strip() and name not in out:
            out[name] = child.text.strip()
        for k, v in child.attrib.items():
            out.setdefault(f"{name}.{k.lower()}", v)
    return out


def _get(f: dict[str, str], key: str) -> str | None:
    for syn in _SYN.get(key, (key,)):
        if syn in f and f[syn] != "":
            return f[syn]
    return None


def _num(f: dict[str, str], key: str) -> float | None:
    raw = _get(f, key)
    if raw is None:
        return None
    try:
        return float(re.sub(r"[^0-9.eE+-]", "", raw))
    except ValueError:
        return None


def _safe(name: str) -> str:
    return (re.sub(r"[^A-Za-z0-9_\-]+", "_", str(name).strip()) or "x")[:60].lower()


def _phase_suffix(code: str | None) -> tuple[str, int]:
    letters = [c for c in (code or "ABC").upper() if c in "ABC"]
    if not letters or len(letters) == 3:
        return "", 3
    return "." + ".".join(str("ABC".index(c) + 1) for c in letters), len(letters)


def multispeak_to_dss(text: str) -> tuple[str, list[str], list[str]]:
    root = ET.fromstring(text)
    notes: list[str] = []
    elements: list[tuple[str, dict[str, str]]] = []
    for el in root.iter():
        tag = _local(el.tag)
        if tag in _LINE_TAGS or tag in _SWITCH_TAGS or tag in _XF_TAGS or tag in _CAP_TAGS or tag in _SRC_TAGS or tag in _LOAD_TAGS:
            f = _fields(el)
            if _get(f, "section") is not None or tag in _SRC_TAGS:
                elements.append((tag, f))
    if not elements:
        raise ValueError("No MultiSpeak network elements (ohPrimaryLine, transformerBank, switchDevice, ...) were found.")

    def bus_of(section: str | None) -> str:
        return _safe(section or "root")

    lines: list[str] = []
    kv_bases: set[float] = set()
    coords: dict[str, tuple[float, float]] = {}
    sources = [(t, f) for t, f in elements if t in _SRC_TAGS]
    if sources:
        t, f = sources[0]
        kv = _num(f, "kv") or 12.47
        sec = _get(f, "section") or "source"
        lines.append(f"new circuit.{_safe(_get(f, 'section') or 'multispeak')} basekv={kv:.6g} pu=1 phases=3 bus1={bus_of(sec)} mvasc3=2000 mvasc1=2100")
        kv_bases.add(kv)
        root_bus = bus_of(sec)
    else:
        kv = 12.47
        parents = {_get(f, "parent") for _, f in elements}
        sections = {_get(f, "section") for _, f in elements}
        heads = [p for p in parents if p and p not in sections]
        root_sec = heads[0] if heads else "root"
        lines.append(f"new circuit.multispeak basekv=12.47 pu=1 phases=3 bus1={bus_of(root_sec)} mvasc3=2000 mvasc1=2100")
        kv_bases.add(kv)
        root_bus = bus_of(root_sec)
        notes.append("No substation element; a 12.47 kV source was placed at the head of the section tree.")
    base_kv = kv
    counts = {"line": 0, "switch": 0, "transformer": 0, "capacitor": 0, "load": 0}
    for t, f in elements:
        sec = _get(f, "section")
        parent = _get(f, "parent")
        if t in _SRC_TAGS or sec is None:
            continue
        b1 = bus_of(parent) if parent else root_bus
        b2 = bus_of(sec)
        name = _safe(sec)
        lat, lon = _num(f, "lat"), _num(f, "lon")
        if lat is not None and lon is not None:
            coords[b2] = (lon, lat)
        if t in _LINE_TAGS:
            sfx, nph = _phase_suffix(_get(f, "phase"))
            length = _num(f, "length") or 100.0
            units = (_get(f, "lengthunits") or "ft").lower()
            units = units if units in ("ft", "m", "km", "mi", "kft") else "ft"
            code = _get(f, "linecode")
            imp = f"linecode={_safe(code)}" if code and False else "r1=0.0002 x1=0.0004 r0=0.0005 x0=0.0012" if units == "ft" else "r1=0.12 x1=0.38 r0=0.4 x0=1.2"
            if units == "m":
                imp = "r1=0.00012 x1=0.00038 r0=0.0004 x0=0.0012"
            elif units == "mi":
                imp = "r1=0.2 x1=0.6 r0=0.65 x0=1.9"
            elif units == "kft":
                imp = "r1=0.2 x1=0.4 r0=0.5 x0=1.2"
            amps = _num(f, "amps")
            rating = f" normamps={amps:.6g}" if amps else ""
            tagnote = f" ! conductor {code}" if code else ""
            lines.append(f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={nph} {imp} length={length:.6g} units={units}{rating}{tagnote}")
            counts["line"] += 1
        elif t in _SWITCH_TAGS:
            sfx, nph = _phase_suffix(_get(f, "phase"))
            kind = _SWITCH_TAGS[t]
            amps = _num(f, "amps")
            rating = f" normamps={amps:.6g}" if amps else ""
            lines.append(f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={nph} switch=yes{rating}")
            watch = f"monitoredobj=line.{name} monitoredterm=1 switchedobj=line.{name} switchedterm=1"
            if kind == "fuse":
                lines.append(f"new fuse.{name} {watch} fusecurve=tlink ratedcurrent={amps or 65:.6g}")
            elif kind == "recloser":
                lines.append(f"new recloser.{name} {watch} phasefast=a phasedelayed=d phasetrip={amps or 100:.6g}")
            status = (_get(f, "status") or "closed").lower()
            if status in ("open", "o", "false", "0", "normallyopen", "normally open"):
                lines.append(f"open line.{name} term=1")
            counts["switch"] += 1
        elif t in _XF_TAGS:
            kva = _num(f, "kva") or 50.0
            kvh = _num(f, "kvhigh") or base_kv
            kvl = _num(f, "kvlow") or 0.24
            # Voltages above 100 are volts, not kV (12470, 240, 480).
            if kvh > 100:
                kvh /= 1000
            if kvl > 100:
                kvl /= 1000
            pctz = _num(f, "pctz") or 2.5
            sfx, nph = _phase_suffix(_get(f, "phase"))
            if nph == 1 and kvh >= 1 and abs(kvh - base_kv) < 0.05 * base_kv:
                kvh = kvh / 3 ** 0.5
            if nph == 1 and kvl < 1 and kvl > 0.2:
                # A 120/240 V service: the engine's centre-tapped form.
                lines.append(f"new transformer.{name} phases=1 windings=3 buses=({b1}{sfx}, {b2}.1.0, {b2}.0.2) conns=(wye, wye, wye) "
                             f"kvs=({kvh:.6g}, {kvl / 2:.6g}, {kvl / 2:.6g}) kvas=({kva:.6g}, {kva:.6g}, {kva:.6g}) "
                             f"xhl={1.2 * pctz:.6g} xht={1.2 * pctz:.6g} xlt={0.8 * pctz:.6g} %rs=(0.6, 1.2, 1.2)")
                kv_bases.add(0.208)
            else:
                lines.append(f"new transformer.{name} phases={nph} windings=2 buses=({b1}{sfx}, {b2}{sfx if nph < 3 else ''}) "
                             f"conns=(delta, wye) kvs=({kvh:.6g}, {kvl:.6g}) kvas=({kva:.6g}, {kva:.6g}) xhl={pctz:.6g}")
                kv_bases.add(kvh if nph == 3 else kvh * 3 ** 0.5)
                kv_bases.add(kvl if nph == 3 else kvl * 3 ** 0.5)
            counts["transformer"] += 1
        elif t in _CAP_TAGS:
            kvar = _num(f, "kvar") or 300.0
            sfx, nph = _phase_suffix(_get(f, "phase"))
            kv = _num(f, "kv") or base_kv
            lines.append(f"new capacitor.{name} bus1={b2}{sfx} phases={nph} kv={kv if nph == 3 else kv / 3 ** 0.5:.6g} kvar={kvar:.6g}")
            counts["capacitor"] += 1
        elif t in _LOAD_TAGS:
            kw = _num(f, "kw")
            if kw is None:
                kwh = _num(f, "kwh")
                kw = kwh / (730 * 0.5) if kwh else 5.0
            sfx, nph = _phase_suffix(_get(f, "phase"))
            kv = _num(f, "kv")
            if kv is None:
                kv = 0.24 if nph < 3 else base_kv
            if kv > 100:
                kv /= 1000
            bus = bus_of(parent) if parent else b2
            lines.append(f"new load.{name} bus1={bus}{sfx} phases={nph} kv={kv:.6g} kw={kw:.6g} pf=0.95 model=1")
            counts["load"] += 1
    lines.append(f"set voltagebases=[{', '.join(f'{v:.6g}' for v in sorted(kv_bases))}]")
    lines.append("calcvoltagebases")
    notes.append(f"MultiSpeak: {counts['line']} line sections, {counts['switch']} switches and devices, {counts['transformer']} "
                 f"transformers, {counts['capacitor']} capacitors, {counts['load']} loads. Conductor types are kept as comments; "
                 "line impedances are typical values until a line code is assigned.")
    coord_lines = [f"{b} {x:.8g} {y:.8g}" for b, (x, y) in coords.items()]
    return "! Converted from a MultiSpeak network model by OpenDSS Designer\n" + "\n".join(lines) + "\n", notes, coord_lines


def import_multispeak_text(text: str) -> dict[str, Any]:
    from .importer import import_dss_files
    dss_text, notes, coords = multispeak_to_dss(text)
    files = [{"name": "multispeak.dss", "text": dss_text}]
    if coords:
        files[0]["text"] += "buscoords multispeak_coords.csv\n"
        files.append({"name": "multispeak_coords.csv", "text": "\n".join(coords) + "\n"})
    result = import_dss_files(files)
    result["warnings"] = [*notes, *result.get("warnings", [])]
    if coords:
        result["circuit"]["crs"] = "EPSG:4326"
    return result
