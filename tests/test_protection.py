"""Fuses, reclosers and relays: a switch plus the control that watches it."""
import pytest

from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss
from opendss_designer.core.model import Circuit


def _feeder(device_type: str, params: dict) -> Circuit:
    """Source -> bus -> protective device -> bus -> load."""
    return Circuit.model_validate({
        "name": "prot",
        "nodes": [
            {"id": "src", "type": "vsource",
             "params": {"name": "SRC1", "basekv": 12.47, "pu": 1.0, "phases": 3,
                        "mvasc3": 2000, "mvasc1": 2100}},
            {"id": "b1", "type": "busbar", "params": {"name": "BUS-A", "basekv": 12.47}},
            {"id": "dev", "type": device_type, "params": {"name": "DEV1", **params}},
            {"id": "b2", "type": "busbar", "params": {"name": "BUS-B", "basekv": 12.47}},
            {"id": "ld", "type": "load",
             "params": {"name": "LOAD1", "kv": 12.47, "kw": 500, "pf": 0.95,
                        "phases": 3, "conn": "wye", "model": 1}},
        ],
        "edges": [
            {"id": "e1", "type": "wire", "source": "src", "sourceHandle": "t1",
             "target": "b1", "targetHandle": "b0"},
            {"id": "e2", "type": "wire", "source": "b1", "sourceHandle": "c0",
             "target": "dev", "targetHandle": "t1"},
            {"id": "e3", "type": "wire", "source": "dev", "sourceHandle": "t2",
             "target": "b2", "targetHandle": "b0"},
            {"id": "e4", "type": "wire", "source": "b2", "sourceHandle": "c0",
             "target": "ld", "targetHandle": "t1"},
        ],
    })


@pytest.mark.parametrize("device_type,params,expected", [
    ("fuse", {"ratedcurrent": 65, "fusecurve": "klink"},
     ["new line.dev1", "switch=yes", "new fuse.dev1", "fusecurve=klink",
      "ratedcurrent=65"]),
    ("recloser", {"phasetrip": 120, "groundtrip": 40, "numfast": 2, "shots": 3},
     ["new recloser.dev1", "phasefast=a", "phasedelayed=d", "phasetrip=120",
      "numfast=2", "shots=3"]),
    ("relay", {"phasetrip": 250, "phasecurve": "ext_inv", "groundcurve": "mod_inv"},
     ["new relay.dev1", "type=current", "phasecurve=ext_inv", "phasetrip=250",
      "groundcurve=mod_inv"]),
])
def test_device_compiles_to_a_switch_and_a_control(device_type, params, expected):
    res = compile_circuit(_feeder(device_type, params))
    assert not [i for i in res.issues if i.severity == "error"]
    joined = "\n".join(res.commands).lower()
    for fragment in expected:
        assert fragment in joined
    # The switch is the power element, so results and issues map to it.
    assert res.element_map["line.dev1"] == "dev"


@pytest.mark.parametrize("device_type", ["fuse", "recloser", "relay"])
def test_each_device_solves_and_carries_load(device_type):
    result = engine.solve(_feeder(device_type, {}))
    assert result["converged"], result["issues"]
    assert result["buses"]["bus_b"]["vminPu"] > 0.9


@pytest.mark.parametrize("device_type", ["fuse", "recloser", "relay"])
def test_an_open_device_islands_what_is_downstream(device_type):
    result = engine.solve(_feeder(device_type, {"closed": False}))
    assert result["converged"], result["issues"]
    # De-energized, exactly as an open breaker leaves it.
    assert result["buses"]["bus_b"]["vmaxPu"] < 0.1


def test_a_relay_without_a_ground_curve_gets_no_ground_unit():
    joined = "\n".join(
        compile_circuit(_feeder("relay", {"groundcurve": "none"})).commands).lower()
    assert "groundcurve" not in joined
    assert "groundtrip" not in joined


def test_unknown_curve_names_fall_back_instead_of_reaching_the_engine():
    # A curve OpenDSS does not hold is a hard engine error that would take the
    # whole solve down, so the compiler only ever emits names from its list.
    joined = "\n".join(
        compile_circuit(_feeder("fuse", {"fusecurve": "nosuchcurve"})).commands).lower()
    assert "fusecurve=tlink" in joined
    assert "nosuchcurve" not in joined


@pytest.mark.parametrize("device_type,params,checks", [
    ("fuse", {"ratedcurrent": 40, "fusecurve": "klink"},
     {"fusecurve": "klink", "ratedcurrent": 40.0}),
    ("recloser", {"phasetrip": 120, "groundtrip": 40, "numfast": 2, "shots": 3},
     {"phasetrip": 120.0, "groundtrip": 40.0, "numfast": 2, "shots": 3}),
    ("relay", {"phasetrip": 250, "phasecurve": "ext_inv", "groundcurve": "none"},
     {"phasetrip": 250.0, "phasecurve": "ext_inv", "groundcurve": "none"}),
])
def test_devices_survive_export_and_import(device_type, params, checks):
    text, _ = export_dss(_feeder(device_type, params))
    imported = import_dss(text)
    assert not imported["unsupported"], imported["unsupported"]

    circuit = Circuit.model_validate(imported["circuit"])
    devices = [n for n in circuit.nodes if n.type == device_type]
    assert len(devices) == 1, f"expected one {device_type}, got {circuit.nodes}"
    for key, value in checks.items():
        assert devices[0].params[key] == value
    # And it is not left behind as a plain breaker.
    assert not [n for n in circuit.nodes if n.type == "breaker"]


def test_a_relay_type_we_do_not_model_imports_as_a_switch_with_a_warning():
    text = """
    new circuit.t basekv=12.47 pu=1.0 phases=3 bus1=b1 mvasc3=2000
    new line.sw1 bus1=b1 bus2=b2 phases=3 switch=yes normamps=600
    new relay.sw1 monitoredobj=line.sw1 monitoredterm=1 switchedobj=line.sw1 switchedterm=1 type=reversepower
    new load.l1 bus1=b2 phases=3 kv=12.47 kw=500 pf=0.95
    set voltagebases=[12.47]
    calcvoltagebases
    """
    imported = import_dss(text)
    circuit = Circuit.model_validate(imported["circuit"])
    assert [n.type for n in circuit.nodes if n.type in ("relay", "breaker")] == ["breaker"]
    assert any("reversepower" in w for w in imported["warnings"])


def test_an_open_device_is_a_stood_down_control_and_an_open_switch():
    """Order is the whole trick. Opening the switch alone is undone when the
    solve resets the control; disabling the control after opening re-closes
    it. Disable first, then open, and it holds — and unlike `action=open` on
    the control, which also holds, it does not abort the Linux engine."""
    cmds = "\n".join(compile_circuit(_feeder("fuse", {"closed": False})).commands)
    assert "action=open" not in cmds
    disable_at = cmds.index("disable fuse.dev1")
    open_at = cmds.index("open line.dev1")
    assert disable_at < open_at, "the control has to stand down before the switch opens"


def test_a_closed_device_is_neither_disabled_nor_opened():
    cmds = "\n".join(compile_circuit(_feeder("recloser", {})).commands)
    assert "disable" not in cmds
    assert "open line" not in cmds


@pytest.mark.parametrize("device_type", ["fuse", "recloser", "relay"])
def test_an_open_device_comes_back_as_that_device(device_type):
    """An open device is a disabled control, and the typed iterators walk only
    enabled ones — so a blown fuse used to come back as a plain breaker, losing
    both its type and its settings."""
    text, _ = export_dss(_feeder(device_type, {"closed": False}))
    circuit = Circuit.model_validate(import_dss(text)["circuit"])
    devices = [n for n in circuit.nodes if n.type == device_type]
    assert len(devices) == 1, [n.type for n in circuit.nodes]
    assert devices[0].params["closed"] is False
    assert not [n for n in circuit.nodes if n.type == "breaker"]
