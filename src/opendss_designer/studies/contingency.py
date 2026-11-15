"""Contingency and switching: what happens when a device is lost, which
tie restores the most, and how much a tie can carry.

* `switching_sequence` -- a list of open/close steps applied one after
  another, each solved, so a restoration plan can be read step by step.
* `n_minus_1` -- every sectionalising device (or every transformer and
  line, if asked) taken out in turn; the load left dark; the normally-open
  tie that restores the most of it within the criteria; the worst voltage
  and loading while it does; ranked by what cannot be restored.
* `transfer_capability` -- for a tie, how much load each side can carry
  for the other at the active level's rating before a criterion binds: the
  load hosting loop of the hosting-capacity study, at a tie.

A tie switch is a breaker drawn normally open with *Tie switch* ticked
(`tie: true`); any normally-open breaker is also offered when none is
marked. Everything runs on one build of the circuit with `open`/`close`
and `enabled` edits between solves, so a feeder with a hundred devices is
a few hundred solves.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import CompileResult, compile_circuit
from ..core.model import Circuit, Issue, in_service
from ..core.validate import limit_issues
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

SWITCHES = ("breaker", "fuse", "recloser", "relay")


class _Net:
    """The built circuit: names, buses, loads, and how to take things out."""

    def __init__(self, circuit: Circuit, compiled: CompileResult) -> None:
        self.circuit = circuit
        self.compiled = compiled
        self.conn = compiled.connectivity
        self.limits = circuit.criteria
        self.level = circuit.level
        self.full_of: dict[str, str] = {}
        for full, ref in compiled.element_map.items():
            if full.startswith(("line.", "transformer.")) and ref not in self.full_of:
                self.full_of[ref] = full
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        self.slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            self.slices.setdefault(node.split(".", 1)[0], []).append(idx)
        self.pd_names = [n.lower() for n in dss.PDElements.AllNames()]
        # Rated load (at the level's multiplier) on each bus.
        self.load_kw: dict[str, float] = {}
        self.load_ids: dict[str, list[str]] = {}
        for n in circuit.nodes:
            if (
                n.type == "load"
                and in_service(n.params)
                and self.conn
                and n.id in self.conn.node_buses
            ):
                bus = self.conn.node_buses[n.id][0].lower()
                try:
                    kw = float(n.params.get("kw", 100.0))
                except (TypeError, ValueError):
                    kw = 100.0
                self.load_kw[bus] = self.load_kw.get(bus, 0.0) + kw * self.level.loadmult
                self.load_ids.setdefault(bus, []).append(n.id)
        self.total_load = sum(self.load_kw.values())
        self.solves = 0

    def solve(self) -> bool:
        dss.Solution.Solve()
        self.solves += 1
        return bool(dss.Solution.Converged())

    def voltages(self) -> dict[str, tuple[float, float]]:
        # Read by node name every time: taking an element out of service
        # makes the engine rebuild its bus list on the next solve, and a bus
        # nothing live reaches any more leaves the list altogether. The
        # base-case node indices went stale that way (a dead-end bus behind
        # an opened line put an N-1 run over the end of the list), and a bus
        # that is gone is a dark bus.
        names = dss.Circuit.AllNodeNames()
        mags = dss.Circuit.AllBusMagPu()
        seen: dict[str, tuple[float, float]] = {}
        for node, mag in zip(names, mags, strict=False):
            b = node.split(".", 1)[0]
            lo, hi = seen.get(b, (math.inf, -math.inf))
            seen[b] = (min(lo, mag), max(hi, mag))
        return {b: seen.get(b, (0.0, 0.0)) for b in self.slices}

    def loading(self) -> dict[str, float]:
        pct = (
            dss.PDElements.AllPctEmerg(False)
            if self.level.rating == "emergency"
            else dss.PDElements.AllPctNorm(False)
        )
        return {n: float(v) for n, v in zip(self.pd_names, pct, strict=False)}

    def dark_buses(self, v: dict[str, tuple[float, float]]) -> set[str]:
        return {b for b, (lo, hi) in v.items() if hi < 0.05}

    def unserved_kw(self, dark: set[str]) -> float:
        return sum(self.load_kw.get(b, 0.0) for b in dark)

    def state(self, full: str, closed: bool) -> None:
        """Open or close a switch, or take a line or transformer out."""
        if full in self.switch_fulls:
            dss.Text.Command(f"{'close' if closed else 'open'} {full} term=1")
        else:
            dss.Text.Command(f"{full}.enabled={'yes' if closed else 'no'}")

    @property
    def switch_fulls(self) -> set[str]:
        return {
            self.full_of[n.id]
            for n in self.circuit.nodes
            if n.type in SWITCHES and n.id in self.full_of
        }

    def summary(
        self, v: dict[str, tuple[float, float]], loading: dict[str, float], exclude_dark: set[str]
    ) -> dict[str, Any]:
        live = {b: lohi for b, lohi in v.items() if b not in exclude_dark and lohi[0] > 0.05}
        vmin = min(((lo, b) for b, (lo, hi) in live.items()), default=(None, None))
        vmax = max(((hi, b) for b, (lo, hi) in live.items()), default=(None, None))
        worst = max(((pct, n) for n, pct in loading.items()), default=(None, None))
        under = sum(1 for lo, hi in live.values() if lo < self.limits.vminPu)
        over = sum(1 for lo, hi in live.values() if hi > self.limits.vmaxPu)
        overloads = sum(1 for pct in loading.values() if pct >= self.limits.overloadPct)
        return {
            "minVpu": round(vmin[0], 4) if vmin[0] is not None else None,
            "minVBus": vmin[1],
            "maxVpu": round(vmax[0], 4) if vmax[0] is not None else None,
            "maxVBus": vmax[1],
            "maxLoadingPct": round(worst[0], 1) if worst[0] is not None else None,
            "maxLoadingElement": worst[1],
            "undervoltages": under,
            "overvoltages": over,
            "overloads": overloads,
            "violations": under + over + overloads,
        }


def _build(circuit: Circuit):
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return compiled, issues, False
    engine._ensure_init()
    engine._write_aux_files(compiled)
    ok = engine._run_commands(
        compiled.commands, compiled.element_map, issues, compiled.optional_commands
    )
    if ok:
        dss.Text.Command("set mode=snapshot")
    return compiled, issues, ok


def ties_of(circuit: Circuit) -> list[str]:
    """Node ids of the tie switches: breakers marked `tie`, else every
    normally-open breaker."""
    marked = [
        n.id
        for n in circuit.nodes
        if n.type == "breaker" and n.params.get("tie") is True and in_service(n.params)
    ]
    if marked:
        return marked
    return [
        n.id
        for n in circuit.nodes
        if n.type == "breaker" and not n.params.get("closed", True) and in_service(n.params)
    ]


def _name(circuit: Circuit, node_id: str) -> str:
    for n in circuit.nodes:
        if n.id == node_id:
            return str(n.params.get("name") or node_id)
    for e in circuit.edges:
        if e.id == node_id:
            return str(e.params.get("name") or node_id)
    return node_id


# --- switching sequence -----------------------------------------------------------


def switching_sequence(circuit: Circuit, steps: list[dict[str, Any]]) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _switching_sequence(circuit, steps)


@engine.on_engine_thread
def _switching_sequence(circuit: Circuit, steps: list[dict[str, Any]]) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "steps": []}
        net = _Net(circuit, compiled)
        out: list[dict[str, Any]] = []
        if not net.solve():
            issues.append(
                Issue(
                    severity="error",
                    code="not-converged",
                    message="The base case does not converge.",
                )
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues], "steps": []}
        v = net.voltages()
        dark0 = net.dark_buses(v)
        out.append(
            {
                "step": 0,
                "action": "as drawn",
                **net.summary(v, net.loading(), dark0),
                "unservedKw": round(net.unserved_kw(dark0), 1),
                "darkBuses": len(dark0),
            }
        )
        for i, st in enumerate(steps, start=1):
            full = net.full_of.get(str(st.get("id")))
            closed = bool(st.get("closed", True))
            if full is None:
                out.append(
                    {"step": i, "action": f"unknown element {st.get('id')}", "skipped": True}
                )
                continue
            net.state(full, closed)
            conv = net.solve()
            v = net.voltages() if conv else {}
            dark = net.dark_buses(v) if conv else set()
            out.append(
                {
                    "step": i,
                    "id": st.get("id"),
                    "element": _name(circuit, str(st.get("id"))),
                    "action": f"{'close' if closed else 'open'} {_name(circuit, str(st.get('id')))}",  # noqa: E501
                    "converged": conv,
                    **(net.summary(v, net.loading(), dark) if conv else {}),
                    "unservedKw": round(net.unserved_kw(dark), 1) if conv else None,
                    "darkBuses": len(dark) if conv else None,
                }
            )
    return {
        "converged": True,
        "steps": out,
        "totalLoadKw": round(net.totalLoad if hasattr(net, "totalLoad") else net.total_load, 1),
        "solves": net.solves,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": compiled.connectivity.node_buses if compiled.connectivity else {},
    }


# --- N-1 ------------------------------------------------------------------------------

DEFAULT_N1_OPTIONS: dict[str, Any] = {
    # Which elements to take out: closed switches and protective devices
    # ("switches"), or those plus every transformer and line ("all").
    "candidates": "switches",
    # Tie switches to try; None = ties_of(circuit).
    "ties": None,
    # Count a restoration only when it brings no new violation.
    "requireClean": False,
}


def n_minus_1(
    circuit: Circuit,
    raw_options: dict[str, Any] | None = None,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    opts = dict(DEFAULT_N1_OPTIONS)
    opts.update({k: v for k, v in (raw_options or {}).items() if k in opts})
    circuit = effective_circuit(circuit)
    return _n_minus_1(circuit, opts, progress, cancel)


def estimate_n1_solves(circuit: Circuit, raw_options: dict[str, Any] | None = None) -> int:
    opts = dict(DEFAULT_N1_OPTIONS)
    opts.update({k: v for k, v in (raw_options or {}).items() if k in opts})
    n_dev = sum(1 for n in circuit.nodes if n.type in SWITCHES and n.params.get("closed", True))
    if opts["candidates"] == "all":
        n_dev += sum(1 for n in circuit.nodes if n.type in ("transformer", "regulator"))
        n_dev += sum(1 for e in circuit.edges if e.type == "line")
    ties = len(opts["ties"]) if opts["ties"] else len(ties_of(circuit))
    return 1 + n_dev * (1 + ties)


@engine.on_engine_thread
def _n_minus_1(
    circuit: Circuit,
    opts: dict[str, Any],
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "cases": []}
        net = _Net(circuit, compiled)
        if not net.solve():
            issues.append(
                Issue(
                    severity="error",
                    code="not-converged",
                    message="The base case does not converge.",
                )
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues], "cases": []}
        base_v = net.voltages()
        base_dark = net.dark_buses(base_v)
        base = net.summary(base_v, net.loading(), base_dark)
        tie_ids = list(opts["ties"]) if opts["ties"] else ties_of(circuit)
        ties = [(t, net.full_of[t]) for t in tie_ids if t in net.full_of]
        candidates: list[tuple[str, str, str]] = []  # (id, full, kind)
        for n in circuit.nodes:
            if n.id in net.full_of and in_service(n.params):
                if n.type in SWITCHES and n.params.get("closed", True) and n.id not in tie_ids:
                    candidates.append((n.id, net.full_of[n.id], n.type))
                elif opts["candidates"] == "all" and n.type in ("transformer", "regulator"):
                    candidates.append((n.id, net.full_of[n.id], n.type))
        if opts["candidates"] == "all":
            for e in circuit.edges:
                if e.type == "line" and e.id in net.full_of and in_service(e.params):
                    candidates.append((e.id, net.full_of[e.id], "line"))
        cases: list[dict[str, Any]] = []
        cancelled = False
        total = len(candidates)
        for i, (cid, full, kind) in enumerate(candidates):
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            net.state(full, False)
            conv = net.solve()
            case: dict[str, Any] = {
                "id": cid,
                "element": _name(circuit, cid),
                "kind": kind,
                "converged": conv,
            }
            if conv:
                v = net.voltages()
                dark = net.dark_buses(v) - base_dark
                lost = net.unserved_kw(dark)
                case.update(
                    {
                        "unservedKw": round(lost, 1),
                        "darkBuses": len(dark),
                        "noAction": net.summary(v, net.loading(), dark | base_dark),
                    }
                )
                best: dict[str, Any] | None = None
                if lost > 0.5:
                    for tid, tfull in ties:
                        net.state(tfull, True)
                        tconv = net.solve()
                        if tconv:
                            tv = net.voltages()
                            tdark = net.dark_buses(tv) - base_dark
                            restored = lost - net.unserved_kw(tdark)
                            summ = net.summary(tv, net.loading(), tdark | base_dark)
                            new_viol = max(0, summ["violations"] - base["violations"])
                            cand = {
                                "tie": tid,
                                "tieName": _name(circuit, tid),
                                "restoredKw": round(restored, 1),
                                "remainingUnservedKw": round(lost - restored, 1),
                                "newViolations": new_viol,
                                **summ,
                            }
                            acceptable = restored > 0.5 and (
                                not opts["requireClean"] or new_viol == 0
                            )
                            if acceptable and (
                                best is None
                                or (
                                    cand["restoredKw"],
                                    -cand["newViolations"],
                                    -(cand["maxLoadingPct"] or 0),
                                )
                                > (
                                    best["restoredKw"],
                                    -best["newViolations"],
                                    -(best["maxLoadingPct"] or 0),
                                )
                            ):
                                best = cand
                        net.state(tfull, False)
                case["bestTie"] = best
                case["remainingUnservedKw"] = (
                    round(best["remainingUnservedKw"], 1) if best else round(lost, 1)
                )
            else:
                case.update({"unservedKw": None, "remainingUnservedKw": None, "bestTie": None})
            net.state(full, True)
            cases.append(case)
            if progress is not None and (i % max(1, total // 100) == 0 or i == total - 1):
                progress(i + 1, total, _name(circuit, cid))
        # Back to the base state, which the edits above already restored.
        net.solve()
    cases.sort(key=lambda c: (-(c["remainingUnservedKw"] or 0), -(c["unservedKw"] or 0)))
    restorable = sum(1 for c in cases if c.get("bestTie"))
    return {
        "converged": True,
        "cancelled": cancelled,
        "base": {**base, "totalLoadKw": round(net.total_load, 1), "darkBuses": len(base_dark)},
        "ties": [{"id": t, "name": _name(circuit, t)} for t, _ in ties],
        "cases": cases,
        "summary": {
            "candidates": len(candidates),
            "evaluated": len(cases),
            "withLostLoad": sum(1 for c in cases if (c.get("unservedKw") or 0) > 0.5),
            "restorable": restorable,
            "solves": net.solves,
        },
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": compiled.connectivity.node_buses if compiled.connectivity else {},
    }


# --- transfer capability -----------------------------------------------------------


def transfer_capability(
    circuit: Circuit, tie_id: str, tolerance_kw: float = 10.0
) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _transfer_capability(circuit, tie_id, float(tolerance_kw))


def _upstream_device(net: _Net, start_bus: str, exclude: str) -> str | None:
    """The first closed switch or protective device met walking from
    `start_bus` toward a source over conducting elements, other than
    `exclude`: the point that isolates the tie's side from its own feed."""
    circuit, conn = net.circuit, net.conn
    if conn is None:
        return None
    adjacency: dict[str, list[tuple[str, str | None]]] = {}
    for n in circuit.nodes:
        if n.type in ("transformer", "regulator", *SWITCHES) and n.id != exclude:
            if n.type in SWITCHES and not n.params.get("closed", True):
                continue
            if not in_service(n.params):
                continue
            buses = [b.lower() for b in conn.node_buses.get(n.id, [])]
            dev = n.id if n.type in SWITCHES else None
            for a in buses:
                for b in buses:
                    if a != b:
                        adjacency.setdefault(a, []).append((b, dev))
    for _eid, (b1, b2) in conn.line_buses.items():
        adjacency.setdefault(b1.lower(), []).append((b2.lower(), None))
        adjacency.setdefault(b2.lower(), []).append((b1.lower(), None))
    sources = {
        conn.node_buses[n.id][0].lower()
        for n in circuit.nodes
        if n.type == "vsource" and n.id in conn.node_buses
    }
    # BFS from the start; remember the last device on each path.
    queue = [(start_bus, None)]
    seen = {start_bus}
    first_device: dict[str, str | None] = {start_bus: None}
    while queue:
        bus, dev = queue.pop(0)
        if bus in sources:
            return first_device[bus]
        for nb, d in adjacency.get(bus, ()):
            if nb in seen:
                continue
            seen.add(nb)
            first_device[nb] = d if d is not None else dev
            queue.append((nb, first_device[nb]))
    return None


@engine.on_engine_thread
def _transfer_capability(circuit: Circuit, tie_id: str, tol: float) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {
                "converged": False,
                "issues": [i.model_dump() for i in issues],
                "directions": [],
            }
        net = _Net(circuit, compiled)
        if tie_id not in net.full_of or net.conn is None:
            issues.append(
                Issue(
                    severity="error",
                    code="no-such-tie",
                    message="The tie switch is not on the drawing.",
                )
            )
            return {
                "converged": False,
                "issues": [i.model_dump() for i in issues],
                "directions": [],
            }
        tie_full = net.full_of[tie_id]
        tie_buses = [b.lower() for b in net.conn.node_buses.get(tie_id, [])]
        if not net.solve():
            issues.append(
                Issue(
                    severity="error",
                    code="not-converged",
                    message="The base case does not converge.",
                )
            )
            return {
                "converged": False,
                "issues": [i.model_dump() for i in issues],
                "directions": [],
            }
        directions: list[dict[str, Any]] = []
        for side_bus in tie_buses[:2]:
            device = _upstream_device(net, side_bus, tie_id)
            entry: dict[str, Any] = {
                "sideBus": side_bus,
                "isolatingDevice": device,
                "isolatingName": _name(circuit, device) if device else None,
            }
            if device is None or device not in net.full_of:
                entry.update(
                    {"kw": None, "note": "no switch between this side and its source to isolate it"}
                )
                directions.append(entry)
                continue
            # Isolate the side, see what goes dark: that is the transferred load.
            net.state(net.full_of[device], False)
            net.solve()
            dark = net.dark_buses(net.voltages())
            loads = [lid for b in dark for lid in net.load_ids.get(b, [])]
            base_kw = sum(net.load_kw.get(b, 0.0) for b in dark)
            entry.update({"transferredLoadKw": round(base_kw, 1), "transferredLoads": len(loads)})
            if not loads:
                net.state(net.full_of[device], True)
                entry.update({"kw": 0.0, "note": "nothing is left dark when this side is isolated"})
                directions.append(entry)
                continue
            net.state(tie_full, True)
            load_fulls = [
                f
                for f, ref in compiled.element_map.items()
                if ref in set(loads) and f.startswith("load.")
            ]
            rated: dict[str, float] = {}
            for f in load_fulls:
                dss.Circuit.SetActiveElement(f)
                rated[f] = float(dss.Properties.Value("kw") or 0)

            def feasible(mult: float, rated=rated) -> bool | None:
                for f, kw in rated.items():
                    dss.Text.Command(f"{f}.kw={kw * mult:.6g}")
                if not net.solve():
                    return None
                v = net.voltages()
                live = {b: lohi for b, lohi in v.items() if lohi[0] > 0.05}
                if any(lo < net.limits.vminPu for lo, hi in live.values()):
                    return False
                if any(pct >= net.limits.overloadPct for pct in net.loading().values()):
                    return False
                return True

            binding = None
            if feasible(1.0) is not True:
                # Even the load as it stands cannot be carried.
                lo, hi = 0.0, 1.0
            else:
                lo, hi = 1.0, 2.0
                while feasible(hi) is True and hi < 64:
                    lo, hi = hi, hi * 2
            while (hi - lo) * base_kw > tol:
                mid = (lo + hi) / 2
                if feasible(mid) is True:
                    lo = mid
                else:
                    hi = mid
            feasible(lo)
            v = net.voltages()
            summ = net.summary(v, net.loading(), set())
            for f, kw in rated.items():
                dss.Text.Command(f"{f}.kw={kw:.6g}")
            net.state(tie_full, False)
            net.state(net.full_of[device], True)
            net.solve()
            entry.update(
                {
                    "kw": round(lo * base_kw, 1),
                    "multiplier": round(lo, 3),
                    "carriesPresentLoad": lo >= 1.0,
                    "binding": binding,
                    **summ,
                }
            )
            directions.append(entry)
    return {
        "converged": True,
        "tie": tie_id,
        "tieName": _name(circuit, tie_id),
        "directions": directions,
        "loadLevel": circuit.level.model_dump(),
        "solves": net.solves,
        "issues": [i.model_dump() for i in issues],
    }
