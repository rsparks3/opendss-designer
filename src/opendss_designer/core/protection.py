"""Time-current curves for the protective devices in a circuit.

The curves are read out of the engine's own `TCC_Curve` objects rather than
kept as tables here, so what the plot shows is what the solve would use. Each
one is scaled by its device's pickup, which turns "multiples of pickup vs
seconds" into the amps-and-seconds a coordination plot is drawn in.
"""
from __future__ import annotations

import math
from typing import Any

import opendssdirect as dss

from .compiler import CompileResult, compile_circuit
from .connectivity import synthesize
from .engine import (
    SHAPE_DIR,
    _ensure_init,
    _run_commands,
    _write_aux_files,
    dss_guard,
    on_engine_thread,
    quiet_for_fault_study,
)
from .model import Circuit, Issue
from .validate import limit_issues

_BUILTIN_CACHE: dict[str, list[list[float]]] | None = None


def _curve_points(name: str) -> list[list[float]]:
    mult = _num_array(f"tcc_curve.{name}.c_array")
    secs = _num_array(f"tcc_curve.{name}.t_array")
    n = min(len(mult), len(secs))
    return [[mult[i], secs[i]] for i in range(n)]


def loaded_curve_names() -> list[str]:
    """Every TCC curve the engine currently holds — its own, plus any the
    circuit just defined. Not the same as the built-in set."""
    dss.Text.Command("select tcc_curve.tlink")
    return [str(n).lower() for n in dss.ActiveClass.AllNames()]


@on_engine_thread
def builtin_curves() -> dict[str, Any]:
    """The engine's own curves and their points, for the curve picker.

    Read once from a scratch circuit and cached: they are compiled into the
    engine and never change while it is running.
    """
    global _BUILTIN_CACHE
    if _BUILTIN_CACHE is None:
        with dss_guard():
            _ensure_init()
            dss.Text.Command("clear")
            dss.Text.Command("new circuit.curvelist basekv=12.47 pu=1.0 "
                             "phases=3 bus1=b1 mvasc3=2000")
            # Read from a scratch circuit, so nothing user-defined is loaded
            # and this really is the built-in set.
            _BUILTIN_CACHE = {n: _curve_points(n) for n in loaded_curve_names()}
    return {"curves": [{"name": n, "points": pts, "builtin": True}
                       for n, pts in _BUILTIN_CACHE.items()]}


def _num_array(query: str) -> list[float]:
    dss.Text.Command(f"? {query}")
    raw = dss.Text.Result().strip().strip("[]")
    out: list[float] = []
    for tok in raw.split():
        try:
            out.append(float(tok))
        except ValueError:
            continue
    return out


def _prop(full_name: str, prop: str) -> str:
    """One property off an element by name, for the ones the typed API does
    not expose (recloser curve names, everything on a relay)."""
    dss.Text.Command(f"? {full_name}.{prop}")
    return dss.Text.Result().strip()


def _prop_float(full_name: str, prop: str, default: float = 0.0) -> float:
    try:
        return float(_prop(full_name, prop))
    except (TypeError, ValueError):
        return default


def _curve_trace(label: str, curve: str, pickup: float, delay: float,
                 fault: str = "phase") -> dict[str, Any] | None:
    """One plottable trace in amps and seconds, or None when the device has no
    usable curve (no curve name, no pickup, or a curve with a single point).

    `fault` says which fault the trace answers to: a ground unit only sees the
    residual current of an unbalanced fault, so coordination reads the phase
    traces against a 3-phase fault and the ground traces against a 1-phase one.
    """
    if not curve or curve == "none" or pickup <= 0:
        return None
    mult = _num_array(f"tcc_curve.{curve}.c_array")
    secs = _num_array(f"tcc_curve.{curve}.t_array")
    n = min(len(mult), len(secs))
    if n < 2:
        return None
    return {
        "label": label,
        "curve": curve,
        "fault": fault,
        "pickupA": round(pickup, 2),
        "points": [[round(mult[i] * pickup, 2), round(secs[i] + delay, 5)]
                   for i in range(n)],
    }


def _fault_currents(bus: str) -> tuple[float | None, float | None]:
    """Prospective 3-phase and single-phase fault current at a bus, from the
    Thevenin impedances a fault-study solve leaves behind."""
    dss.Circuit.SetActiveBus(bus)
    v_ln = dss.Bus.kVBase() * 1000.0
    z1_raw, z0_raw = dss.Bus.Zsc1(), dss.Bus.Zsc0()
    z1 = complex(float(z1_raw[0]), float(z1_raw[1]))
    z0 = complex(float(z0_raw[0]), float(z0_raw[1]))
    loop = 2 * z1 + z0
    if3 = v_ln / abs(z1) if abs(z1) > 1e-9 else None
    if1 = 3 * v_ln / abs(loop) if abs(loop) > 1e-9 else None
    return (round(if3, 1) if if3 else None, round(if1, 1) if if1 else None)


def _switch_of(raw: str) -> str | None:
    name = str(raw)
    return name.split(".", 1)[1].lower() if name.lower().startswith("line.") else None


def _device(kind: str, name: str, switch: str | None,
            element_map: dict[str, str]) -> dict[str, Any] | None:
    if not switch:
        return None
    dss.Circuit.SetActiveElement(f"line.{switch}")
    buses = dss.CktElement.BusNames()
    return {
        "nodeId": element_map.get(f"line.{switch}"),
        "name": name,
        "kind": kind,
        "switch": switch,
        # Bus 2 is downstream of the device, so a fault there is the one it is
        # there to clear.
        "bus": str(buses[1]).split(".", 1)[0].lower() if len(buses) > 1 else None,
        "traces": [],
    }


def _read_devices(element_map: dict[str, str]) -> list[dict[str, Any]]:
    """Every protective device in the built circuit, with its curves in amps."""
    devices: list[dict[str, Any]] = []

    i = dss.Fuses.First()
    while i:
        name = dss.Fuses.Name()
        dev = _device("fuse", name, _switch_of(dss.Fuses.SwitchedObj()), element_map)
        if dev:
            curve = str(dss.Fuses.TCCCurve()).lower()
            trace = _curve_trace(f"{name} ({curve})", curve,
                                 dss.Fuses.RatedCurrent(), dss.Fuses.Delay())
            if trace:
                dev["traces"].append(trace)
                devices.append(dev)
        i = dss.Fuses.Next()

    i = dss.Reclosers.First()
    while i:
        name = dss.Reclosers.Name()
        full = f"recloser.{name}"
        dev = _device("recloser", name, _switch_of(dss.Reclosers.SwitchedObj()),
                      element_map)
        if dev:
            delay = _prop_float(full, "delay")
            phase_pickup = dss.Reclosers.PhaseTrip()
            ground_pickup = dss.Reclosers.GroundTrip()
            for label, prop, pickup, kind in (
                ("fast", "phasefast", phase_pickup, "phase"),
                ("delayed", "phasedelayed", phase_pickup, "phase"),
                ("ground fast", "groundfast", ground_pickup, "ground"),
                ("ground delayed", "grounddelayed", ground_pickup, "ground"),
            ):
                trace = _curve_trace(f"{name} {label}", _prop(full, prop).lower(),
                                     pickup, delay, kind)
                if trace:
                    dev["traces"].append(trace)
            if dev["traces"]:
                devices.append(dev)
        i = dss.Reclosers.Next()

    i = dss.Relays.First()
    while i:
        name = dss.Relays.Name()
        full = f"relay.{name}"
        dev = _device("relay", name, _switch_of(dss.Relays.SwitchedObj()), element_map)
        if dev and _prop(full, "type").lower().startswith("current"):
            delay = _prop_float(full, "delay")
            for label, curve_prop, trip_prop in (
                ("phase", "phasecurve", "phasetrip"),
                ("ground", "groundcurve", "groundtrip"),
            ):
                trace = _curve_trace(f"{name} {label}",
                                     _prop(full, curve_prop).lower(),
                                     _prop_float(full, trip_prop), delay, label)
                if trace:
                    dev["traces"].append(trace)
            if dev["traces"]:
                devices.append(dev)
        i = dss.Relays.Next()

    return devices


SWITCH_TYPES = ("breaker", "fuse", "recloser", "relay")


def _read_switches(circuit: Circuit,
                   compiled: CompileResult) -> list[dict[str, Any]]:
    """Every switch on the diagram with the fault current it would have to
    break. A breaker has no curve, so it never appears in the plot — but it is
    still a device that has to interrupt what the fault study says is there.
    """
    conn = compiled.connectivity
    if conn is None:
        return []
    out: list[dict[str, Any]] = []
    for node in circuit.nodes:
        if node.type not in SWITCH_TYPES:
            continue
        buses = conn.node_buses.get(node.id, [])
        if len(buses) < 2:
            continue
        bus = buses[1]
        if3, if1 = _fault_currents(bus)
        rating = node.params.get("interruptingka")
        out.append({
            "nodeId": node.id,
            "name": str(node.params.get("name") or node.id),
            "kind": node.type,
            "bus": bus,
            "faultA3ph": if3,
            "faultA1ph": if1,
            "interruptingKa": float(rating) if rating not in (None, "") else None,
        })
    return out


def _upstream_chain(circuit: Circuit, devices: list[dict[str, Any]]) -> dict[str, list[str]]:
    """For each device, the devices between it and the source, nearest last.

    Walks the bus graph outward from the source through everything that carries
    power, noting which protective devices each path passes through. A device
    is 'upstream' of another when it sits on the path from the source to it,
    which is exactly the pairing a coordination study looks at.
    """
    conn = synthesize(circuit)
    by_node = {n.id: n for n in circuit.nodes}
    device_by_node = {d["nodeId"]: d for d in devices if d["nodeId"]}

    # Bus -> list of (other bus, device name or None) for everything that
    # conducts between two buses.
    links: dict[str, list[tuple[str, str | None]]] = {}

    def link(a: str, b: str, device: str | None) -> None:
        links.setdefault(a, []).append((b, device))
        links.setdefault(b, []).append((a, device))

    for edge in circuit.edges:
        if edge.type == "line" and edge.id in conn.line_buses:
            a, b = conn.line_buses[edge.id]
            link(a, b, None)
    for node in circuit.nodes:
        buses = conn.node_buses.get(node.id, [])
        if len(buses) < 2:
            continue
        dev = device_by_node.get(node.id)
        if dev is None and node.type in ("breaker", "fuse", "recloser", "relay"):
            # An open switch with no curve of its own still breaks the path.
            if not by_node[node.id].params.get("closed", True):
                continue
        link(buses[0], buses[1], dev["name"] if dev else None)

    sources = [conn.node_buses[n.id][0] for n in circuit.nodes
               if n.type == "vsource" and conn.node_buses.get(n.id)]
    seen: dict[str, list[str]] = {bus: [] for bus in sources}
    queue = list(sources)
    while queue:
        bus = queue.pop(0)
        for nxt, device in links.get(bus, ()):
            if nxt in seen:
                continue
            seen[nxt] = seen[bus] + ([device] if device else [])
            queue.append(nxt)

    # A device's own upstream chain is what the walk passed through to reach
    # the bus it feeds from, which is the chain minus the device itself.
    chains: dict[str, list[str]] = {}
    for dev in devices:
        chain = seen.get(dev["bus"] or "", [])
        chains[dev["name"]] = [name for name in chain if name != dev["name"]]
    return chains


# Downstream protection must clear a fault before the device above it starts to
# operate. A quarter of a second is the usual working margin for relays and
# reclosers; anything tighter is worth a second look by the engineer.
COORDINATION_MARGIN_S = 0.25

# Fuse pairs are graded by ratio rather than by a fixed margin: the protecting
# fuse must clear inside 75% of the time the fuse above it takes to melt, which
# leaves room for the melting one to not be damaged. The tool has one curve per
# fuse (OpenDSS models the melt), so this compares melt to melt -- the standard
# rule compares the downstream fuse's total clearing time, which is the more
# demanding side of it.
FUSE_MELT_FRACTION = 0.75


def _operate_seconds(trace: dict[str, Any], amps: float) -> float | None:
    """Seconds to operate at a current, interpolated straight on log-log paper
    — the same reading the plot gives, and flat past the last point."""
    pts = trace["points"]
    if not pts or amps < pts[0][0]:
        return None
    if amps >= pts[-1][0]:
        return float(pts[-1][1])
    for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
        if amps <= x1:
            if x1 == x0:
                return float(y1)
            f = ((math.log10(amps) - math.log10(x0))
                 / (math.log10(x1) - math.log10(x0)))
            return float(10 ** (math.log10(y0) + f * (math.log10(y1) - math.log10(y0))))
    return None


def _beyond_data(trace: dict[str, Any], amps: float) -> bool:
    """Is this current past the last point the curve actually defines?"""
    return bool(trace["points"]) and amps > trace["points"][-1][0]


def _fastest(device: dict[str, Any], amps: float,
             fault: str = "phase") -> tuple[str, float, bool] | None:
    """The trace that would operate first at this current, and when.

    For a ground fault the ground units answer, where a device has them. A fuse
    has none and does not need any: it carries whatever current flows through
    it, so its one curve serves both faults.
    """
    traces = [x for x in device["traces"] if x.get("fault", "phase") == fault]
    if not traces and fault == "ground" and device["kind"] == "fuse":
        traces = device["traces"]
    best: tuple[str, float, bool] | None = None
    for trace in traces:
        secs = _operate_seconds(trace, amps)
        if secs is not None and (best is None or secs < best[1]):
            best = (trace["label"], secs, _beyond_data(trace, amps))
    return best


def _graded(downstream: dict[str, Any], mine: tuple[str, float, bool],
            upstream: dict[str, Any], theirs: tuple[str, float, bool]) -> str | None:
    """Why this pair fails to grade, or None when it is fine.

    Two fuses are graded by ratio -- the one below must clear well inside the
    melting time of the one above -- and everything else by a fixed time margin.

    Past the end of a curve's data every curve runs flat, so two devices there
    appear to operate at exactly the same moment however different they are.
    That is the extrapolation talking, not the devices, so a pair is only
    judged while both are still on data. A fault that far out is already
    reported by the interrupting-duty check.
    """
    if mine[2] or theirs[2]:
        return None
    if downstream["kind"] == "fuse" and upstream["kind"] == "fuse":
        if mine[1] > theirs[1] * FUSE_MELT_FRACTION:
            pct = mine[1] / theirs[1] * 100 if theirs[1] else float("inf")
            return (f"{pct:.0f}% of the upstream fuse's melting time, past the "
                    f"{FUSE_MELT_FRACTION:.0%} a fuse pair is graded to, so the "
                    "upstream fuse may be damaged or blow with it")
        return None
    if theirs[1] - mine[1] < COORDINATION_MARGIN_S:
        return (f"less than the {COORDINATION_MARGIN_S:g} s margin, so the "
                "upstream device may clear the fault first and take out more "
                "of the feeder")
    return None


def _coordination_issues(devices: list[dict[str, Any]],
                         switches: list[dict[str, Any]],
                         chains: dict[str, list[str]]) -> list[Issue]:
    """What the curves say about the fault currents actually available.

    Everything is checked twice: phase units against the 3-phase fault, ground
    units against the 1-phase one. A pair can grade perfectly on phase and not
    on ground, which is exactly the case worth catching.
    """
    issues: list[Issue] = []
    by_name = {d["name"]: d for d in devices}

    for dev in devices:
        for fault_kind, current_key, label in (
            ("phase", "faultA3ph", "3φ"),
            ("ground", "faultA1ph", "1φ"),
        ):
            current = dev.get(current_key)
            if not current:
                continue
            traces = [x for x in dev["traces"] if x.get("fault", "phase") == fault_kind]
            if not traces and not (fault_kind == "ground" and dev["kind"] == "fuse"):
                # No ground unit at all is a modelling choice, not a defect:
                # plenty of feeders rely on the phase units for ground faults.
                continue

            mine = _fastest(dev, current, fault_kind)
            if mine is None:
                pickup = min(x["points"][0][0]
                             for x in (traces or dev["traces"]))
                issues.append(Issue(
                    severity="warning", code="pickup-above-fault",
                    message=(
                        f"{dev['kind'].title()} '{dev['name']}' picks up at "
                        f"{pickup:.0f} A on its {fault_kind} unit, but a {label} "
                        f"fault at {dev['bus']} draws only {current:.0f} A — it "
                        "would never trip for a fault it protects."),
                    nodeId=dev["nodeId"]))
                continue

            for upstream_name in chains.get(dev["name"], []):
                upstream = by_name.get(upstream_name)
                if upstream is None:
                    continue
                theirs = _fastest(upstream, current, fault_kind)
                if theirs is None:
                    continue
                why = _graded(dev, mine, upstream, theirs)
                if why:
                    issues.append(Issue(
                        severity="warning", code="miscoordination",
                        message=(
                            f"For a {label} fault at {dev['bus']} ({current:.0f} A), "
                            f"'{dev['name']}' ({mine[0]}) operates in {mine[1]:.3f} s "
                            f"and '{upstream_name}' ({theirs[0]}) above it in "
                            f"{theirs[1]:.3f} s — {why}."),
                        nodeId=dev["nodeId"]))

    # Every switch, protective or not, has to be able to break the fault it
    # could be asked to break. This is the check a breaker takes part in: it
    # has no curve, but it does have a rating.
    for sw in switches:
        fault = sw.get("faultA3ph")
        rating_ka = sw.get("interruptingKa")
        if not fault or not rating_ka:
            continue
        if fault > rating_ka * 1000.0:
            issues.append(Issue(
                severity="warning", code="interrupting-duty",
                message=(f"{sw['kind'].title()} '{sw['name']}' is rated to interrupt "
                         f"{rating_ka:g} kA, but a fault at {sw['bus']} draws "
                         f"{fault / 1000.0:.1f} kA."),
                nodeId=sw["nodeId"]))
    return issues


@on_engine_thread
def tcc_study(circuit: Circuit) -> dict[str, Any]:
    """Curves for every protective device, each with the fault current
    available where it would have to operate.

    The fault currents come from the same `mode=faultstudy` solve the Fault
    overlay uses, so the plot and the overlay always agree.
    """
    compiled: CompileResult = compile_circuit(circuit, shape_dir=SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "devices": [],
                "issues": [i.model_dump() for i in issues]}

    devices: list[dict[str, Any]] = []
    switches: list[dict[str, Any]] = []
    converged = False
    with dss_guard():
        _ensure_init()
        _write_aux_files(compiled)
        built = _run_commands(compiled.commands, compiled.element_map, issues)
        if built:
            devices = _read_devices(compiled.element_map)
            try:
                # Curves are read above, so the controls have served their
                # purpose here; see engine.quiet_for_fault_study for why they
                # do not go into the study itself.
                quiet_for_fault_study(compiled.element_map)
                dss.Text.Command("set mode=faultstudy")
                dss.Text.Command("solve")
                converged = True
            except Exception as exc:
                issues.append(Issue(severity="error", code="solve-failed",
                                    message=f"Fault study failed: {exc}"))
            if converged:
                for dev in devices:
                    if dev["bus"]:
                        if3, if1 = _fault_currents(dev["bus"])
                        dev["faultA3ph"] = if3
                        dev["faultA1ph"] = if1
                switches = _read_switches(circuit, compiled)
                issues.extend(_coordination_issues(
                    devices, switches, _upstream_chain(circuit, devices)))

    return {
        "converged": converged,
        "devices": devices,
        "switches": switches,
        "issues": [i.model_dump() for i in issues],
    }
