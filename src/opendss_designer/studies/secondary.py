"""Service transformers and the secondary: transformer load management and
the customer's voltage.

For every service transformer -- a split-phase unit, or any transformer
whose secondary is under 1 kV -- a day or a year of the loadshapes gives
its loading at every step; from that the peak, the hours above 100 % and
150 % of rating, and the loss of insulation life by IEEE C57.91's
Clause 7 steady-state model: top-oil rise ΔθTO = ΔθTO,R·((K²R+1)/(R+1))^n,
hottest-spot rise ΔθH = ΔθH,R·K^(2m), hottest spot θH = θA + ΔθTO + ΔθH,
aging acceleration F_AA = exp(15000/383 − 15000/(θH+273)), and loss of
life = ΣF_AA·Δt / 180 000 h. Rated rises 55 °C and 25 °C (a 65 °C-rise
unit), loss ratio R = 5, exponents n = m = 0.8, ambient 30 °C unless told.

For every load under 1 kV the lowest voltage over the run, in volts on the
120 V base, against ANSI C84.1 Range A at the meter (114 V).
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import compile_circuit
from ..core.model import Circuit, Issue
from ..core.validate import limit_issues
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

NORMAL_LIFE_H = 180_000.0
DTO_R, DH_R, LOSS_RATIO, N_EXP, M_EXP = 55.0, 25.0, 5.0, 0.8, 0.8


def aging_factor(loading_pu: float, ambient_c: float) -> tuple[float, float]:
    """(hottest-spot temperature, aging acceleration factor) at a loading."""
    k = max(loading_pu, 0.0)
    dto = DTO_R * ((k * k * LOSS_RATIO + 1) / (LOSS_RATIO + 1)) ** N_EXP
    dh = DH_R * k ** (2 * M_EXP)
    theta = ambient_c + dto + dh
    faa = math.exp(15000.0 / 383.0 - 15000.0 / (theta + 273.0))
    return theta, faa


def transformer_loading(
    circuit: Circuit,
    mode: str = "daily",
    step_min: int = 60,
    ambient_c: float = 30.0,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _transformer_loading(
        circuit,
        mode if mode in ("daily", "yearly") else "daily",
        int(step_min),
        float(ambient_c),
        progress,
        cancel,
    )


@engine.on_engine_thread
def _transformer_loading(
    circuit: Circuit,
    mode: str,
    step_min: int,
    ambient: float,
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues], "transformers": []}
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        if not engine._run_commands(
            compiled.commands, compiled.element_map, issues, compiled.optional_commands
        ):
            return {
                "converged": False,
                "issues": [i.model_dump() for i in issues],
                "transformers": [],
            }
        # Service transformers and their ratings.
        units: list[dict[str, Any]] = []
        for n in circuit.nodes:
            if n.type != "transformer" or n.params.get("enabled", True) is False:
                continue
            windings = n.params.get("windings") or []
            lv = min(
                (float(w.get("kv", 99)) for w in windings[1:] if isinstance(w, dict)), default=99.0
            )
            if n.params.get("splitphase") is True or lv < 1.0:
                full = next(
                    (
                        f
                        for f, ref in compiled.element_map.items()
                        if ref == n.id and f.startswith("transformer.")
                    ),
                    None,
                )
                if full is None:
                    continue
                kva = (
                    float(windings[0].get("kva", 25))
                    if windings and isinstance(windings[0], dict)
                    else 25.0
                )
                units.append(
                    {
                        "id": n.id,
                        "full": full,
                        "name": str(n.params.get("name") or n.id),
                        "kva": kva,
                        "peakPct": 0.0,
                        "peakHour": 0.0,
                        "hoursOver100": 0.0,
                        "hoursOver150": 0.0,
                        "lossOfLife": 0.0,
                        "faaSum": 0.0,
                        "steps": 0,
                        "maxHotSpotC": 0.0,
                    }
                )
        # Loads below 1 kV: the customer's voltage.
        services: list[dict[str, Any]] = []
        for n in circuit.nodes:
            if n.type == "load" and n.params.get("enabled", True) is not False:
                try:
                    kv = float(n.params.get("kv", 12.47))
                except (TypeError, ValueError):
                    kv = 12.47
                if kv < 1.0 and compiled.connectivity and n.id in compiled.connectivity.node_buses:
                    services.append(
                        {
                            "id": n.id,
                            "name": str(n.params.get("name") or n.id),
                            "kv": kv,
                            "bus": compiled.connectivity.node_buses[n.id][0].lower(),
                            "minVpu": math.inf,
                            "maxVpu": -math.inf,
                            "minHour": 0.0,
                        }
                    )
        if not units and not services:
            issues.append(
                Issue(
                    severity="warning",
                    code="no-secondary",
                    message="No service transformers (secondary under 1 kV or split-phase) and no "
                    "loads under 1 kV: nothing to judge.",
                )
            )
        has_shapes = any(n.params.get("loadshape") for n in circuit.nodes)
        if not has_shapes:
            issues.append(
                Issue(
                    severity="warning",
                    code="no-shapes",
                    message="No loadshapes: every hour of the run carries the rated load.",
                )
            )
        dss.Text.Command(f"set mode={mode}")
        dss.Text.Command(f"set stepsize={step_min}m")
        dss.Text.Command("set number=1")
        dss.Text.Command("set hour=0 sec=0")
        total = (24 if mode == "daily" else 8760) * 60 // step_min
        dt = step_min / 60.0
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            slices.setdefault(node.split(".", 1)[0], []).append(idx)
        non_conv = 0
        cancelled = False
        for step in range(total):
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            dss.Solution.Solve()
            if not dss.Solution.Converged():
                non_conv += 1
                continue
            hour = dss.Solution.DblHour()
            for u in units:
                if dss.Circuit.SetActiveElement(u["full"]) < 0:
                    continue
                powers = dss.CktElement.Powers()
                ncond = dss.CktElement.NumConductors()
                kw = sum(powers[0 : 2 * ncond : 2])
                kvar = sum(powers[1 : 2 * ncond : 2])
                pct = 100.0 * math.hypot(kw, kvar) / u["kva"] if u["kva"] > 0 else 0.0
                u["steps"] += 1
                if pct > u["peakPct"]:
                    u["peakPct"], u["peakHour"] = pct, hour
                if pct >= 100:
                    u["hoursOver100"] += dt
                if pct >= 150:
                    u["hoursOver150"] += dt
                theta, faa = aging_factor(pct / 100.0, ambient)
                u["faaSum"] += faa * dt
                u["maxHotSpotC"] = max(u["maxHotSpotC"], theta)
            if services:
                mags = dss.Circuit.AllBusMagPu()
                for s in services:
                    idxs = slices.get(s["bus"])
                    if not idxs:
                        continue
                    vals = [mags[i] for i in idxs if mags[i] > 0.05]
                    if not vals:
                        continue
                    lo, hi = min(vals), max(vals)
                    if lo < s["minVpu"]:
                        s["minVpu"], s["minHour"] = lo, hour
                    s["maxVpu"] = max(s["maxVpu"], hi)
            if progress is not None and (step % max(1, total // 100) == 0 or step == total - 1):
                progress(step + 1, total, None)
        dss.Text.Command("set mode=snapshot")
    hours_run = max(1e-9, sum(u["steps"] for u in units[:1]) * dt) if units else total * dt
    per_year = 8760.0 / hours_run if hours_run > 0 else 1.0
    out_units = []
    for u in units:
        loss_pct = 100.0 * u["faaSum"] / NORMAL_LIFE_H
        out_units.append(
            {
                "id": u["id"],
                "name": u["name"],
                "kva": u["kva"],
                "peakPct": round(u["peakPct"], 1),
                "peakHour": round(u["peakHour"], 2),
                "hoursOver100": round(u["hoursOver100"], 2),
                "hoursOver150": round(u["hoursOver150"], 2),
                "equivalentAging": round(u["faaSum"] / (u["steps"] * dt), 3)
                if u["steps"]
                else None,
                "maxHotSpotC": round(u["maxHotSpotC"], 1),
                "lossOfLifePctPerYear": round(loss_pct * per_year, 4),
                "flag": "overloaded"
                if u["hoursOver100"] > 0
                else ("aging" if u["faaSum"] / max(u["steps"] * dt, 1e-9) > 1.0 else None),
            }
        )
    out_units.sort(key=lambda u: -u["peakPct"])
    out_services = []
    for s in services:
        if s["minVpu"] == math.inf:
            continue
        v120 = s["minVpu"] * 120.0
        out_services.append(
            {
                "id": s["id"],
                "name": s["name"],
                "kv": s["kv"],
                "bus": s["bus"],
                "minVpu": round(s["minVpu"], 4),
                "minV120": round(v120, 1),
                "minHour": round(s["minHour"], 2),
                "maxVpu": round(s["maxVpu"], 4),
                "maxV120": round(s["maxVpu"] * 120.0, 1),
                "flag": "low" if v120 < 114 else ("high" if s["maxVpu"] * 120 > 126 else None),
            }
        )
    out_services.sort(key=lambda s: s["minV120"])
    return {
        "converged": not cancelled and non_conv == 0,
        "cancelled": cancelled,
        "mode": mode,
        "stepMin": step_min,
        "ambientC": ambient,
        "transformers": out_units,
        "services": out_services,
        "summary": {
            "transformers": len(out_units),
            "overloaded": sum(1 for u in out_units if u["hoursOver100"] > 0),
            "aging": sum(1 for u in out_units if (u["equivalentAging"] or 0) > 1.0),
            "services": len(out_services),
            "lowVoltage": sum(1 for s in out_services if s["flag"] == "low"),
            "highVoltage": sum(1 for s in out_services if s["flag"] == "high"),
        },
        "nonConverged": non_conv,
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
    }
