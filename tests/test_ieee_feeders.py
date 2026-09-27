"""The IEEE PES test feeders, pinned in CI.

Two layers, deliberately separate (see tests/ieee_feeders.py):

* the engine against the published solutions - the claim on the docs page;
* the app's import against the engine - the importer's fidelity. Until
  2026-09-19 these were strict xfails; line codes closed the gap.
"""
from __future__ import annotations

import ieee_feeders as bench
import pytest

from opendss_designer.core.compiler import export_dss

FEEDER_PARAMS = [pytest.param(f, id=f.key) for f in bench.FEEDERS]


@pytest.fixture(scope="module")
def locked(request):
    return {f.key: bench.solve_original(f, lock_taps=True) for f in bench.FEEDERS}


@pytest.mark.parametrize("feeder", FEEDER_PARAMS)
def test_engine_reproduces_published_voltages(feeder, locked):
    """With the regulators on Kersting's taps, every bus voltage in the
    published profile is reproduced within the feeder's tolerance."""
    voltages, _taps, _losses = locked[feeder.key]
    cmp = bench.compare(feeder, voltages)
    assert len(cmp.rows) >= 30, "the published profile was not parsed"
    over = cmp.over(feeder.tolerance)
    assert not over, (
        f"{feeder.title}: {len(over)} node-phases beyond {feeder.tolerance} pu, "
        f"worst {over[0].bus}.{over[0].phase} published {over[0].published} "
        f"solved {over[0].solved:.4f}")


@pytest.mark.parametrize("feeder", FEEDER_PARAMS)
def test_published_profile_covers_the_feeder(feeder, locked):
    """Every published node that is a bus in EPRI's file was compared; the
    only misses are Kersting's regulator/transformer pseudo-nodes."""
    voltages, _taps, _losses = locked[feeder.key]
    cmp = bench.compare(feeder, voltages)
    pseudo = {m for m in cmp.missing if m.startswith(("rg", "xf"))}
    assert set(cmp.missing) == pseudo, cmp.missing


def test_known_deviation_is_still_there():
    """Bus 610 on the 123-bus is excluded from the tolerance with a stated
    reason. If it ever agrees, the exclusion should go, so pin the gap."""
    feeder = bench.BY_KEY["123"]
    voltages, _taps, _losses = bench.solve_original(feeder, lock_taps=True)
    cmp = bench.compare(feeder, voltages)
    assert cmp.excluded and all(r.bus == "610" for r in cmp.excluded)
    assert max(r.deviation for r in cmp.excluded) > feeder.tolerance


# --- The importer, measured against the engine --------------------------------

ROUND_TRIP_PARAMS = [pytest.param(f, id=f.key) for f in bench.FEEDERS]


@pytest.fixture(scope="module")
def round_trips():
    return {f.key: bench.round_trip(f) for f in bench.FEEDERS}


@pytest.mark.parametrize("feeder", ROUND_TRIP_PARAMS)
def test_import_reads_every_element_and_solves(feeder, round_trips):
    rt = round_trips[feeder.key]
    assert not rt.unsupported, rt.unsupported
    assert rt.converged, [i for i in rt.solve["issues"] if i["severity"] == "error"]
    assert not rt.missing, f"buses lost on import: {rt.missing}"
    # Every warning is about the run script at the end of the file or the
    # unused half of the shared code library, never the circuit itself.
    assert all("Ignored '" in w or "left out" in w for w in rt.warnings), rt.warnings


@pytest.mark.parametrize("feeder", ROUND_TRIP_PARAMS)
def test_import_exports_again(feeder, round_trips):
    """What came in goes out: the imported circuit exports to .dss without
    the compiler refusing any of it."""
    text, issues = export_dss(round_trips[feeder.key].circuit)
    assert not [i for i in issues if i.severity == "error"], issues
    assert "new circuit." in text.lower()


@pytest.mark.parametrize("feeder", ROUND_TRIP_PARAMS)
def test_import_keeps_the_solution(feeder, round_trips):
    """The app's solution of the imported circuit matches the engine's
    solution of the original file at every bus. 0.0005 pu is well inside
    the published tables' resolution; the feeders actually agree to 2e-5,
    the rounding of matrix entries to six significant figures on export."""
    rt = round_trips[feeder.key]
    worst = max(rt.rows, key=lambda r: r.deviation)
    assert rt.max_deviation <= 0.0005, (
        f"{feeder.title}: worst {worst.bus}.{worst.phase} engine {worst.published:.4f} "
        f"app {worst.solved:.4f} (max {rt.max_deviation:.4f} pu over {len(rt.rows)} node-phases)")
    losses = rt.solve["losses"]["kw"]
    assert abs(losses - rt.reference_losses_kw) <= 0.002 * rt.reference_losses_kw + 0.05


@pytest.mark.parametrize("feeder", ROUND_TRIP_PARAMS)
def test_import_carries_the_line_codes(feeder, round_trips):
    """Every line of every feeder is on a line code from the file, and only
    the codes lines use travel with the circuit (the shared IEEE code file
    defines thirty)."""
    rt = round_trips[feeder.key]
    lines = [e for e in rt.circuit.edges if e.type == "line"]
    on_code = [e for e in lines if e.params.get("linecode") in rt.circuit.lineCodes]
    # The 37-bus has one sequence-defined jumper; the rest name a code.
    assert len(on_code) >= len(lines) - 1
    assert all(spec.is_matrix for spec in rt.circuit.lineCodes.values())
    assert any("left out" in w for w in rt.warnings)
