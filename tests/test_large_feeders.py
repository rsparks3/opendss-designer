"""Real-sized feeders through the importer, pinned in CI (see
tests/large_feeders.py). Each of these failed or drifted before M11: ckt7
did not import, ckt24 put a bus at 269 pu, ckt5 lost its open ties and read
its 240 V secondaries at 1.75 pu, and the 8500-node feeder did not converge."""
from __future__ import annotations

import large_feeders as big
import pytest

from opendss_designer.core.compiler import export_dss
from opendss_designer.core.model import in_service

PARAMS = [pytest.param(f, id=f.key) for f in big.FEEDERS]


@pytest.fixture(scope="module")
def trips():
    return {}


def _trip(feeder, trips):
    if feeder.key not in trips:
        trips[feeder.key] = big.round_trip(feeder)
    return trips[feeder.key]


@pytest.mark.parametrize("feeder", PARAMS)
def test_imports_and_matches_the_engine(feeder, trips):
    rt = _trip(feeder, trips)
    assert rt.converged
    assert not rt.unsupported, rt.unsupported
    assert rt.compared > 1000
    # The source bus can be the only one the drawing names differently.
    assert len(rt.missing) <= 1, rt.missing[:5]
    assert rt.max_deviation <= feeder.tolerance, (
        f"{feeder.title}: {rt.max_deviation:.2e} pu at {rt.worst}")


def test_open_ties_survive_as_out_of_service():
    """ckt5 leaves eleven lines and switches disabled; they come back drawn,
    out of service, and the export disables them again."""
    rt = big.round_trip(big.BY_KEY["ckt5"])
    off = [e for e in rt.circuit.edges if not in_service(e.params)]
    off += [n for n in rt.circuit.nodes if not in_service(n.params)]
    assert len(off) == 11
    text, _ = export_dss(rt.circuit)
    assert text.lower().count("\ndisable line.") == 11


def test_substation_ltc_stays_a_transformer():
    """ckt24's 230/34.5 kV substation transformer has a RegControl. It is not
    a regulator: it stays a transformer and the control rides along."""
    rt = big.round_trip(big.BY_KEY["ckt24"])
    sub = next(n for n in rt.circuit.nodes if n.params.get("name", "").lower() == "subxfmr")
    assert sub.type == "transformer"
    assert [w["kv"] for w in sub.params["windings"]] == [230, 34.5]
    assert any(p.name.lower().startswith("regcontrol.") for p in rt.circuit.passthrough)


def test_voltage_bases_come_from_the_file():
    rt = big.round_trip(big.BY_KEY["ckt5"])
    assert rt.circuit.voltageBases == [345, 115, 13.8, 12.47, 4.16, 0.48, 0.415, 0.208]
