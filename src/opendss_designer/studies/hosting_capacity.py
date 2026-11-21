"""Hosting capacity: how much DER (or how much new load) each bus can take
before a planning criterion binds.

Two methods, both on one engine build of the circuit:

* **iterative** -- a trial unit is placed at the candidate bus and grown by
  bisection until a criterion fails; every evaluation is a solve (two when
  the trip-deviation criterion is on). Exact for the criteria it checks,
  and the reference the other method is held to.
* **sensitivity** -- one perturbation solve per bus gives dV/dP at every
  bus and dI/dP in every branch, the voltage- and thermal-limited
  capacities fall out of linear extrapolation, and one or two confirming
  solves settle the answer. The shape of EPRI's DRIVE method; it is what
  makes a feeder-wide or hourly study affordable.

Criteria (each switchable): overvoltage / undervoltage against the project
limits (or a tighter DER limit), thermal at the active level's rating,
rapid voltage change when the unit trips, reverse power through a
regulator and at the substation, fault-current increase and interrupting
headroom (analytic, from the unit's fault contribution against a base
fault study -- the way the SGIP screens are computed), and the DER to
minimum-load ratio in the protection section. Protection reach waits for
the sliding fault of M16; control operations are a post-check over a daily
run when the circuit has shapes.

Pre-existing violations do not count: anything already over a limit in the
base case is excluded from that criterion and listed.
"""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import CompileResult, compile_circuit
from ..core.model import Circuit, Issue, conducts
from ..core.validate import limit_issues
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

CRITERIA = (
    "voltage",
    "thermal",
    "deviation",
    "regulatorReverse",
    "substationReverse",
    "faultCurrent",
    "interrupting",
    "islanding",
    "controlOps",
)

DEFAULT_OPTIONS: dict[str, Any] = {
    # "der" grows generation at each bus; "load" grows load (EV, electrification).
    "kind": "der",
    "method": "iterative",  # or "sensitivity"
    "criteria": {c: c not in ("controlOps",) for c in CRITERIA},
    # Which buses: all three-phase primary buses by default. Names override.
    "buses": None,
    "minKv": 1.0,  # line-to-line kV below which a bus is skipped (secondaries)
    "threePhaseOnly": True,
    # Limits. None falls back to the project's abnormal-condition limits.
    "vmaxPu": None,
    "vminPu": None,
    "deviationPct": 3.0,  # rapid voltage change on trip, IEEE 1547-2018 4.7
    "thermalPct": 100.0,  # of the level's rating
    "substationExportKw": 0.0,  # export at the feeder head above this is reverse power
    "regulatorReverseKw": 10.0,  # reverse flow through a regulator above this
    "faultIncreasePct": 10.0,  # SGIP screen: contribution to maximum fault current
    "interruptingPct": 87.5,  # SGIP screen: duty against interrupting rating
    "islandingRatio": 0.667,  # DER / minimum load in the protection section
    "controlOpsPerDay": 20,  # tap changes + switchings a day, post-check
    # The unit. Inverter contribution 1.2 x rated current; a synchronous
    # machine about 5 x (xd'' = 0.2).
    "derType": "inverter",  # or "synchronous"
    "pf": 1.0,
    "loadPf": 0.95,
    # Search.
    "maxKw": 20_000.0,
    "toleranceKw": 10.0,
    # Time-granular: hours of the day to evaluate (needs loadshapes). None = the level.
    "hours": None,
    "perturbKw": 100.0,  # sensitivity method's probe
}


def options_from(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_OPTIONS.items()}
    for k, v in (raw or {}).items():
        if k == "criteria" and isinstance(v, dict):
            out["criteria"].update({c: bool(v[c]) for c in v if c in CRITERIA})
        elif k in out:
            out[k] = v
    return out


def estimate_solves(circuit: Circuit, raw: dict[str, Any] | None) -> int:
    """Roughly how many solves the study will take, for the plan cap."""
    opts = options_from(raw)
    n_bus = (
        len(opts["buses"])
        if opts["buses"]
        else max(1, sum(1 for n in circuit.nodes if n.type in ("busbar", "load", "transformer")))
    )
    hours = len(opts["hours"]) if opts["hours"] else 1
    if opts["method"] == "sensitivity":
        return hours * (1 + n_bus * 3)
    steps = int(math.log2(max(2.0, opts["maxKw"] / max(opts["toleranceKw"], 1.0)))) + 4
    return hours * n_bus * steps * (2 if opts["criteria"].get("deviation") else 1)


# --- the study ----------------------------------------------------------------------


class _Session:
    """The built circuit and what the criteria need to know about it."""

    def __init__(self, circuit: Circuit, compiled: CompileResult, opts: dict[str, Any]) -> None:
        self.circuit = circuit
        self.compiled = compiled
        self.opts = opts
        self.level = circuit.level
        self.limits = circuit.criteria
        self.vmax = float(opts["vmaxPu"] or self.limits.vmaxPu)
        self.vmin = float(opts["vminPu"] or self.limits.vminPu)
        self.emergency = self.level.rating == "emergency"
        self.unit_name = "hc_unit"
        # Where the last evaluation failed, by criterion: the bus or element.
        self.where: dict[str, Any] = {}
        self.unit_class = "generator" if opts["kind"] == "der" else "load"
        self.solves = 0
        # Node names and the bus slices of AllBusMagPu, computed once.
        names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        self.bus_slices: dict[str, list[int]] = {}
        for idx, node in enumerate(names):
            self.bus_slices.setdefault(node.split(".", 1)[0], []).append(idx)
        self.bus_kv: dict[str, float] = {}
        self.bus_phases: dict[str, int] = {}
        for b in self.bus_slices:
            dss.Circuit.SetActiveBus(b)
            self.bus_kv[b] = float(dss.Bus.kVBase())  # line-to-neutral
            self.bus_phases[b] = len([n for n in dss.Bus.Nodes() if 1 <= int(n) <= 3])
        self.pd_names = [n.lower() for n in dss.PDElements.AllNames()]
        # Regulators: the transformers a RegControl moves.
        self.regulators: list[str] = []
        i = dss.RegControls.First()
        while i:
            self.regulators.append(f"transformer.{str(dss.RegControls.Transformer()).lower()}")
            i = dss.RegControls.Next()
        # Protective devices and their buses, for interrupting duty.
        self.devices: list[tuple[str, str, float]] = []  # (full name, bus, interrupting kA)
        for n in circuit.nodes:
            if n.type in ("breaker", "fuse", "recloser", "relay"):
                ka = n.params.get("interruptingka")
                try:
                    ka = float(ka) if ka is not None else 0.0
                except (TypeError, ValueError):
                    ka = 0.0
                full = next(
                    (
                        f
                        for f, ref in compiled.element_map.items()
                        if ref == n.id and f.startswith("line.")
                    ),
                    None,
                )
                buses = (
                    compiled.connectivity.node_buses.get(n.id, []) if compiled.connectivity else []
                )
                if full and buses and ka > 0:
                    self.devices.append((full, buses[0].lower(), ka))
        self.sections = _protection_sections(circuit, compiled)
        self.has_shapes = any(n.params.get("loadshape") for n in circuit.nodes)

    # --- solving -------------------------------------------------------------

    def solve(self, hour: int | None) -> bool:
        if hour is not None:
            dss.Text.Command(f"set hour={hour} sec=0")
        dss.Solution.Solve()
        self.solves += 1
        return bool(dss.Solution.Converged())

    def set_unit(self, bus: str | None, kw: float) -> None:
        """Move the trial unit to `bus` at `kw`; None parks it out of the way."""
        if bus is None:
            dss.Text.Command(f"{self.unit_class}.{self.unit_name}.enabled=no")
            return
        phases = self.bus_phases.get(bus, 3)
        kv_ln = self.bus_kv.get(bus, 7.2)
        kv = kv_ln * math.sqrt(3) if phases == 3 else kv_ln
        nodes = (
            ".1.2.3"
            if phases == 3
            else "." + ".".join(str(n) for n in dss.Bus.Nodes()[:phases])
            if False
            else ""
        )
        if phases != 3:
            dss.Circuit.SetActiveBus(bus)
            nodes = "." + ".".join(str(int(n)) for n in dss.Bus.Nodes() if 1 <= int(n) <= 3)
        if self.unit_class == "generator":
            dss.Text.Command(
                f"edit generator.{self.unit_name} bus1={bus}{nodes} phases={phases} kv={kv:.6g} "
                f"kw={kw:.6g} pf={float(self.opts['pf']):g} model=1 enabled=yes"
            )
        else:
            dss.Text.Command(
                f"edit load.{self.unit_name} bus1={bus}{nodes} phases={phases} kv={kv:.6g} "
                f"kw={kw:.6g} pf={float(self.opts['loadPf']):g} model=1 vminpu=0.7 enabled=yes"
            )

    def define_unit(self) -> None:
        first = next(iter(self.bus_slices))
        if self.unit_class == "generator":
            dss.Text.Command(
                f"new generator.{self.unit_name} bus1={first} phases=3 kv=12.47 kw=0 "
                f"pf=1 model=1 enabled=no"
            )
        else:
            dss.Text.Command(
                f"new load.{self.unit_name} bus1={first} phases=3 kv=12.47 kw=0 "
                f"pf=0.95 model=1 enabled=no"
            )

    # --- readings -------------------------------------------------------------

    def voltages(self) -> dict[str, tuple[float, float]]:
        mags = dss.Circuit.AllBusMagPu()
        out = {}
        for b, idxs in self.bus_slices.items():
            vals = [mags[i] for i in idxs]
            out[b] = (min(vals), max(vals))
        return out

    def loading(self) -> dict[str, float]:
        pct = (
            dss.PDElements.AllPctEmerg(False)
            if self.emergency
            else dss.PDElements.AllPctNorm(False)
        )
        return {n: float(v) for n, v in zip(self.pd_names, pct, strict=False)}

    def regulator_flows(self) -> dict[str, float]:
        out = {}
        for full in self.regulators:
            if dss.Circuit.SetActiveElement(full) < 0:
                continue
            powers = dss.CktElement.Powers()
            ncond = dss.CktElement.NumConductors()
            out[full] = sum(powers[0 : 2 * ncond : 2])  # kW into terminal 1 (source side)
        return out

    def substation_export_kw(self) -> float:
        # TotalPower is the source injection, negative when the feeder draws.
        return float(dss.Circuit.TotalPower()[0])


def _protection_sections(circuit: Circuit, compiled: CompileResult) -> dict[str, dict[str, Any]]:
    """For every bus: the protective device heading its section (walking
    upstream from the source) and the rated kW of load in that section.
    Buses above the first device belong to section "" (the feeder head)."""
    conn = compiled.connectivity
    if conn is None:
        return {}
    protective = {"fuse", "recloser", "relay"}
    adjacency: dict[str, list[tuple[str, str | None]]] = {}
    for n in circuit.nodes:
        if n.type in (
            "transformer",
            "regulator",
            "breaker",
            "fuse",
            "recloser",
            "relay",
        ) and conducts(n):
            buses = conn.node_buses.get(n.id, [])
            device = n.id if n.type in protective else None
            for a in buses:
                for b in buses:
                    if a != b:
                        adjacency.setdefault(a.lower(), []).append((b.lower(), device))
    edge_params = {e.id: e for e in circuit.edges}
    for eid, (b1, b2) in conn.line_buses.items():
        e = edge_params.get(eid)
        if e is not None and e.params.get("enabled", True) is False:
            continue
        adjacency.setdefault(b1.lower(), []).append((b2.lower(), None))
        adjacency.setdefault(b2.lower(), []).append((b1.lower(), None))
    head: dict[str, str] = {}
    queue = [
        (conn.node_buses[n.id][0].lower(), "")
        for n in circuit.nodes
        if n.type == "vsource" and n.id in conn.node_buses
    ]
    for b, _ in queue:
        head[b] = ""
    while queue:
        bus, section = queue.pop(0)
        for nb, device in adjacency.get(bus, ()):
            if nb in head:
                continue
            head[nb] = device or section
            queue.append((nb, device or section))
    load_kw: dict[str, float] = {}
    for n in circuit.nodes:
        if n.type == "load" and n.params.get("enabled", True) is not False:
            bus = conn.node_buses.get(n.id, [None])[0]
            if bus:
                try:
                    kw = float(n.params.get("kw", 100.0))
                except (TypeError, ValueError):
                    kw = 100.0
                section = head.get(bus.lower(), "")
                load_kw[section] = load_kw.get(section, 0.0) + kw
    return {b: {"section": s, "sectionLoadKw": load_kw.get(s, 0.0)} for b, s in head.items()}


def _base_fault(session: _Session) -> dict[str, float]:
    """Three-phase fault current (A) at every bus from a fault study of the
    circuit as built, with the controls quieted as engine.fault_study does."""
    engine.quiet_for_fault_study(session.compiled.element_map, session.compiled.passthrough_names)
    out: dict[str, float] = {}
    try:
        dss.Text.Command("set mode=faultstudy")
        dss.Text.Command("solve")
        for b in session.bus_slices:
            dss.Circuit.SetActiveBus(b)
            z1 = dss.Bus.Zsc1()
            z = complex(float(z1[0]), float(z1[1]))
            v = dss.Bus.kVBase() * 1000.0
            if abs(z) > 1e-9:
                out[b] = v / abs(z)
    finally:
        # Back to a snapshot with everything re-enabled.
        for full in session.compiled.element_map:
            if full.startswith(("storage.", "regcontrol.", "fuse.", "recloser.", "relay.")):
                dss.Text.Command(f"{full}.enabled=yes")
        for full in session.compiled.passthrough_names:
            dss.Text.Command(f"{full}.enabled=yes")
        dss.Text.Command("set mode=snapshot")
    return out


def hosting_capacity(
    circuit: Circuit,
    raw_options: dict[str, Any] | None = None,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    opts = options_from(raw_options)
    circuit = effective_circuit(circuit)
    return _hosting_capacity(circuit, opts, progress, cancel)


@engine.on_engine_thread
def _hosting_capacity(
    circuit: Circuit,
    opts: dict[str, Any],
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    started = time.perf_counter()
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
    crit = opts["criteria"]
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        if not engine._run_commands(
            compiled.commands, compiled.element_map, issues, compiled.optional_commands
        ):
            return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("solve")
        if not dss.Solution.Converged():
            issues.append(
                Issue(
                    severity="error",
                    code="not-converged",
                    message="The base case does not converge, so no capacity can be found.",
                )
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
        session = _Session(circuit, compiled, opts)
        session.solves = 1
        base_fault = (
            _base_fault(session)
            if opts["kind"] == "der" and (crit.get("faultCurrent") or crit.get("interrupting"))
            else {}
        )
        dss.Text.Command("solve")
        session.define_unit()

        exclusions: dict[str, list[str]] = {}
        hours: list[int | None] = (
            list(opts["hours"]) if opts["hours"] and session.has_shapes else [None]
        )
        if hours != [None]:
            dss.Text.Command("set mode=daily stepsize=1h number=1")
        candidates = _candidates(session, opts)
        total = len(candidates) * len(hours)
        done = 0
        results: dict[str, Any] = {}
        hourly: dict[str, dict[str, Any]] = {}
        cancelled = False
        for hour in hours:
            session.set_unit(None, 0.0)
            if not session.solve(hour):
                issues.append(
                    Issue(
                        severity="warning",
                        code="not-converged",
                        message=f"Hour {hour}: the base case did not converge; skipped.",
                    )
                )
                continue
            base = _Base.read(session, base_fault)
            if hour is None or not exclusions:
                exclusions = base.exclusions()
            per_bus: dict[str, Any] = {}
            for bus in candidates:
                if cancel is not None and cancel.is_set():
                    cancelled = True
                    break
                if opts["method"] == "sensitivity":
                    per_bus[bus] = _sensitivity(session, base, bus, hour)
                else:
                    per_bus[bus] = _bisect(session, base, bus, hour)
                done += 1
                if progress is not None and (done % max(1, total // 200) == 0 or done == total):
                    progress(
                        done, total, f"bus {bus}" + (f" at hour {hour}" if hour is not None else "")
                    )
            if hour is None:
                results = per_bus
            else:
                hourly[str(hour)] = per_bus
            if cancelled:
                break
        session.set_unit(None, 0.0)
        if hourly:
            # The hosting capacity of a bus across the day is its worst hour.
            for bus in candidates:
                cells = [h[bus] for h in hourly.values() if bus in h]
                if not cells:
                    continue
                worst = min(cells, key=lambda c: c["kw"] if c["kw"] is not None else math.inf)
                results[bus] = {
                    **worst,
                    "kwByHour": {h: c[bus]["kw"] for h, c in hourly.items() if bus in c},
                }

    conn = compiled.connectivity
    kws = [r["kw"] for r in results.values() if r.get("kw") is not None]
    kws_sorted = sorted(kws)
    binding_counts: dict[str, int] = {}
    for r in results.values():
        if r.get("binding"):
            binding_counts[r["binding"]] = binding_counts.get(r["binding"], 0) + 1
    return {
        "converged": bool(results),
        "cancelled": cancelled,
        "kind": opts["kind"],
        "method": opts["method"],
        "criteria": crit,
        "options": {k: v for k, v in opts.items() if k not in ("criteria", "buses")},
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "buses": results,
        "hours": [h for h in hours if h is not None],
        "exclusions": exclusions,
        "summary": {
            "candidates": len(candidates),
            "evaluated": len(results),
            "minKw": kws_sorted[0] if kws_sorted else None,
            "medianKw": kws_sorted[len(kws_sorted) // 2] if kws_sorted else None,
            "maxKw": kws_sorted[-1] if kws_sorted else None,
            "bindingCounts": binding_counts,
            "solves": session.solves,
            "seconds": round(time.perf_counter() - started, 2),
        },
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": conn.node_buses if conn else {},
        "busNames": conn.bus_names if conn else {},
    }


def _candidates(session: _Session, opts: dict[str, Any]) -> list[str]:
    if opts["buses"]:
        wanted = {str(b).lower() for b in opts["buses"]}
        return [b for b in session.bus_slices if b in wanted]
    out = []
    min_kv = float(opts["minKv"] or 0.0)
    for b, kv_ln in session.bus_kv.items():
        phases = session.bus_phases.get(b, 0)
        if phases == 0:
            continue
        kv_ll = kv_ln * math.sqrt(3) if phases == 3 else kv_ln
        if kv_ll < min_kv:
            continue
        if opts["threePhaseOnly"] and phases != 3:
            continue
        out.append(b)
    return out


class _Base:
    """The base case at one operating point: what is already over a limit
    (excluded from the criteria), and the readings the sensitivity method
    extrapolates from."""

    def __init__(self) -> None:
        self.voltages: dict[str, tuple[float, float]] = {}
        self.loading: dict[str, float] = {}
        self.reg_flows: dict[str, float] = {}
        self.export_kw = 0.0
        self.over_v: set[str] = set()
        self.under_v: set[str] = set()
        self.over_loaded: set[str] = set()
        self.reversed: set[str] = set()
        self.fault: dict[str, float] = {}
        # Devices already past the interrupting-duty limit before any unit
        # is added: a pre-existing violation, excluded like the others.
        self.over_duty: set[str] = set()

    @classmethod
    def read(cls, s: _Session, base_fault: dict[str, float]) -> _Base:
        b = cls()
        b.voltages = s.voltages()
        b.loading = s.loading()
        b.reg_flows = s.regulator_flows()
        b.export_kw = s.substation_export_kw()
        b.fault = base_fault
        for bus, (lo, hi) in b.voltages.items():
            if hi > s.vmax:
                b.over_v.add(bus)
            if 0.05 < lo < s.vmin:
                b.under_v.add(bus)
        for name, pct in b.loading.items():
            if pct >= float(s.opts["thermalPct"]):
                b.over_loaded.add(name)
        for name, kw in b.reg_flows.items():
            if kw < -float(s.opts["regulatorReverseKw"]):
                b.reversed.add(name)
        limit = float(s.opts["interruptingPct"])
        for full, dev_bus, ka in s.devices:
            base_at = b.fault.get(dev_bus)
            if base_at and 100.0 * base_at / (ka * 1000.0) > limit:
                b.over_duty.add(full)
        return b

    def exclusions(self) -> dict[str, list[str]]:
        return {
            "overvoltage": sorted(self.over_v),
            "undervoltage": sorted(self.under_v),
            "overloaded": sorted(self.over_loaded),
            "reversed": sorted(self.reversed),
            "overDuty": sorted(self.over_duty),
        }


def _violations(
    s: _Session, base: _Base, bus: str, kw: float, hour: int | None
) -> list[str] | None:
    """Which criteria the trial unit at `kw` violates (empty = feasible);
    None when the solve did not converge, which counts as infeasible."""
    crit = s.opts["criteria"]
    s.set_unit(bus, kw)
    s.where = {}
    if not s.solve(hour):
        return None
    out: list[str] = []
    v = s.voltages()
    if crit.get("voltage"):
        if s.opts["kind"] == "der":
            over = [(hi, b) for b, (lo, hi) in v.items() if b not in base.over_v and hi > s.vmax]
            if over:
                out.append("voltage")
                s.where["voltage"] = {"bus": max(over)[1], "value": round(max(over)[0], 4)}
        else:
            under = [(lo, b) for b, (lo, hi) in v.items()
                     if b not in base.under_v and 0.05 < lo < s.vmin]
            if under:
                out.append("voltage")
                s.where["voltage"] = {"bus": min(under)[1], "value": round(min(under)[0], 4)}
    if crit.get("thermal"):
        limit = float(s.opts["thermalPct"])
        hot = [(pct, n) for n, pct in s.loading().items()
               if n not in base.over_loaded and pct >= limit]
        if hot:
            out.append("thermal")
            pct, name = max(hot)
            s.where["thermal"] = {"element": name, "id": s.compiled.element_map.get(name),
                                  "value": round(pct, 1)}
    if crit.get("regulatorReverse") and s.opts["kind"] == "der" and s.regulators:
        thr = -float(s.opts["regulatorReverseKw"])
        if any(kw_ < thr for n, kw_ in s.regulator_flows().items() if n not in base.reversed):
            out.append("regulatorReverse")
    if crit.get("substationReverse") and s.opts["kind"] == "der":
        if s.substation_export_kw() > float(
            s.opts["substationExportKw"]
        ) and base.export_kw <= float(s.opts["substationExportKw"]):
            out.append("substationReverse")
    if (crit.get("faultCurrent") or crit.get("interrupting")) and s.opts["kind"] == "der":
        inc = _fault_increase(s, base, bus, kw)
        if (
            crit.get("faultCurrent")
            and inc["pct"] is not None
            and inc["pct"] > float(s.opts["faultIncreasePct"])
        ):
            out.append("faultCurrent")
        if (
            crit.get("interrupting")
            and inc["dutyPct"] is not None
            and inc["dutyPct"] > float(s.opts["interruptingPct"])
        ):
            out.append("interrupting")
    if crit.get("islanding") and s.opts["kind"] == "der":
        sec = s.sections.get(bus)
        if sec is not None and sec["sectionLoadKw"] > 0:
            min_load = sec["sectionLoadKw"] * s.level.loadmult
            if kw / min_load > float(s.opts["islandingRatio"]):
                out.append("islanding")
    if crit.get("deviation") and s.opts["kind"] == "der":
        # Trip the unit and see how far the voltages move.
        s.set_unit(None, 0.0)
        if s.solve(hour):
            v2 = s.voltages()
            lim = float(s.opts["deviationPct"]) / 100.0
            if any(
                abs(v[b][1] - v2[b][1]) > lim or abs(v[b][0] - v2[b][0]) > lim
                for b in v
                if b in v2 and v2[b][0] > 0.05
            ):
                out.append("deviation")
        s.set_unit(bus, kw)
    return out


def _fault_increase(s: _Session, base: _Base, bus: str, kw: float) -> dict[str, float | None]:
    """The unit's fault contribution as a share of the base fault current at
    its bus, and the worst interrupting duty it produces: contribution
    1.2 x rated current for an inverter, 5 x for a synchronous machine."""
    i_base = base.fault.get(bus)
    if not i_base or kw <= 0:
        return {"pct": None, "dutyPct": None}
    phases = s.bus_phases.get(bus, 3)
    kv_ln = s.bus_kv.get(bus, 7.2)
    pf = float(s.opts["pf"]) or 1.0
    kva = kw / abs(pf)
    i_rated = (
        kva * 1000.0 / (3 * kv_ln * 1000.0) if phases == 3 else kva * 1000.0 / (kv_ln * 1000.0)
    )
    k = 5.0 if s.opts["derType"] == "synchronous" else 1.2
    contribution = k * i_rated
    pct = 100.0 * contribution / i_base
    duty = None
    for full, dev_bus, ka in s.devices:
        base_at = base.fault.get(dev_bus)
        if not base_at or full in base.over_duty:
            continue
        # The contribution reaching a device upstream is at most the unit's
        # own current; downstream devices see the source side unchanged.
        total = base_at + contribution
        d = 100.0 * total / (ka * 1000.0)
        duty = d if duty is None else max(duty, d)
    return {"pct": round(pct, 2), "dutyPct": round(duty, 1) if duty is not None else None}


def _bisect(s: _Session, base: _Base, bus: str, hour: int | None) -> dict[str, Any]:
    tol = max(float(s.opts["toleranceKw"]), 0.1)
    cap = float(s.opts["maxKw"])
    # Does the base case already fail? Then there is no room.
    first = _violations(s, base, bus, tol, hour)
    if first is None or first:
        out = _result(s, bus, 0.0, first or ["notConverged"], {}, base)
        out["where"] = s.where.get(first[0]) if first else None
        return out
    lo, hi = tol, min(2 * tol * 16, cap)
    binding: list[str] = []
    where: dict[str, Any] = {}
    # Grow until something binds (or the cap is reached).
    while True:
        viol = _violations(s, base, bus, hi, hour)
        if viol is None or viol:
            binding = viol or ["notConverged"]
            where = dict(s.where)
            break
        lo = hi
        if hi >= cap:
            return _result(s, bus, cap, ["none"], {}, base, capped=True)
        hi = min(hi * 2, cap)
    # Bisect between the last feasible and the first infeasible.
    while hi - lo > tol:
        mid = (lo + hi) / 2
        viol = _violations(s, base, bus, mid, hour)
        if viol is None or viol:
            hi = mid
            binding = viol or ["notConverged"]
            where = dict(s.where)
        else:
            lo = mid
    out = _result(s, bus, lo, binding, {}, base)
    out["where"] = where.get(binding[0]) if binding else None
    return out


def _sensitivity(s: _Session, base: _Base, bus: str, hour: int | None) -> dict[str, Any]:
    """Linear extrapolation from one perturbation, confirmed by a solve."""
    dp = float(s.opts["perturbKw"])
    sign = 1.0  # generation raises voltage; the load kind lowers it
    s.set_unit(bus, dp)
    if not s.solve(hour):
        return _result(s, bus, 0.0, ["notConverged"], {}, base)
    v1 = s.voltages()
    l1 = s.loading()
    reg1 = s.regulator_flows()
    exp1 = s.substation_export_kw()
    by: dict[str, float | None] = {}
    crit = s.opts["criteria"]
    cap = float(s.opts["maxKw"])
    if crit.get("voltage"):
        est = cap
        for b, (lo0, hi0) in base.voltages.items():
            if b not in v1:
                continue
            if s.opts["kind"] == "der":
                if b in base.over_v:
                    continue
                slope = (v1[b][1] - hi0) / dp
                if slope > 1e-9:
                    est = min(est, (s.vmax - hi0) / slope)
            else:
                if b in base.under_v or lo0 < 0.05:
                    continue
                slope = (v1[b][0] - lo0) / dp
                if slope < -1e-9:
                    est = min(est, (s.vmin - lo0) / slope)
        by["voltage"] = max(0.0, est)
    if crit.get("thermal"):
        est = cap
        limit = float(s.opts["thermalPct"])
        for n, pct0 in base.loading.items():
            if n in base.over_loaded or n not in l1:
                continue
            slope = (l1[n] - pct0) / dp
            if slope > 1e-9:
                est = min(est, (limit - pct0) / slope)
            elif slope < -1e-9:
                # Loading falls first (the unit offsets the flow), then
                # rises again as the flow reverses: |pct0 + slope*P| = limit.
                est = min(est, (-limit - pct0) / slope)
        by["thermal"] = max(0.0, est)
    if crit.get("deviation") and s.opts["kind"] == "der":
        est = cap
        lim = float(s.opts["deviationPct"]) / 100.0
        for b, (lo0, hi0) in base.voltages.items():
            if b in v1 and lo0 > 0.05:
                slope = max(abs(v1[b][1] - hi0), abs(v1[b][0] - lo0)) / dp
                if slope > 1e-12:
                    est = min(est, lim / slope)
        by["deviation"] = max(0.0, est)
    if crit.get("regulatorReverse") and s.opts["kind"] == "der":
        est = cap
        thr = -float(s.opts["regulatorReverseKw"])
        for n, kw0 in base.reg_flows.items():
            if n in base.reversed or n not in reg1:
                continue
            slope = (reg1[n] - kw0) / dp
            if slope < -1e-9:
                est = min(est, (thr - kw0) / slope)
        by["regulatorReverse"] = max(0.0, est)
    if crit.get("substationReverse") and s.opts["kind"] == "der":
        slope = (exp1 - base.export_kw) / dp
        thr = float(s.opts["substationExportKw"])
        by["substationReverse"] = max(0.0, (thr - base.export_kw) / slope) if slope > 1e-9 else cap
    if (
        (crit.get("faultCurrent") or crit.get("interrupting"))
        and base.fault.get(bus)
        and s.opts["kind"] == "der"
    ):
        # Linear in kW by construction.
        probe = _fault_increase(s, base, bus, dp)
        if crit.get("faultCurrent") and probe["pct"]:
            by["faultCurrent"] = dp * float(s.opts["faultIncreasePct"]) / probe["pct"]
        if crit.get("interrupting") and probe["dutyPct"] is not None:
            base_duty = _fault_increase(s, base, bus, 1e-6)["dutyPct"] or 0.0
            per_kw = (probe["dutyPct"] - base_duty) / dp
            if per_kw > 1e-12:
                by["interrupting"] = max(
                    0.0, (float(s.opts["interruptingPct"]) - base_duty) / per_kw
                )
    if crit.get("islanding") and s.opts["kind"] == "der":
        sec = s.sections.get(bus)
        if sec is not None and sec["sectionLoadKw"] > 0:
            by["islanding"] = (
                sec["sectionLoadKw"] * s.level.loadmult * float(s.opts["islandingRatio"])
            )
    del sign
    by = {k: (min(v, cap) if v is not None else None) for k, v in by.items()}
    estimates = {k: v for k, v in by.items() if v is not None}
    if not estimates:
        return _result(s, bus, cap, ["none"], by, base, capped=True)
    binding = min(estimates, key=lambda k: estimates[k])
    est = min(cap, estimates[binding])
    # Confirm, and tighten with a few secant steps if the linear guess was
    # optimistic (controls and voltage-dependent loads bend the line).
    lo, hi = 0.0, est
    viol = _violations(s, base, bus, est, hour)
    if viol is None or viol:
        binding = (viol or ["notConverged"])[0]
        for _ in range(4):
            mid = (lo + hi) / 2
            v = _violations(s, base, bus, mid, hour)
            if v is None or v:
                hi = mid
            else:
                lo = mid
        est = lo
    return _result(s, bus, est, [binding], by, base, capped=est >= cap)


def _result(
    s: _Session,
    bus: str,
    kw: float,
    binding: list[str],
    by: dict[str, float | None],
    base: _Base,
    capped: bool = False,
) -> dict[str, Any]:
    phases = s.bus_phases.get(bus, 3)
    kv_ln = s.bus_kv.get(bus, 0.0)
    return {
        "kw": round(kw, 1),
        "binding": binding[0] if binding else None,
        "violations": binding,
        "byCriterion": {k: (round(v, 1) if v is not None else None) for k, v in by.items()},
        "capped": capped,
        "kvBase": round(kv_ln * math.sqrt(3) if phases == 3 else kv_ln, 4),
        "phases": phases,
        "section": s.sections.get(bus, {}).get("section"),
        "sectionLoadKw": round(s.sections.get(bus, {}).get("sectionLoadKw", 0.0), 1),
        "baseFaultA": round(base.fault[bus], 1) if base.fault.get(bus) else None,
    }
