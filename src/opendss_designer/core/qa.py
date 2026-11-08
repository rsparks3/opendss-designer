"""Model QA: the one-click check a utility runs on a converted model.

Beyond the live validation (which stops a solve), these are the things a
planner wants listed before signing a model: ratings and impedances left
at defaults, lengths that cannot be right for the voltage class, loads
without customers or classes, voltage bases no winding matches, loops in a
radial feeder, open points with no partner, elements out of service,
elements with no place on the map. Each is a finding with a code, a
severity (`warning` for something that changes answers, `info` for
something that limits a study) and the element; a completeness table per
element class says how much of the data is there.
"""
from __future__ import annotations

from typing import Any

from .compiler import DEFAULT_LINE_NORMAMPS, compile_circuit
from .connectivity import synthesize
from .model import Circuit, conducts, in_service

_KM = {"km": 1.0, "m": 0.001, "mi": 1.609344, "kft": 0.3048, "ft": 0.0003048, "in": 0.0000254,
       "cm": 0.00001, "none": 0.0}

# Values the editor fills in for a freshly drawn element; left as they are,
# they are placeholders, not data.
_PLACEHOLDER_LINE = {"r1": 0.12, "x1": 0.38, "r0": 0.4, "x0": 1.2}


def _num(p: dict, key: str) -> float | None:
    v = p.get(key)
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def qa_report(circuit: Circuit) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    missing: dict[str, dict[str, int]] = {}
    counts: dict[str, int] = {}

    def miss(cls: str, field: str) -> None:
        missing.setdefault(cls, {})[field] = missing.setdefault(cls, {}).get(field, 0) + 1

    def add(severity: str, code: str, message: str, node_id: str | None = None,
            edge_id: str | None = None) -> None:
        findings.append({"severity": severity, "code": code, "message": message,
                         "nodeId": node_id, "edgeId": edge_id})

    conn = synthesize(circuit)
    bases = set(circuit.voltageBases or [])
    kv_classes: set[float] = set()
    for n in circuit.nodes:
        if n.type == "vsource":
            v = _num(n.params, "basekv")
            if v:
                kv_classes.add(v)
        if n.type in ("transformer",):
            for w in n.params.get("windings") or []:
                if isinstance(w, dict) and _num(w, "kv"):
                    kv_classes.add(float(w["kv"]))
    primary_kv = max((k for k in kv_classes if k < 70), default=12.47)

    for n in circuit.nodes:
        if n.type in ("note", "zone", "busbar"):
            continue
        counts[n.type] = counts.get(n.type, 0) + 1
        p = n.params
        name = str(p.get("name") or n.id)
        if not in_service(p):
            add("info", "out-of-service", f"{name} is out of service.", n.id)
        if n.type == "load":
            kw = _num(p, "kw")
            if not kw or kw <= 0:
                miss("load", "kw")
                add("warning", "no-load", f"Load {name} has no kW.", n.id)
            if _num(p, "numcust") is None:
                miss("load", "customers")
            if not str(p.get("class") or "").strip():
                miss("load", "class")
            kv = _num(p, "kv")
            if kv is None:
                miss("load", "kv")
            elif bases and not any(abs(kv - b) / b < 0.05 or abs(kv * 3 ** 0.5 - b) / b < 0.05 for b in bases):
                add("warning", "kv-no-base", f"Load {name} is rated {kv:g} kV, which matches no voltage base.", n.id)
        elif n.type in ("breaker", "fuse", "recloser", "relay"):
            if _num(p, "interruptingka") is None:
                miss(n.type, "interruptingka")
            if n.type == "breaker" and not p.get("closed", True) and not p.get("tie"):
                buses = conn.node_buses.get(n.id, [])
                add("info", "open-point", f"{name} is normally open and not marked as a tie switch.", n.id)
                del buses
            if n.type == "recloser" and _num(p, "phasetrip") is None:
                miss("recloser", "phasetrip")
            if n.type == "relay" and _num(p, "phasetrip") is None:
                miss("relay", "phasetrip")
            if n.type == "fuse" and _num(p, "ratedcurrent") is None:
                miss("fuse", "ratedcurrent")
        elif n.type in ("transformer", "regulator"):
            windings = p.get("windings") or []
            kvas = [_num(w, "kva") for w in windings if isinstance(w, dict)] if n.type == "transformer" else [_num(p, "kva")]
            if not any(k and k > 0 for k in kvas):
                miss(n.type, "kva")
                add("warning", "no-rating", f"{name} has no kVA rating.", n.id)
            if n.type == "transformer" and _num(p, "xhl") is None:
                miss("transformer", "xhl")
            if n.type == "transformer" and bases:
                for w in windings:
                    kv = _num(w, "kv") if isinstance(w, dict) else None
                    if kv and not any(abs(kv - b) / b < 0.05 or abs(kv * 3 ** 0.5 - b) / b < 0.05 or abs(kv * 2 - b) / b < 0.1 for b in bases):
                        add("warning", "kv-no-base", f"{name}: winding at {kv:g} kV matches no voltage base.", n.id)
                        break
        elif n.type == "vsource":
            if _num(p, "mvasc3") is None:
                miss("vsource", "mvasc3")
                add("info", "default-source", f"Source {name} has no short-circuit strength; fault currents use the default.", n.id)
        elif n.type in ("generator", "pvsystem", "storage"):
            if _num(p, "kva") is None and _num(p, "kwrated") is None:
                miss(n.type, "kva")
        if n.type != "vsource" and n.geo is None:
            miss(n.type, "coordinates")

    line_count = 0
    for e in circuit.edges:
        if e.type != "line":
            continue
        line_count += 1
        p = e.params
        name = str(p.get("name") or e.id)
        if p.get("reactor"):
            continue
        length = _num(p, "length")
        km = (length or 0) * _KM.get(str(p.get("units", "km")), 1.0)
        if not length or length <= 0:
            miss("line", "length")
            add("warning", "no-length", f"Line {name} has no length.", edge_id=e.id)
        elif km > 50:
            add("warning", "long-line", f"Line {name} is {km:.1f} km long; check its length or units.", edge_id=e.id)
        elif km < 0.001 and primary_kv >= 1:
            add("info", "short-line", f"Line {name} is under a metre; a wire would do.", edge_id=e.id)
        has_code = bool(p.get("linecode")) and str(p.get("linecode")) in circuit.lineCodes
        has_geom = bool(p.get("geometry")) and str(p.get("geometry")) in circuit.lineGeometries
        if not has_code and not has_geom:
            own = {k: _num(p, k) for k in _PLACEHOLDER_LINE}
            if all(own[k] is None for k in own):
                miss("line", "impedance")
                add("warning", "no-impedance", f"Line {name} has no impedance; the editor's placeholder is used.", edge_id=e.id)
            elif all(own[k] is not None and abs(own[k] - v) < 1e-9 for k, v in _PLACEHOLDER_LINE.items()):
                miss("line", "impedance")
                add("warning", "placeholder-impedance", f"Line {name} still carries the editor's placeholder impedance.", edge_id=e.id)
        if _num(p, "normamps") is None and not (has_code and circuit.lineCodes[str(p["linecode"])].normamps) and not has_geom:
            miss("line", "normamps")
        amps = _num(p, "normamps")
        if amps is not None and abs(amps - DEFAULT_LINE_NORMAMPS) < 1e-9:
            add("info", "default-rating", f"Line {name} carries the default {DEFAULT_LINE_NORMAMPS:g} A rating.", edge_id=e.id)
        if not e.geometry and not any(n.geo for n in circuit.nodes if n.id in (e.source, e.target)):
            miss("line", "coordinates")
    counts["line"] = line_count

    # Loops among the conducting elements of a feeder that should be radial.
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    loops = 0
    for n in circuit.nodes:
        if n.type in ("transformer", "regulator", "breaker", "fuse", "recloser", "relay") and conducts(n):
            buses = conn.node_buses.get(n.id, [])
            for b in buses[1:]:
                a, c = find(buses[0]), find(b)
                if a == c:
                    loops += 1
                    add("info", "loop", f"{n.params.get('name') or n.id} closes a loop; the feeder is meshed here.", n.id)
                else:
                    parent[a] = c
    edge_by = {e.id: e for e in circuit.edges}
    for eid, (b1, b2) in conn.line_buses.items():
        e = edge_by.get(eid)
        if e is None or not in_service(e.params):
            continue
        a, c = find(b1), find(b2)
        if a == c:
            loops += 1
            add("info", "loop", f"Line {e.params.get('name') or eid} closes a loop; the feeder is meshed here.", edge_id=eid)
        else:
            parent[a] = c

    compile_issues = [i for i in compile_circuit(circuit).issues if i.code in ("duplicate-name", "unknown-curve", "bad-linecode", "bad-geometry")]
    for i in compile_issues:
        add(i.severity, i.code, i.message, i.nodeId, i.edgeId)

    # Completeness: share of the fields a class should carry that are present.
    weights = {"load": ("kw", "kv", "customers", "class", "coordinates"),
               "line": ("length", "impedance", "normamps", "coordinates"),
               "transformer": ("kva", "xhl", "coordinates"), "regulator": ("kva", "coordinates"),
               "breaker": ("interruptingka", "coordinates"), "fuse": ("ratedcurrent", "interruptingka", "coordinates"),
               "recloser": ("phasetrip", "interruptingka", "coordinates"), "relay": ("phasetrip", "interruptingka", "coordinates"),
               "vsource": ("mvasc3",), "generator": ("kva", "coordinates"), "pvsystem": ("kva", "coordinates"),
               "storage": ("kva", "coordinates"), "capacitor": ("coordinates",)}
    completeness = []
    total_cells = present_cells = 0
    for cls, fields in weights.items():
        n = counts.get(cls, 0)
        if not n:
            continue
        cells = n * len(fields)
        gone = sum(missing.get(cls, {}).get(f, 0) for f in fields)
        total_cells += cells
        present_cells += cells - gone
        completeness.append({"class": cls, "count": n, "fields": len(fields),
                             "missing": {f: missing.get(cls, {}).get(f, 0) for f in fields if missing.get(cls, {}).get(f, 0)},
                             "pct": round(100.0 * (cells - gone) / cells, 1)})
    score = round(100.0 * present_cells / total_cells, 1) if total_cells else 100.0
    warnings = sum(1 for f in findings if f["severity"] == "warning")
    return {
        "score": score,
        "elements": sum(counts.values()),
        "findings": findings,
        "warnings": warnings,
        "infos": len(findings) - warnings,
        "loops": loops,
        "completeness": completeness,
        "voltageBases": sorted(bases),
    }
