"""Equipment duty screening (facility plan 2.4).

Every breaker, fuse, recloser and relay is held to the fault current it may
have to interrupt, and every busbar to the fault current it may have to
withstand, from the same `mode=faultstudy` solve the Fault overlay uses:

* the fault current at a device is the larger of the bolted three-phase and
  single-line-to-ground currents at either of its terminals (single-phase
  can exceed three-phase near a grounded-wye transformer);
* times the project's **asymmetry factor** (a flat multiplier, 1 unless the
  user enters one; no X/R-based correction is computed);
* and the device passes when its rating is at least that times the **duty
  margin** (1 unless the user sets, say, 1.1).

Ratings: `interruptingka` (and optionally `withstandka`) on devices,
`bracingka` on busbars. An element with no rating is *unrated* and listed.

This is a screening check, not an ANSI C37 or IEC 60909 duty study: no
motor contribution, no AC or DC decay, no first-cycle or breaking-current
distinction.
"""
from __future__ import annotations

from typing import Any

from ..core import engine
from ..core.model import Circuit, in_service
from .scenarios import effective_circuit

DEVICES = ("breaker", "fuse", "recloser", "relay")

DISCLAIMER = (
    "Screening check, not an ANSI C37 or IEC 60909 duty study: the bolted three-phase and "
    "line-to-ground fault currents of the fault study (the larger, at either terminal), times "
    "the asymmetry factor entered, against the device's rating times the duty margin. Motor "
    "contribution, AC and DC decay and the first-cycle / breaking-current distinction are not "
    "modelled."
)


def _ka(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _judge(fault_a: float | None, rating_ka: float | None,
           margin: float) -> tuple[str, float | None]:
    """('pass' | 'fail' | 'unrated' | 'unknown', ratio of duty to rating)."""
    if rating_ka is None:
        return "unrated", None
    if not fault_a:
        return "unknown", None
    ratio = fault_a * margin / (rating_ka * 1000.0)
    return ("fail" if ratio > 1.0 else "pass"), round(ratio, 3)


def duty_screening(circuit: Circuit) -> dict[str, Any]:
    case = effective_circuit(circuit)
    limits = case.criteria
    margin = float(limits.dutyMargin)
    asym = float(limits.asymmetryFactor)
    fault = engine.fault_study(case)
    if not fault.get("converged"):
        return {"converged": False, "rows": [], "issues": fault.get("issues", []),
                "disclaimer": DISCLAIMER}
    buses = {b.lower(): v for b, v in fault["buses"].items()}
    node_buses = fault.get("nodeBuses") or {}

    def at(bus_list: list[str]) -> tuple[float | None, float | None]:
        i3 = [buses[b.lower()]["if3phA"] for b in bus_list
              if b.lower() in buses and buses[b.lower()]["if3phA"]]
        i1 = [buses[b.lower()]["if1phA"] for b in bus_list
              if b.lower() in buses and buses[b.lower()]["if1phA"]]
        return (max(i3) if i3 else None), (max(i1) if i1 else None)

    rows: list[dict[str, Any]] = []
    for n in case.nodes:
        if not in_service(n.params):
            continue
        if n.type in DEVICES:
            checks = (("interrupting", _ka(n.params.get("interruptingka"))),
                      ("withstand", _ka(n.params.get("withstandka"))))
        elif n.type == "busbar":
            checks = (("bracing", _ka(n.params.get("bracingka"))),)
        else:
            continue
        bus_list = node_buses.get(n.id) or []
        if not bus_list:
            continue
        i3, i1 = at(bus_list)
        worst = max(x for x in (i3, i1, 0.0) if x is not None) or None
        duty_a = round(worst * asym, 1) if worst else None
        results = {}
        for what, rating in checks:
            status, ratio = _judge(duty_a, rating, margin)
            results[what] = {"ratingKa": rating, "status": status, "ratio": ratio}
        # One verdict for the overlay: a failed check fails the element; a
        # device with no interrupting rating is unrated whatever else it has.
        statuses = [r["status"] for r in results.values()]
        if "fail" in statuses:
            status = "fail"
        elif results[checks[0][0]]["status"] == "unrated":
            status = "unrated"
        elif "unknown" in statuses:
            status = "unknown"
        else:
            status = "pass"
        rows.append({
            "id": n.id,
            "name": str(n.params.get("name") or n.id),
            "kind": n.type,
            "bus": bus_list[-1] if n.type in DEVICES else bus_list[0],
            "faultA3ph": i3,
            "faultA1ph": i1,
            "governing": ("1ph" if (i1 or 0) > (i3 or 0) else "3ph") if worst else None,
            "dutyA": duty_a,
            "checks": results,
            "status": status,
        })
    order = {"fail": 0, "unknown": 1, "unrated": 2, "pass": 3}
    rows.sort(key=lambda r: (order[r["status"]],
                             -max((c["ratio"] or 0) for c in r["checks"].values()), r["name"]))
    counts = {k: sum(1 for r in rows if r["status"] == k) for k in order}
    return {
        "converged": True,
        "rows": rows,
        "counts": counts,
        "dutyMargin": margin,
        "asymmetryFactor": asym,
        "disclaimer": DISCLAIMER,
        "issues": fault.get("issues", []),
        "nodeBuses": node_buses,
    }
