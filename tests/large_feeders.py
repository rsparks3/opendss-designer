"""Real-sized feeders as a yardstick for the importer.

EPRI's ckt5, ckt7 and ckt24 and the IEEE 8500-node feeder: 2,000 to 10,000
elements each, written the way utilities write models -- redirect trees,
LineGeometry, XfmrCodes, CVR loads, centre-tapped service transformers,
allocated loads, open ties left disabled, a substation LTC. Each is pushed
through `importer.import_dss_files` the way the Import button does it,
solved the way the Solve button does it, and compared with the engine's own
solution of the files as shipped.

Shared by `tests/test_large_feeders.py` and `scripts/ieee_validation.py`.
Fixture provenance is in tests/fixtures/large/README.md.
"""
from __future__ import annotations

import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import opendssdirect as dss

from opendss_designer.core import engine, importer
from opendss_designer.core.model import Circuit

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "large"

# The ceilings the app's compiler sets; the reference solve gets the same, so
# the 8500-node feeder converges on both sides (EPRI's run script raises it).
_ITERATIONS = "set maxiterations=100 maxcontroliter=100"


@dataclass(frozen=True)
class Feeder:
    key: str
    main: str
    title: str
    # Largest per-node voltage difference (pu) the round trip may show.
    tolerance: float
    note: str = ""


FEEDERS: tuple[Feeder, ...] = (
    Feeder("ckt5", "Master_ckt5.dss", "EPRI ckt5", 1e-4),
    Feeder("ckt7", "Master_ckt7.dss", "EPRI ckt7", 5e-4,
           note="4 kW of 76.5 MW at the source is unaccounted for; the "
                "voltages agree to 0.0002 pu."),
    Feeder("ckt24", "master_ckt24.dss", "EPRI ckt24", 1e-4),
    Feeder("8500", "Master.dss", "IEEE 8500-node", 1e-4),
)
BY_KEY = {f.key: f for f in FEEDERS}


def fixture_files(feeder: Feeder) -> list[dict[str, str]]:
    return [{"name": p.name, "text": p.read_text(encoding="utf-8", errors="replace")}
            for p in sorted((FIXTURES / feeder.key).iterdir()) if p.is_file()]


@engine.on_engine_thread
def solve_original(feeder: Feeder) -> tuple[dict[str, dict[int, float]], int]:
    """Bus voltages (bus -> node -> pu) and element count of the files as
    shipped. Compiled from a copy: ckt24's regulator has `debugtrace=yes`,
    which writes a trace file beside whatever it was compiled from."""
    tmp = Path(tempfile.mkdtemp(prefix="large_feeder_"))
    shutil.copytree(FIXTURES / feeder.key, tmp, dirs_exist_ok=True)
    with engine.dss_guard():
        engine._ensure_init()
        dss.Text.Command("clear")
        dss.Text.Command(f'compile "{tmp / feeder.main}"')
        dss.Text.Command(_ITERATIONS)
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("solve")
        try:
            if not dss.Solution.Converged():
                raise RuntimeError(f"{feeder.title}: the original files did not converge")
            out: dict[str, dict[int, float]] = {}
            for bus in dss.Circuit.AllBusNames():
                dss.Circuit.SetActiveBus(bus)
                out[bus.lower()] = dict(zip(dss.Bus.Nodes(), dss.Bus.puVmagAngle()[0::2],
                                            strict=False))
            return out, len(dss.Circuit.AllElementNames())
        finally:
            dss.Text.Command("clear")
            dss.Basic.DataPath(str(engine.WORKDIR))
            shutil.rmtree(tmp, ignore_errors=True)


@dataclass
class RoundTrip:
    feeder: Feeder
    circuit: Circuit
    warnings: list[str]
    unsupported: list[str]
    converged: bool
    elements: int
    import_s: float
    solve_s: float
    max_deviation: float
    worst: str
    compared: int
    missing: list[str]


def round_trip(feeder: Feeder) -> RoundTrip:
    reference, n_elements = solve_original(feeder)
    t0 = time.perf_counter()
    imported = importer.import_dss_files(fixture_files(feeder))
    t1 = time.perf_counter()
    circuit = Circuit.model_validate(imported["circuit"])
    result = engine.solve(circuit)
    t2 = time.perf_counter()
    solved = {k.lower(): v for k, v in result.get("buses", {}).items()}
    worst, worst_at, compared, missing = 0.0, "", 0, []
    for bus, nodes in reference.items():
        got = solved.get(bus)
        if got is None:
            missing.append(bus)
            continue
        mine = dict(zip(got["nodes"], got["vmagPu"], strict=False))
        for node, pu in nodes.items():
            if node in mine:
                compared += 1
                dev = abs(mine[node] - pu)
                if dev > worst:
                    worst, worst_at = dev, f"{bus}.{node}"
    return RoundTrip(feeder=feeder, circuit=circuit, warnings=list(imported["warnings"]),
                     unsupported=list(imported["unsupported"]),
                     converged=bool(result.get("converged")), elements=n_elements,
                     import_s=t1 - t0, solve_s=t2 - t1, max_deviation=worst,
                     worst=worst_at, compared=compared, missing=missing)
