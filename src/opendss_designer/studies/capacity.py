"""Loss evaluation and feeder capacity.

* `loss_evaluation` -- a day or a year of losses by element class (lines,
  transformers, regulators, switches) from the engine's per-element
  losses at every step, with the energy served, the loss share and a cost
  at a price per kWh; the peak-hour losses too.
* `capacity_search` -- the load multiplier at which the feeder first
  breaks a criterion (undervoltage or an overload), found by bisection:
  the feeder's capacity in kW, the headroom above the present load, and
  what binds. OpenDSS's own `Capacity` command does the same thing off
  EnergyMeter registers; this version needs no meter and says why.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import compile_circuit
from ..core.model import Circuit
from ..core.validate import limit_issues
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

CLASS_LABELS = {
    "line": "Lines",
    "transformer": "Transformers and regulators",
    "capacitor": "Capacitors",
    "reactor": "Reactors",
    "other": "Other",
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
    return compiled, issues, ok


def loss_evaluation(
    circuit: Circuit,
    mode: str = "daily",
    step_min: int = 60,
    price_per_kwh: float = 0.0,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _loss_evaluation(
        circuit,
        mode if mode in ("daily", "yearly") else "daily",
        int(step_min),
        float(price_per_kwh),
        progress,
        cancel,
    )


@engine.on_engine_thread
def _loss_evaluation(
    circuit: Circuit,
    mode: str,
    step_min: int,
    price: float,
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        switches = {
            f
            for f, ref in compiled.element_map.items()
            if f.startswith("line.")
            and any(
                n.id == ref and n.type in ("breaker", "fuse", "recloser", "relay")
                for n in circuit.nodes
            )
        }
        regulators = {
            f
            for f, ref in compiled.element_map.items()
            if f.startswith("transformer.")
            and any(n.id == ref and n.type == "regulator" for n in circuit.nodes)
        }
        dss.Text.Command(f"set mode={mode}")
        dss.Text.Command(f"set stepsize={step_min}m")
        dss.Text.Command("set number=1")
        dss.Text.Command("set hour=0 sec=0")
        total = (24 if mode == "daily" else 8760) * 60 // step_min
        dt = step_min / 60.0
        names = [n.lower() for n in dss.Circuit.AllElementNames()]

        def cls_of(full: str) -> str:
            if full in switches:
                return "switch"
            if full in regulators:
                return "regulator"
            head = full.split(".", 1)[0]
            return head if head in ("line", "transformer", "capacitor", "reactor") else "other"

        classes = [cls_of(n) for n in names]
        by_class: dict[str, float] = {}
        energy = 0.0
        peak_kw = 0.0
        peak_loss = 0.0
        peak_hour = 0.0
        series: list[float] = []
        non_conv = 0
        cancelled = False
        for step in range(total):
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            dss.Solution.Solve()
            if not dss.Solution.Converged():
                non_conv += 1
                series.append(0.0)
                continue
            p = -dss.Circuit.TotalPower()[0]
            energy += p * dt
            losses = dss.Circuit.AllElementLosses()  # kW, kvar interleaved
            step_loss = 0.0
            for i, cls in enumerate(classes):
                kw = float(losses[2 * i])
                if cls in ("line", "transformer", "regulator", "switch", "reactor"):
                    by_class[cls] = by_class.get(cls, 0.0) + kw * dt
                    step_loss += kw
            series.append(round(step_loss, 3))
            if p > peak_kw:
                peak_kw, peak_loss, peak_hour = p, step_loss, dss.Solution.DblHour()
            if progress is not None and (step % max(1, total // 100) == 0 or step == total - 1):
                progress(step + 1, total, None)
        dss.Text.Command("set mode=snapshot")
    total_loss = sum(by_class.values())
    return {
        "converged": not cancelled and non_conv == 0,
        "cancelled": cancelled,
        "mode": mode,
        "stepMin": step_min,
        "steps": len(series),
        "energyKwh": round(energy, 1),
        "lossesKwh": round(total_loss, 2),
        "lossPct": round(100.0 * total_loss / energy, 3) if energy > 0 else None,
        "byClass": [
            {
                "class": c,
                "label": {
                    "switch": "Switches and protective devices",
                    "regulator": "Regulators",
                    "transformer": "Transformers",
                    "line": "Lines",
                    "reactor": "Reactors",
                }.get(c, c),
                "kwh": round(v, 2),
                "share": round(100.0 * v / total_loss, 1) if total_loss > 0 else None,
                "cost": round(v * price, 2) if price else None,
            }
            for c, v in sorted(by_class.items(), key=lambda kv: -kv[1])
        ],
        "pricePerKwh": price,
        "costTotal": round(total_loss * price, 2) if price else None,
        "peakKw": round(peak_kw, 1),
        "peakLossKw": round(peak_loss, 2),
        "peakHour": round(peak_hour, 2),
        "peakLossPct": round(100.0 * peak_loss / peak_kw, 3) if peak_kw > 0 else None,
        "lossSeriesKw": series if len(series) <= 2000 else series[:: max(1, len(series) // 2000)],
        "nonConverged": non_conv,
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
    }


def capacity_search(
    circuit: Circuit, max_mult: float = 10.0, tolerance: float = 0.005
) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _capacity_search(circuit, float(max_mult), float(tolerance))


@engine.on_engine_thread
def _capacity_search(circuit: Circuit, max_mult: float, tol: float) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        dss.Text.Command("set mode=snapshot")
        limits = circuit.criteria
        level = circuit.level
        base_mult = level.loadmult
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            slices.setdefault(node.split(".", 1)[0], []).append(idx)
        pd_names = [n.lower() for n in dss.PDElements.AllNames()]
        solves = 0

        def check(mult: float) -> tuple[str | None, dict[str, Any]]:
            nonlocal solves
            dss.Text.Command(f"set loadmult={mult:.6g}")
            dss.Solution.Solve()
            solves += 1
            if not dss.Solution.Converged():
                return "notConverged", {}
            mags = dss.Circuit.AllBusMagPu()
            vmin, vbus = math.inf, None
            for b, idxs in slices.items():
                lo = min(mags[i] for i in idxs)
                if 0.05 < lo < vmin:
                    vmin, vbus = lo, b
            pct = (
                dss.PDElements.AllPctEmerg(False)
                if level.rating == "emergency"
                else dss.PDElements.AllPctNorm(False)
            )
            worst = max(((float(v), n) for n, v in zip(pd_names, pct, strict=False)), default=(0.0, None))  # noqa: E501
            kw = -dss.Circuit.TotalPower()[0]
            info = {
                "minVpu": round(vmin, 4) if vmin < math.inf else None,
                "minVBus": vbus,
                "maxLoadingPct": round(worst[0], 1),
                "maxLoadingElement": worst[1],
                "sourceKw": round(kw, 1),
            }
            if vmin < limits.vminPu:
                return "voltage", info
            if worst[0] >= limits.overloadPct:
                return "thermal", info
            return None, info

        binding, base_info = check(base_mult)
        if binding is not None:
            dss.Text.Command(f"set loadmult={base_mult:.6g}")
            return {
                "converged": True,
                "atCapacity": True,
                "binding": binding,
                "baseMult": base_mult,
                "capacityMult": base_mult,
                "capacityKw": base_info.get("sourceKw"),
                "headroomKw": 0.0,
                "base": base_info,
                "atLimit": base_info,
                "solves": solves,
                "loadLevel": level.model_dump(),
                "scenario": circuit.activeScenario,
                "issues": [i.model_dump() for i in issues],
            }
        lo, hi = base_mult, min(base_mult * 2, max_mult)
        last_info = base_info
        binding = None
        while True:
            b, info = check(hi)
            if b is not None:
                binding = b
                break
            lo, last_info = hi, info
            if hi >= max_mult:
                break
            hi = min(hi * 2, max_mult)
        if binding is not None:
            while hi - lo > tol:
                mid = (lo + hi) / 2
                b, info = check(mid)
                if b is not None:
                    hi, binding = mid, b
                else:
                    lo, last_info = mid, info
        dss.Text.Command(f"set loadmult={base_mult:.6g}")
    return {
        "converged": True,
        "atCapacity": False,
        "capped": binding is None,
        "binding": binding or "none",
        "baseMult": base_mult,
        "capacityMult": round(lo, 4),
        "capacityKw": last_info.get("sourceKw"),
        "headroomKw": round((last_info.get("sourceKw") or 0) - (base_info.get("sourceKw") or 0), 1),
        "base": base_info,
        "atLimit": last_info,
        "solves": solves,
        "loadLevel": level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
    }
