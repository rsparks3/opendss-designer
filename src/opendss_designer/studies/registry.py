"""The studies by name, for the command line and for scripts.

    from opendss_designer.studies import run_study, STUDIES
    result = run_study("hosting-capacity", circuit, {"method": "sensitivity"})

Every entry takes a `Circuit` and an options dict and returns the plain
dict the REST routes return. The desktop app and the `opendss-designer
run` command use this table, so a study added here is everywhere at once.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..core import engine, protection, qa, reliability
from ..core.model import Circuit
from . import (
    allocation,
    balancing,
    batch,
    capacity,
    contingency,
    faults,
    harmonics,
    hosting_capacity,
    protection_depth,
    screening,
    secondary,
    voltvar,
)

Study = Callable[[Circuit, dict[str, Any]], dict[str, Any]]


def _opt(options: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {k: options[k] for k in keys if k in options}


STUDIES: dict[str, tuple[str, Study]] = {
    "solve": ("Snapshot power flow at the active load level", lambda c, o: engine.solve(c)),
    "fault": (
        "Fault study (bolted three-phase and line-to-ground at every bus)",
        lambda c, o: engine.fault_study(c),
    ),
    "timeseries": (
        "Daily or yearly time series (mode, stepMin)",
        lambda c, o: engine.solve_timeseries(c, o.get("mode", "daily"), int(o.get("stepMin", 60))),
    ),
    "tcc": (
        "Protection: curves, fault currents, coordination",
        lambda c, o: protection.tcc_study(c),
    ),
    "reliability": (
        "SAIFI, SAIDI, CAIDI, MAIFI, ASAI, CEMI, ASIFI",
        lambda c, o: reliability.reliability_study(c),
    ),
    "qa": ("Model QA: completeness and findings", lambda c, o: qa.qa_report(c)),
    "batch": (
        "Every scenario at every load level",
        lambda c, o: batch.run_batch(c, o.get("scenarios"), o.get("levels")),
    ),
    "hosting-capacity": (
        "DER or load hosting capacity (see DEFAULT_OPTIONS)",
        lambda c, o: hosting_capacity.hosting_capacity(c, o),
    ),
    "screen": (
        "Interconnection screens for one DER (bus, kw, ...)",
        lambda c, o: screening.screen(c, o["bus"], o),
    ),
    "fault-point": (
        "One fault at a bus (bus, kind, rOhm)",
        lambda c, o: faults.fault_point(c, o["bus"], o.get("kind", "3ph"), float(o.get("rOhm", 0))),
    ),
    "fault-sweep": (
        "Maximum and minimum fault currents at every bus (rOhm)",
        lambda c, o: faults.fault_sweep(c, float(o.get("rOhm", 0))),
    ),
    "n-minus-1": (
        "N-1 contingency with tie restoration (candidates, ties)",
        lambda c, o: contingency.n_minus_1(c, o),
    ),
    "transfer": (
        "Transfer capability of a tie (tie)",
        lambda c, o: contingency.transfer_capability(c, o["tie"]),
    ),
    "switching": (
        "A switching sequence (steps)",
        lambda c, o: contingency.switching_sequence(c, o.get("steps", [])),
    ),
    "sweep": (
        "Volt/VAR setting sweep (sweeps, stepMin)",
        lambda c, o: voltvar.setting_sweep(c, o.get("sweeps", []), int(o.get("stepMin", 60))),
    ),
    "cvr": (
        "CVR evaluation (reductionV)",
        lambda c, o: voltvar.cvr(c, float(o.get("reductionV", 2.0))),
    ),
    "capacitor-placement": (
        "Capacitor placement (kvar, banks)",
        lambda c, o: voltvar.capacitor_placement(
            c, float(o.get("kvar", 600)), int(o.get("banks", 1))
        ),
    ),
    "phase-balance": (
        "Phase balance (maxCandidates)",
        lambda c, o: balancing.phase_balance(c, int(o.get("maxCandidates", 40))),
    ),
    "losses": (
        "Loss evaluation (mode, stepMin, pricePerKwh)",
        lambda c, o: capacity.loss_evaluation(
            c, o.get("mode", "daily"), int(o.get("stepMin", 60)), float(o.get("pricePerKwh", 0))
        ),
    ),
    "capacity": ("Feeder capacity multiplier", lambda c, o: capacity.capacity_search(c)),
    "transformer-loading": (
        "Service transformer loading and loss of life (mode, ambientC)",
        lambda c, o: secondary.transformer_loading(
            c, o.get("mode", "daily"), int(o.get("stepMin", 60)), float(o.get("ambientC", 30))
        ),
    ),
    "allocate": (
        "Load allocation (rows, options)",
        lambda c, o: allocation.allocate(c, o.get("rows", []), o.get("options")),
    ),
    "fault-line": (
        "A fault part way along a line (line, fraction, kind, rOhm)",
        lambda c, o: protection_depth.fault_on_line(
            c,
            o["line"],
            float(o.get("fraction", 0.5)),
            o.get("kind", "3ph"),
            float(o.get("rOhm", 0)),
        ),
    ),
    "reach": (
        "Protection reach (rOhm, derType)",
        lambda c, o: protection_depth.reach_study(
            c, float(o.get("rOhm", 20)), o.get("derType", "inverter")
        ),
    ),
    "fuse-saving": (
        "Recloser-fuse coordination (rOhm)",
        lambda c, o: protection_depth.fuse_saving(c, float(o.get("rOhm", 20))),
    ),
    "recloser-placement": (
        "Where a recloser helps most (maxCandidates)",
        lambda c, o: protection_depth.recloser_placement(c, int(o.get("maxCandidates", 40))),
    ),
    "harmonics": (
        "Harmonic distortion at every bus (orders, thdLimit, individualLimit)",
        lambda c, o: harmonics.harmonics(
            c, o.get("orders"), float(o.get("thdLimit", 5)), float(o.get("individualLimit", 3))
        ),
    ),
    "rvc": (
        "Rapid voltage change: motor start or DER trip (bus, kind, kva, pf, lrcMultiple, limitPct, derId)",  # noqa: E501
        lambda c, o: harmonics.rapid_voltage_change(
            c,
            o.get("bus", ""),
            o.get("kind", "motorStart"),
            float(o.get("kva", 500)),
            float(o.get("pf", 0.3)),
            float(o.get("lrcMultiple", 6)),
            float(o.get("limitPct", 3)),
            o.get("derId"),
        ),
    ),
}


def run_study(name: str, circuit: Circuit, options: dict[str, Any] | None = None) -> dict[str, Any]:
    if name not in STUDIES:
        raise KeyError(f"Unknown study {name!r}; one of {', '.join(sorted(STUDIES))}.")
    return STUDIES[name][1](circuit, options or {})
