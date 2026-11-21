"""Interactive TCC (facility plan 2.5): generic curve families, the relay
time dial, trace metadata for redrawing, and the campus relay over its fuse."""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from opendss_designer.core import protection, tcc_library
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.model import Circuit, TccSet

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def campus(**patches: dict) -> Circuit:
    d = json.loads((SAMPLES / "installation-campus.oneline.json").read_text())
    for n in d["nodes"]:
        n["params"].update(patches.get(n["id"], {}))
    return Circuit.model_validate(d)


def secs_at(trace: dict, amps: float) -> float:
    pts = trace["points"]
    if amps >= pts[-1][0]:
        return pts[-1][1]  # past its data a curve holds flat, as the engine does
    for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
        if x0 <= amps <= x1:
            f = (math.log10(amps) - math.log10(x0)) / (math.log10(x1) - math.log10(x0))
            return 10 ** (math.log10(y0) + f * (math.log10(y1) - math.log10(y0)))
    raise AssertionError("off the curve")


def devices(c: Circuit) -> dict[str, dict]:
    r = protection.tcc_study(c)
    assert r["converged"], r["issues"]
    return {d["nodeId"]: d for d in r["devices"]}


def test_generic_families_match_their_formulas():
    assert tcc_library.seconds("iec_si", 10) == pytest.approx(0.14 / (10**0.02 - 1))
    mult, secs = tcc_library.GENERIC_CURVES["iec_vi"]
    assert secs[mult.index(2.0)] == pytest.approx(13.5)
    names = {c["name"] for c in protection.builtin_curves()["curves"] if c.get("generic")}
    assert names == set(tcc_library.FAMILIES)


def test_a_generic_curve_is_defined_only_when_named():
    plain = compile_circuit(campus(brk_f1={"phasecurve": "very_inv"}))
    assert not any(c.startswith("new tcc_curve.iec_") for c in plain.commands)
    used = compile_circuit(campus())
    assert sum(c.startswith("new tcc_curve.iec_vi") for c in used.commands) == 1
    text, _ = export_dss(campus())
    assert "new tcc_curve.iec_vi" in text.lower()
    assert "tdphase=0.3" in text.lower()


def test_time_dial_scales_the_relay_curve():
    one = devices(campus(brk_f1={"tdphase": 1}))["brk_f1"]["traces"][0]
    tms = devices(campus(brk_f1={"tdphase": 0.3}))["brk_f1"]["traces"][0]
    assert one["timeDial"] == 1 and tms["timeDial"] == pytest.approx(0.3)
    assert one["keys"] == {"curve": "phasecurve", "pickup": "phasetrip", "td": "tdphase"}
    amps = 10 * 300
    assert secs_at(one, amps) == pytest.approx(13.5 / 9, rel=0.02)
    assert secs_at(tms, amps) == pytest.approx(0.3 * 13.5 / 9, rel=0.02)


def test_campus_feeder_relay_grades_over_the_clinic_fuse():
    devs = devices(campus())
    fuse, relay = devs["fu_clinic"], devs["brk_f1"]
    amps = fuse["faultA3ph"]
    margin = secs_at(relay["traces"][0], amps) - secs_at(fuse["traces"][0], amps)
    assert margin >= 0.25
    assert fuse["traces"][0]["keys"] == {"curve": "fusecurve", "pickup": "ratedcurrent"}
    # A much larger link eats the margin, and the study says so.
    big = devices(campus(fu_clinic={"ratedcurrent": 200}))
    tight = secs_at(big["brk_f1"]["traces"][0], amps) - secs_at(big["fu_clinic"]["traces"][0], amps)
    assert tight < margin


def test_tcc_sets_round_trip():
    c = campus()
    c.tccSets = [TccSet(id="tcc1", name="Clinic chain", deviceIds=["fu_clinic", "brk_f1"])]
    again = Circuit.model_validate(json.loads(c.model_dump_json()))
    assert again.tccSets[0].deviceIds == ["fu_clinic", "brk_f1"]
