"""Reliability indices: SAIFI, SAIDI and CAIDI from OpenDSS's own
EnergyMeter reliability calculation.

The engine does the work -- it already walks each meter zone, accumulates
the fault rate of every branch and counts the customers downstream -- and
this module decides where the meters go, runs the calculation, and reads
the answer back per element and per protection section so the drawing can
colour by section and the report can tabulate it.

How OpenDSS counts: every power-delivery element has a fault rate (per
year, or per unit length per year for a line), a share of faults that are
permanent, and a repair time in hours, and every load a number of
customers. A fault anywhere in a *section* -- the branches downstream of a
protective device (fuse, recloser or relay) up to the next one --
interrupts every customer downstream of that device's head. Branches
between a meter and the first protective device belong to no section, and
faults on them count for nothing: a feeder with no protective device at
its head reports zero interruptions, which this module warns about rather
than hides.
"""
from __future__ import annotations

import math
from typing import Any

import opendssdirect as dss

from . import engine
from .compiler import CompileResult, compile_circuit
from .connectivity import ConnectivityResult
from .model import Circuit, Issue
from .validate import limit_issues

# Elements a meter may be put on: everything that carries power through
# (a line, a switch, a transformer), in the order the compiler emits them.
_METERABLE = ("transformer", "regulator", "breaker", "fuse", "recloser", "relay")
_PROTECTIVE = ("fuse", "recloser", "relay")


def _meter_sites(circuit: Circuit, compiled: CompileResult,
                 issues: list[Issue]) -> list[tuple[str, str, int]]:
    """Where the energy meters go: (meter name, element full name, terminal).

    Elements flagged `meter` in the drawing come first; with none flagged,
    one meter per source on each power-delivery element touching the
    source's bus, so every feeder out of a substation bus is metered from
    its head. The terminal is the end at the upstream bus, which makes the
    zone extend away from the source.
    """
    conn: ConnectivityResult = compiled.connectivity  # type: ignore[assignment]
    by_id = {diagram_id: full for full, diagram_id in compiled.element_map.items()}
    sites: list[tuple[str, str, int]] = []
    seen: set[str] = set()

    def add(full: str, terminal: int) -> None:
        if full in seen:
            return
        seen.add(full)
        sites.append((f"m{len(sites) + 1}", full, terminal))

    # Hand-placed meters.
    flagged = [n for n in circuit.nodes if n.type in _METERABLE and n.params.get("meter")]
    flagged_edges = [e for e in circuit.edges if e.type == "line" and e.params.get("meter")]
    source_buses = {conn.node_buses[n.id][0] for n in circuit.nodes
                    if n.type == "vsource" and n.id in conn.node_buses}
    dist = engine._bus_distances(circuit, conn)

    def upstream_terminal(buses: list[str]) -> int:
        """1 or 2: the end nearer a source, so the zone runs downstream."""
        if len(buses) < 2:
            return 1
        d1 = dist.get(buses[0], math.inf)
        d2 = dist.get(buses[1], math.inf)
        return 2 if d2 < d1 else 1

    for n in flagged:
        full = by_id.get(n.id)
        if full:
            add(full, upstream_terminal(conn.node_buses.get(n.id, [])))
    for e in flagged_edges:
        full = by_id.get(e.id)
        if full and e.id in conn.line_buses:
            add(full, upstream_terminal(list(conn.line_buses[e.id])))
    if sites:
        return sites

    # Automatic placement: every power-delivery element on a source bus.
    for full, diagram_id in compiled.element_map.items():
        cls = full.split(".", 1)[0]
        if cls not in ("line", "transformer"):
            continue
        if diagram_id in conn.line_buses:
            buses = list(conn.line_buses[diagram_id])
        else:
            buses = conn.node_buses.get(diagram_id, [])
        for t, b in enumerate(buses[:2]):
            if b in source_buses:
                add(full, t + 1)
                break
    if not sites:
        issues.append(Issue(
            severity="error", code="no-meter",
            message="Nothing to meter: no line, switch or transformer leaves the source bus."))
    return sites


def _km(circuit: Circuit, diagram_id: str) -> float:
    for e in circuit.edges:
        if e.id == diagram_id and e.type == "line":
            try:
                length = float(e.params.get("length") or 0.0)
            except (TypeError, ValueError):
                length = 0.0
            return max(length, 0.0) * engine._KM_PER_UNIT.get(str(e.params.get("units", "km")), 1.0)
    return 0.0


def _fnum(value: Any, digits: int = 5) -> float:
    v = float(value)
    if not math.isfinite(v) or abs(v) < 1e-300:  # the engine leaves denormal garbage in unset slots
        return 0.0
    return round(v, digits)


@engine.on_engine_thread
def reliability_study(circuit: Circuit) -> dict[str, Any]:
    """SAIFI, SAIDI and CAIDI for the circuit, per meter zone and in all,
    with the protection sections and each element's part in them."""
    compiled: CompileResult = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    empty: dict[str, Any] = {
        "converged": False, "issues": [], "totalCustomers": 0,
        "saifi": None, "saidi": None, "caidi": None, "saifiKw": None,
        "custInterrupts": 0.0, "custHours": 0.0,
        "meters": [], "sections": [], "elements": {},
        "unsectioned": {"count": 0, "lambda": 0.0},
        "nodeBuses": {}, "lineBuses": {},
    }
    if any(i.severity == "error" for i in issues):
        return {**empty, "issues": [i.model_dump() for i in issues]}

    sites = _meter_sites(circuit, compiled, issues)
    if not sites:
        return {**empty, "issues": [i.model_dump() for i in issues]}

    types = {n.id: n.type for n in circuit.nodes}
    for e in circuit.edges:
        types[e.id] = e.type
    element_map = compiled.element_map

    meters_out: list[dict[str, Any]] = []
    sections_out: list[dict[str, Any]] = []
    elements_out: dict[str, Any] = {}
    unsectioned_count = 0
    unsectioned_lambda = 0.0
    converged = False
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        built = engine._run_commands(compiled.commands, element_map, issues,
                                     compiled.optional_commands)
        if built:
            try:
                for name, full, terminal in sites:
                    dss.Text.Command(
                        f"new energymeter.{name} element={full} terminal={terminal}")
                dss.Text.Command("set mode=snapshot")
                dss.Text.Command("solve")
                converged = bool(dss.Solution.Converged())
            except Exception as exc:
                issues.append(Issue(severity="error", code="solve-failed",
                                    message=f"Reliability study failed: {exc}"))
        if converged:
            # The calculation fills in every branch's accumulated rates and
            # customers, so it runs for every zone before any is read.
            raw: list[dict[str, Any]] = []
            for name, full, _terminal in sites:
                dss.Meters.Name(name)
                if dss.Meters.Name().lower() != name:
                    continue
                dss.Meters.DoReliabilityCalc(False)
                raw.append({
                    "name": name, "full": full,
                    "zone": [b.lower() for b in dss.Meters.AllBranchesInZone()],
                    "customers": int(dss.Meters.TotalCustomers()),
                    "saifi": _fnum(dss.Meters.SAIFI(), 6),
                    "saidi": _fnum(dss.Meters.SAIDI(), 6),
                    "saifiKw": _fnum(dss.Meters.SAIFIkW(), 6),
                    "custInterrupts": _fnum(dss.Meters.CustInterrupts(), 4),
                })
            # Every power-delivery element, in the engine's own order, which
            # is what ParentPDElement indexes into.
            pd: list[dict[str, Any]] = []
            i = dss.PDElements.First()
            while i:
                pd.append({
                    "name": dss.PDElements.Name().lower(),
                    "lambda": _fnum(dss.PDElements.Lambda()),
                    "accumulatedLambda": _fnum(dss.PDElements.AccumulatedL()),
                    "customers": int(dss.PDElements.NumCustomers()),
                    "totalCustomers": int(dss.PDElements.TotalCustomers()),
                    "section": int(dss.PDElements.SectionID()),
                    "repairHrs": _fnum(dss.PDElements.RepairTime(), 3),
                    "faultRate": _fnum(dss.PDElements.FaultRate()),
                    "pctPerm": _fnum(dss.PDElements.PctPermanent(), 2),
                    "parent": int(dss.PDElements.ParentPDElement()),
                })
                i = dss.PDElements.Next()
            by_name = {p["name"]: p for p in pd}

            for r in raw:
                name, full, zone, n_cust = r["name"], r["full"], r["zone"], r["customers"]
                saifi, saidi = r["saifi"], r["saidi"]
                meter = {
                    "name": name,
                    "element": full,
                    "elementId": element_map.get(full),
                    "customers": n_cust,
                    "saifi": saifi if n_cust else None,
                    "saidi": saidi if n_cust else None,
                    "caidi": round(saidi / saifi, 4) if n_cust and saifi > 0 else None,
                    "saifiKw": r["saifiKw"] if n_cust else None,
                    "custInterrupts": r["custInterrupts"],
                    "sections": [],
                }
                # Sections: branches sharing a section id; the head is the
                # one whose parent is in a different section.
                groups: dict[int, list[dict[str, Any]]] = {}
                for branch in zone:
                    p = by_name.get(branch)
                    if p is None:
                        continue
                    p["meter"] = name
                    groups.setdefault(p["section"], []).append(p)
                for sect, members in sorted(groups.items()):
                    if sect == 0:
                        unsectioned_count += len(members)
                        unsectioned_lambda += sum(m["lambda"] for m in members)
                        continue
                    head = next(
                        (m for m in members
                         if m["parent"] == 0 or pd[m["parent"] - 1]["section"] != sect),
                        members[0])
                    lam = sum(m["lambda"] for m in members)
                    lam_hours = sum(m["lambda"] * m["repairHrs"] for m in members)
                    head_id = element_map.get(head["name"])
                    total = head["totalCustomers"]
                    section_id = f"{name}:{sect}"
                    section = {
                        "id": section_id,
                        "meter": name,
                        "head": head["name"],
                        "headId": head_id,
                        "device": types.get(head_id or "", "other"),
                        "customers": sum(m["customers"] for m in members),
                        "totalCustomers": total,
                        "branches": len(members),
                        "lengthKm": round(sum(
                            _km(circuit, element_map.get(m["name"], "")) for m in members), 4),
                        "lambda": round(lam, 6),
                        "avgRepairHrs": round(lam_hours / lam, 3) if lam > 0 else None,
                        "custInterrupts": round(lam * total, 4),
                        "custHours": round(lam_hours * total, 4),
                    }
                    sections_out.append(section)
                    meter["sections"].append(section_id)
                    for m in members:
                        m["sectionId"] = section_id
                meter["custHours"] = round(sum(
                    s["custHours"] for s in sections_out if s["meter"] == name), 4)
                meters_out.append(meter)

            for p in pd:
                diagram_id = element_map.get(p["name"])
                if diagram_id is None or "meter" not in p:
                    continue
                elements_out[p["name"]] = {
                    "id": diagram_id,
                    "meter": p["meter"],
                    "sectionId": p.get("sectionId"),
                    "lambda": p["lambda"],
                    "accumulatedLambda": p["accumulatedLambda"],
                    "customers": p["customers"],
                    "totalCustomers": p["totalCustomers"],
                    "repairHrs": p["repairHrs"],
                    "faultRate": p["faultRate"],
                    "pctPerm": p["pctPerm"],
                }
        elif built:
            issues.append(Issue(
                severity="error", code="not-converged",
                message="The power flow behind the reliability study did not converge."))

    total_customers = sum(m["customers"] for m in meters_out)
    cust_int = sum(m["custInterrupts"] for m in meters_out)
    cust_hours = sum(m["custHours"] for m in meters_out)
    if converged and not total_customers:
        issues.append(Issue(
            severity="warning", code="no-customers",
            message="No load in a metered zone has customers, so there is nobody to "
                    "interrupt: give the loads a customer count."))
    if unsectioned_count:
        issues.append(Issue(
            severity="warning", code="unsectioned",
            message=f"{unsectioned_count} element{'s' if unsectioned_count != 1 else ''} "
                    f"between a meter and the first fuse, recloser or relay "
                    f"(fault rate {unsectioned_lambda:.3g} /yr in all) belong to no "
                    "protection section, so OpenDSS counts no interruptions for faults "
                    "there. Put a relay or recloser at the feeder head to count them."))
    saifi = cust_int / total_customers if total_customers else None
    saidi = cust_hours / total_customers if total_customers else None
    conn = compiled.connectivity
    return {
        "converged": converged,
        "issues": [i.model_dump() for i in issues],
        "totalCustomers": total_customers,
        "saifi": round(saifi, 6) if saifi is not None else None,
        "saidi": round(saidi, 6) if saidi is not None else None,
        "caidi": round(saidi / saifi, 4) if saifi else None,
        # kW-weighted SAIFI is the engine's per zone; it has no customer
        # count to combine zones by, so only a single zone reports it whole.
        "saifiKw": meters_out[0]["saifiKw"] if len(meters_out) == 1 else None,
        "custInterrupts": round(cust_int, 4),
        "custHours": round(cust_hours, 4),
        "meters": meters_out,
        "sections": sections_out,
        "elements": elements_out,
        "unsectioned": {"count": unsectioned_count, "lambda": round(unsectioned_lambda, 6)},
        "nodeBuses": conn.node_buses if conn else {},
        "lineBuses": {k: list(v) for k, v in conn.line_buses.items()} if conn else {},
    }
