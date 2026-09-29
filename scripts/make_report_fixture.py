"""Record the engine's answers for the schema fixture, for the report tests.

    PYTHONPATH=src python scripts/make_report_fixture.py

writes frontend/src/lib/report/__fixtures__/full-circuit.results.json: the
snapshot solve, fault study and TCC study of tests/fixtures/full-circuit.
Rerun it when the fixture or the engine's result shape changes.
"""
import json
from pathlib import Path

from opendss_designer.core import engine, protection
from opendss_designer.core.model import Circuit

ROOT = Path(__file__).resolve().parents[1]
circuit = Circuit.model_validate_json(
    (ROOT / "tests/fixtures/full-circuit.oneline.json").read_text(encoding="utf-8"))
out = {
    "solve": engine.solve(circuit),
    "fault": engine.fault_study(circuit),
    "tcc": protection.tcc_study(circuit),
}
target = ROOT / "frontend/src/lib/report/__fixtures__/full-circuit.results.json"
target.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
print(f"wrote {target.relative_to(ROOT)}")
