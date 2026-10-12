"""M4 analysis features: fault study, per-element losses, bus distances."""
from __future__ import annotations

import json
from pathlib import Path

from opendss_designer.core import engine
from opendss_designer.core.model import Circuit

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"


def fixture_circuit() -> Circuit:
    return Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))


def test_fault_study_returns_positive_currents():
    result = engine.fault_study(fixture_circuit())
    assert result["converged"], result["issues"]
    assert result["buses"]
    for name, b in result["buses"].items():
        assert b["if3phA"] and b["if3phA"] > 0, name
        assert b["if1phA"] and b["if1phA"] > 0, name
        assert b["scMva3"] and b["scMva3"] > 0, name
        assert b["zsc1"]["x"] > 0, name


def test_fault_current_decreases_down_the_feeder():
    """The bus behind the line + transformer must see a weaker source than
    the bus right at it."""
    result = engine.fault_study(fixture_circuit())
    solve = engine.solve(fixture_circuit())
    dist = solve["busDistances"]
    mv_buses = {n: b for n, b in result["buses"].items()
                if abs(b["kvBase"] * 3 ** 0.5 - 12.47) < 0.1}
    assert len(mv_buses) >= 2
    near = min(mv_buses, key=lambda n: dist.get(n, 0.0))
    far = max(mv_buses, key=lambda n: dist.get(n, 0.0))
    assert dist[far] > dist[near]
    assert mv_buses[far]["if3phA"] < mv_buses[near]["if3phA"]


def test_solve_reports_element_losses_and_distances():
    result = engine.solve(fixture_circuit())
    assert result["converged"], result["issues"]

    losses = {n: e["lossKw"] for n, e in result["elements"].items()
              if e["lossKw"] is not None}
    # Only series elements report losses; shunt elements report None. A
    # regulator is a transformer to OpenDSS, and every protective device is a
    # switch, so both kinds report losses like the breaker does.
    assert set(losses) == {"transformer.t1", "transformer.reg1",
                           "line.ln1", "line.ln2", "line.brk1",
                           "line.fu1", "line.rec1", "line.rly1"}
    assert result["elements"]["load.load1"]["lossKw"] is None
    assert losses["transformer.t1"] > 0
    assert losses["line.ln1"] > 0
    # Series losses account for the circuit total.
    total = result["losses"]["kw"]
    assert abs(sum(losses.values()) - total) < max(0.05 * abs(total), 0.05)

    dist = result["busDistances"]
    assert dist, "busDistances missing"
    assert min(dist.values()) == 0.0  # the source bus
    assert max(dist.values()) >= 2.5  # the 2.5 km line is on the path


def test_shunt_generation_is_loaded_against_its_kva_rating():
    """A generator, PV system or storage unit has no ampere rating, so its
    loading is apparent power over the kVA rating (the generator's is the
    engine's default of 1.2 x kW); a capacitor keeps the engine's own
    NormalAmps, 135 % of rated current, as IEEE 18 allows."""
    result = engine.solve(fixture_circuit())
    assert result["converged"], result["issues"]
    els = result["elements"]
    gen = els["generator.gen1"]
    assert gen["ratingKva"] == 750 and gen["normAmps"] is None
    assert abs(gen["loadingPct"] - 100 * (gen["kw"] ** 2 + gen["kvar"] ** 2) ** 0.5 / 750) < 0.11
    pv = els["pvsystem.pv1"]
    assert pv["ratingKva"] == 650 and 70 < pv["loadingPct"] < 80
    assert els["storage.bat1"]["ratingKva"] == 250
    cap = els["capacitor.cap1"]
    assert cap["ratingKva"] is None and cap["normAmps"] > 0
    assert 70 < cap["loadingPct"] < 80  # rated voltage is 1/1.35 of the allowance
    assert els["load.load1"]["loadingPct"] is None
    assert els["line.ln1"]["ratingKva"] is None


def test_generator_kva_rating_is_compiled_and_judged():
    circuit = fixture_circuit()
    gen = next(n for n in circuit.nodes if n.type == "generator")
    gen.params["kva"] = 400  # below its 500 kW output
    result = engine.solve(circuit)
    assert result["converged"], result["issues"]
    el = result["elements"]["generator.gen1"]
    assert el["ratingKva"] == 400
    assert el["loadingPct"] > 100 and "overload" in el["violations"]
