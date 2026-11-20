"""Scenario overrides (facility plan 1.1): only parameter patches get in,
and a scenario exports exactly as the base edited by hand to the same
state would."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from opendss_designer.core.compiler import export_dss
from opendss_designer.core.model import Circuit, Scenario

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def demo() -> dict:
    return json.loads((SAMPLES / "demo-substation.oneline.json").read_text())


@pytest.mark.parametrize("patch", [
    {"kw; new load.x": 1},
    {"": 1},
    {"kw": {"a": {"b": {"c": {"d": 1}}}}},
    {"kw": float("inf")},
    {"name": "x" * 70_000},
])
def test_an_override_that_is_not_a_parameter_is_refused(patch):
    with pytest.raises(ValidationError):
        Scenario(id="s", name="bad", overrides={"ld1": patch})


def test_plain_overrides_pass():
    sc = Scenario(id="s", name="ok", overrides={
        "ld1": {"kw": 120, "priority": "critical", "tags": ["a", "b"], "loadshape": None},
        "xf1": {"windings": [{"kv": 115, "kva": 12000, "conn": "delta"}]},
    })
    assert sc.overrides["ld1"]["kw"] == 120


def test_scenario_export_matches_the_hand_edited_base():
    base = demo()
    edits = {"brk1": {"closed": False}, "ld1": {"kw": 1500, "pf": 0.9}, "ld2": {"enabled": False}}
    with_scenario = Circuit.model_validate({
        **base,
        "scenarios": [{"id": "s1", "name": "Edited", "overrides": edits}],
        "activeScenario": "s1",
    })
    by_hand = json.loads(json.dumps(base))
    for n in by_hand["nodes"]:
        n["params"].update(edits.get(n["id"], {}))
    a, _ = export_dss(with_scenario)
    b, _ = export_dss(Circuit.model_validate(by_hand))
    assert a == b
    assert "open line.brk1" in a and "disable load.station_load" in a.lower()
    # And the base itself exports as the base.
    base_text, _ = export_dss(Circuit.model_validate(base))
    assert base_text != a


def test_batch_cells_carry_per_element_detail():
    from opendss_designer.studies.batch import run_batch
    c = Circuit.model_validate({
        **json.loads((SAMPLES / "installation-campus.oneline.json").read_text()),
        "scenarios": [{"id": "f3", "name": "F3 open", "overrides": {"brk_f3": {"closed": False}}}],
    })
    out = run_batch(c)
    base, f3 = out["cells"]
    assert base["detail"]["unservedKw"] == {"critical": 0, "essential": 0, "nonessential": 0,
                                            "unassigned": 0}
    assert f3["detail"]["unservedKw"]["nonessential"] == pytest.approx(1200)
    assert f3["detail"]["unservedKw"]["essential"] == pytest.approx(300)
    assert f3["detail"]["loading"]["brk_f3"] == 0
    assert base["detail"]["loading"]["brk_f3"] > 0
    assert f3["detail"]["busVmin"]["housing_mv"] < 0.05 < base["detail"]["busVmin"]["housing_mv"]
