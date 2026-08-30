import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode  # noqa: E402


@pytest.fixture
def substation_circuit() -> Circuit:
    """115 kV source -> 2-wdg transformer -> 'main' busbar -> breaker -> line -> load."""
    return Circuit(
        name="Test Substation",
        nodes=[
            CircuitNode(id="src", type="vsource",
                        params={"name": "SRC", "basekv": 115, "pu": 1.0,
                                "phases": 3, "mvasc3": 2000, "mvasc1": 2100}),
            CircuitNode(id="t1", type="transformer",
                        params={"name": "T1", "phases": 3, "xhl": 8.0,
                                "windings": [
                                    {"kv": 115, "kva": 10000, "conn": "delta"},
                                    {"kv": 12.47, "kva": 10000, "conn": "wye"}]}),
            CircuitNode(id="bb1", type="busbar", width=240,
                        params={"name": "Main Bus", "basekv": 12.47}),
            CircuitNode(id="brk", type="breaker",
                        params={"name": "BRK1", "closed": True, "normamps": 600}),
            CircuitNode(id="ld", type="load",
                        params={"name": "L1", "kv": 12.47, "kw": 2000,
                                "pf": 0.95, "phases": 3, "conn": "wye", "model": 1}),
        ],
        edges=[
            CircuitEdge(id="w1", type="wire", source="src", sourceHandle="t1",
                        target="t1", targetHandle="t1"),
            CircuitEdge(id="w2", type="wire", source="t1", sourceHandle="t2",
                        target="bb1", targetHandle="b3"),
            CircuitEdge(id="w3", type="wire", source="bb1", sourceHandle="b7",
                        target="brk", targetHandle="t1"),
            CircuitEdge(id="ln1", type="line", source="brk", sourceHandle="t2",
                        target="ld", targetHandle="t1",
                        params={"name": "LN1", "length": 0.5, "units": "km",
                                "r1": 0.12, "x1": 0.38, "r0": 0.4, "x0": 1.2,
                                "normamps": 400, "phases": 3}),
        ],
    )
