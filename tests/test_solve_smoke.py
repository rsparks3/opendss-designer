from opendss_designer.core import engine
from opendss_designer.core.validate import validate


def test_validate_clean(substation_circuit):
    issues = validate(substation_circuit)
    assert not [i for i in issues if i.severity == "error"], issues


def test_solve_converges(substation_circuit):
    result = engine.solve(substation_circuit)
    assert result["converged"], result["issues"]
    assert result["iterations"] >= 1

    # Load bus voltage should be plausible.
    load_bus = result["nodeBuses"]["ld"][0]
    v = result["buses"][load_bus]["vminPu"]
    assert 0.90 < v < 1.05

    # The feeder line should carry the load.
    ln = result["elements"]["line.ln1"]
    assert ln["loadingPct"] is not None and ln["loadingPct"] > 0
    assert ln["kw"] > 1900  # ~2 MW flows toward the load

    # Transformer loading reported too.
    assert result["elements"]["transformer.t1"]["loadingPct"] is not None
    assert result["losses"]["kw"] >= 0


def test_open_breaker_dead_ends_load(substation_circuit):
    next(n for n in substation_circuit.nodes if n.id == "brk").params["closed"] = False
    result = engine.solve(substation_circuit)
    assert result["converged"], result["issues"]
    load_bus = result["nodeBuses"]["ld"][0]
    assert result["buses"][load_bus]["vminPu"] < 0.5  # de-energized


def test_validate_flags_unconnected():
    from opendss_designer.core.model import Circuit, CircuitNode
    c = Circuit(nodes=[CircuitNode(id="s", type="vsource", params={"basekv": 12.47}),
                       CircuitNode(id="l", type="load", params={"kv": 12.47})])
    issues = validate(c)
    assert any(i.code == "unconnected-terminal" for i in issues)


def test_project_limits_drive_violation_flags(substation_circuit):
    from opendss_designer.core.model import Limits
    base = engine.solve(substation_circuit)
    load_bus = base["nodeBuses"]["ld"][0]
    v = base["buses"][load_bus]["vminPu"]
    ln = base["elements"]["line.ln1"]
    assert "violation" not in base["buses"][load_bus]
    assert "overload" not in ln["violations"]

    # Criteria either side of what the circuit does flip the flags.
    substation_circuit.limits = Limits(vminPu=min(v + 0.01, 1.5), vmaxPu=1.6,
                                       overloadPct=ln["loadingPct"] / 2, warnPct=1)
    tight = engine.solve(substation_circuit)
    assert tight["buses"][load_bus]["violation"] == "undervoltage"
    assert "overload" in tight["elements"]["line.ln1"]["violations"]


def test_limits_are_validated():
    import pytest
    from pydantic import ValidationError

    from opendss_designer.core.model import Circuit
    assert Circuit().criteria.vminPu == 0.95
    with pytest.raises(ValidationError):
        Circuit.model_validate({"limits": {"vminPu": -1}})
