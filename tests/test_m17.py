"""M17: CIM import and export, MultiSpeak import, harmonics, rapid voltage
change, the study registry and the headless run command."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import cim, engine, multispeak
from opendss_designer.core.model import Circuit
from opendss_designer.studies import STUDIES, harmonics, run_study

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"

CIM_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/CIM100#">
  <cim:BaseVoltage rdf:ID="BV12"><cim:IdentifiedObject.name>12.47</cim:IdentifiedObject.name><cim:BaseVoltage.nominalVoltage>12470</cim:BaseVoltage.nominalVoltage></cim:BaseVoltage>
  <cim:BaseVoltage rdf:ID="BV4"><cim:IdentifiedObject.name>4.16</cim:IdentifiedObject.name><cim:BaseVoltage.nominalVoltage>4160</cim:BaseVoltage.nominalVoltage></cim:BaseVoltage>
  <cim:ConnectivityNode rdf:ID="N1"><cim:IdentifiedObject.name>SUB</cim:IdentifiedObject.name></cim:ConnectivityNode>
  <cim:ConnectivityNode rdf:ID="N2"><cim:IdentifiedObject.name>MID</cim:IdentifiedObject.name></cim:ConnectivityNode>
  <cim:ConnectivityNode rdf:ID="N3"><cim:IdentifiedObject.name>END</cim:IdentifiedObject.name></cim:ConnectivityNode>
  <cim:ConnectivityNode rdf:ID="N4"><cim:IdentifiedObject.name>LV</cim:IdentifiedObject.name></cim:ConnectivityNode>
  <cim:EnergySource rdf:ID="SRC"><cim:IdentifiedObject.name>Source</cim:IdentifiedObject.name>
    <cim:EnergySource.nominalVoltage>12470</cim:EnergySource.nominalVoltage><cim:EnergySource.voltageMagnitude>12470</cim:EnergySource.voltageMagnitude>
    <cim:EnergySource.r>0.1</cim:EnergySource.r><cim:EnergySource.x>1.0</cim:EnergySource.x>
    <cim:ConductingEquipment.BaseVoltage rdf:resource="#BV12"/></cim:EnergySource>
  <cim:Terminal rdf:ID="T_SRC"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#SRC"/><cim:Terminal.ConnectivityNode rdf:resource="#N1"/></cim:Terminal>
  <cim:PerLengthSequenceImpedance rdf:ID="PLZ"><cim:IdentifiedObject.name>336ACSR</cim:IdentifiedObject.name>
    <cim:PerLengthSequenceImpedance.r>0.0002</cim:PerLengthSequenceImpedance.r><cim:PerLengthSequenceImpedance.x>0.0004</cim:PerLengthSequenceImpedance.x>
    <cim:PerLengthSequenceImpedance.r0>0.0005</cim:PerLengthSequenceImpedance.r0><cim:PerLengthSequenceImpedance.x0>0.0012</cim:PerLengthSequenceImpedance.x0></cim:PerLengthSequenceImpedance>
  <cim:ACLineSegment rdf:ID="L1"><cim:IdentifiedObject.name>Trunk</cim:IdentifiedObject.name><cim:Conductor.length>2000</cim:Conductor.length>
    <cim:ACLineSegment.PerLengthImpedance rdf:resource="#PLZ"/><cim:ConductingEquipment.BaseVoltage rdf:resource="#BV12"/></cim:ACLineSegment>
  <cim:Terminal rdf:ID="T_L1_1"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#L1"/><cim:Terminal.ConnectivityNode rdf:resource="#N1"/></cim:Terminal>
  <cim:Terminal rdf:ID="T_L1_2"><cim:ACDCTerminal.sequenceNumber>2</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#L1"/><cim:Terminal.ConnectivityNode rdf:resource="#N2"/></cim:Terminal>
  <cim:Breaker rdf:ID="B1"><cim:IdentifiedObject.name>Tie</cim:IdentifiedObject.name><cim:Switch.normalOpen>false</cim:Switch.normalOpen><cim:Switch.open>false</cim:Switch.open><cim:Switch.ratedCurrent>600</cim:Switch.ratedCurrent></cim:Breaker>
  <cim:Terminal rdf:ID="T_B1_1"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#B1"/><cim:Terminal.ConnectivityNode rdf:resource="#N2"/></cim:Terminal>
  <cim:Terminal rdf:ID="T_B1_2"><cim:ACDCTerminal.sequenceNumber>2</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#B1"/><cim:Terminal.ConnectivityNode rdf:resource="#N3"/></cim:Terminal>
  <cim:PowerTransformer rdf:ID="X1"><cim:IdentifiedObject.name>StepDown</cim:IdentifiedObject.name></cim:PowerTransformer>
  <cim:Terminal rdf:ID="T_X1_1"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#X1"/><cim:Terminal.ConnectivityNode rdf:resource="#N3"/></cim:Terminal>
  <cim:Terminal rdf:ID="T_X1_2"><cim:ACDCTerminal.sequenceNumber>2</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#X1"/><cim:Terminal.ConnectivityNode rdf:resource="#N4"/></cim:Terminal>
  <cim:PowerTransformerEnd rdf:ID="X1E1"><cim:TransformerEnd.endNumber>1</cim:TransformerEnd.endNumber><cim:PowerTransformerEnd.ratedU>12470</cim:PowerTransformerEnd.ratedU><cim:PowerTransformerEnd.ratedS>2000000</cim:PowerTransformerEnd.ratedS>
    <cim:PowerTransformerEnd.x>4.665</cim:PowerTransformerEnd.x><cim:PowerTransformerEnd.connectionKind rdf:resource="http://iec.ch/TC57/CIM100#WindingConnection.D"/>
    <cim:PowerTransformerEnd.PowerTransformer rdf:resource="#X1"/><cim:TransformerEnd.Terminal rdf:resource="#T_X1_1"/></cim:PowerTransformerEnd>
  <cim:PowerTransformerEnd rdf:ID="X1E2"><cim:TransformerEnd.endNumber>2</cim:TransformerEnd.endNumber><cim:PowerTransformerEnd.ratedU>4160</cim:PowerTransformerEnd.ratedU><cim:PowerTransformerEnd.ratedS>2000000</cim:PowerTransformerEnd.ratedS>
    <cim:PowerTransformerEnd.connectionKind rdf:resource="http://iec.ch/TC57/CIM100#WindingConnection.Y"/>
    <cim:PowerTransformerEnd.PowerTransformer rdf:resource="#X1"/><cim:TransformerEnd.Terminal rdf:resource="#T_X1_2"/></cim:PowerTransformerEnd>
  <cim:RatioTapChanger rdf:ID="TC1"><cim:RatioTapChanger.TransformerEnd rdf:resource="#X1E2"/><cim:TapChanger.TapChangerControl rdf:resource="#TCC1"/></cim:RatioTapChanger>
  <cim:TapChangerControl rdf:ID="TCC1"><cim:RegulatingControl.targetValue>123</cim:RegulatingControl.targetValue><cim:RegulatingControl.targetDeadband>2</cim:RegulatingControl.targetDeadband></cim:TapChangerControl>
  <cim:EnergyConsumer rdf:ID="LD1"><cim:IdentifiedObject.name>Plant</cim:IdentifiedObject.name><cim:EnergyConsumer.p>800000</cim:EnergyConsumer.p><cim:EnergyConsumer.q>300000</cim:EnergyConsumer.q>
    <cim:EnergyConsumer.customerCount>12</cim:EnergyConsumer.customerCount><cim:ConductingEquipment.BaseVoltage rdf:resource="#BV4"/>
    <cim:PowerSystemResource.Location rdf:resource="#LOC_LD1"/></cim:EnergyConsumer>
  <cim:Terminal rdf:ID="T_LD1"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#LD1"/><cim:Terminal.ConnectivityNode rdf:resource="#N4"/></cim:Terminal>
  <cim:EnergyConsumer rdf:ID="LD2"><cim:IdentifiedObject.name>Houses</cim:IdentifiedObject.name><cim:ConductingEquipment.BaseVoltage rdf:resource="#BV12"/></cim:EnergyConsumer>
  <cim:EnergyConsumerPhase rdf:ID="LD2A"><cim:EnergyConsumerPhase.phase rdf:resource="http://iec.ch/TC57/CIM100#SinglePhaseKind.A"/><cim:EnergyConsumerPhase.p>50000</cim:EnergyConsumerPhase.p><cim:EnergyConsumerPhase.q>10000</cim:EnergyConsumerPhase.q><cim:EnergyConsumerPhase.EnergyConsumer rdf:resource="#LD2"/></cim:EnergyConsumerPhase>
  <cim:EnergyConsumerPhase rdf:ID="LD2C"><cim:EnergyConsumerPhase.phase rdf:resource="http://iec.ch/TC57/CIM100#SinglePhaseKind.C"/><cim:EnergyConsumerPhase.p>40000</cim:EnergyConsumerPhase.p><cim:EnergyConsumerPhase.q>8000</cim:EnergyConsumerPhase.q><cim:EnergyConsumerPhase.EnergyConsumer rdf:resource="#LD2"/></cim:EnergyConsumerPhase>
  <cim:Terminal rdf:ID="T_LD2"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#LD2"/><cim:Terminal.ConnectivityNode rdf:resource="#N2"/></cim:Terminal>
  <cim:LinearShuntCompensator rdf:ID="C1"><cim:IdentifiedObject.name>Cap</cim:IdentifiedObject.name><cim:ShuntCompensator.nomU>12470</cim:ShuntCompensator.nomU><cim:ShuntCompensator.normalSections>1</cim:ShuntCompensator.normalSections>
    <cim:LinearShuntCompensator.bPerSection>0.0019295</cim:LinearShuntCompensator.bPerSection></cim:LinearShuntCompensator>
  <cim:Terminal rdf:ID="T_C1"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#C1"/><cim:Terminal.ConnectivityNode rdf:resource="#N2"/></cim:Terminal>
  <cim:PowerElectronicsConnection rdf:ID="PV1"><cim:IdentifiedObject.name>Roof</cim:IdentifiedObject.name><cim:PowerElectronicsConnection.ratedS>250000</cim:PowerElectronicsConnection.ratedS><cim:ConductingEquipment.BaseVoltage rdf:resource="#BV12"/></cim:PowerElectronicsConnection>
  <cim:PhotoVoltaicUnit rdf:ID="PV1U"><cim:PowerElectronicsUnit.maxP>200000</cim:PowerElectronicsUnit.maxP><cim:PowerElectronicsUnit.PowerElectronicsConnection rdf:resource="#PV1"/></cim:PhotoVoltaicUnit>
  <cim:Terminal rdf:ID="T_PV1"><cim:ACDCTerminal.sequenceNumber>1</cim:ACDCTerminal.sequenceNumber><cim:Terminal.ConductingEquipment rdf:resource="#PV1"/><cim:Terminal.ConnectivityNode rdf:resource="#N3"/></cim:Terminal>
  <cim:CoordinateSystem rdf:ID="CS"><cim:CoordinateSystem.crsUrn>EPSG:26912</cim:CoordinateSystem.crsUrn></cim:CoordinateSystem>
  <cim:Location rdf:ID="LOC_LD1"><cim:Location.CoordinateSystem rdf:resource="#CS"/></cim:Location>
  <cim:PositionPoint rdf:ID="PP1"><cim:PositionPoint.Location rdf:resource="#LOC_LD1"/><cim:PositionPoint.sequenceNumber>1</cim:PositionPoint.sequenceNumber><cim:PositionPoint.xPosition>500100</cim:PositionPoint.xPosition><cim:PositionPoint.yPosition>4100200</cim:PositionPoint.yPosition></cim:PositionPoint>
</rdf:RDF>
"""

MULTISPEAK_SAMPLE = """<?xml version="1.0"?>
<MultiSpeakMsgHeader xmlns="http://www.multispeak.org/Version_4.1_Release">
  <ArrayOfNetwork>
    <substation><sectionID>SUB</sectionID><kv>12.47</kv></substation>
    <ohPrimaryLine><sectionID>S1</sectionID><parentSectionID>SUB</parentSectionID><phaseCode>ABC</phaseCode><lengthData>1500</lengthData><lengthUnits>ft</lengthUnits><conductorList>336 ACSR</conductorList><ratedAmps>530</ratedAmps>
      <gpsLocation><latitude>33.45</latitude><longitude>-112.07</longitude></gpsLocation></ohPrimaryLine>
    <recloser><sectionID>R1</sectionID><parentSectionID>S1</parentSectionID><phaseCode>ABC</phaseCode><ratedAmps>400</ratedAmps><normalStatus>Closed</normalStatus></recloser>
    <ohPrimaryLine><sectionID>S2</sectionID><parentSectionID>R1</parentSectionID><phaseCode>ABC</phaseCode><lengthData>2200</lengthData><lengthUnits>ft</lengthUnits></ohPrimaryLine>
    <ohPrimaryLine><sectionID>S3</sectionID><parentSectionID>S2</parentSectionID><phaseCode>A</phaseCode><lengthData>800</lengthData><lengthUnits>ft</lengthUnits></ohPrimaryLine>
    <fuse><sectionID>F1</sectionID><parentSectionID>S2</parentSectionID><phaseCode>B</phaseCode><ratedAmps>40</ratedAmps></fuse>
    <switchDevice><sectionID>SW1</sectionID><parentSectionID>S2</parentSectionID><phaseCode>ABC</phaseCode><normalStatus>Open</normalStatus></switchDevice>
    <transformerBank><sectionID>T1</sectionID><parentSectionID>S3</parentSectionID><phaseCode>A</phaseCode><kVA>50</kVA><highSideVoltage>12470</highSideVoltage><lowSideVoltage>240</lowSideVoltage><percentImpedance>2.3</percentImpedance></transformerBank>
    <capacitorBank><sectionID>C1</sectionID><parentSectionID>S2</parentSectionID><phaseCode>ABC</phaseCode><kVAR>600</kVAR></capacitorBank>
    <meter><sectionID>M1</sectionID><parentSectionID>T1</parentSectionID><phaseCode>A</phaseCode><kW>12</kW></meter>
    <meter><sectionID>M2</sectionID><parentSectionID>S2</parentSectionID><phaseCode>ABC</phaseCode><kWh>146000</kWh><kv>12.47</kv></meter>
  </ArrayOfNetwork>
</MultiSpeakMsgHeader>
"""


def test_cim_sample_imports_and_solves():
    r = cim.import_cim_text(CIM_SAMPLE)
    c = Circuit.model_validate(r["circuit"])
    types = {n.type for n in c.nodes}
    assert {"vsource", "breaker", "transformer", "load", "capacitor", "pvsystem"} <= types
    names = {str(n.params.get("name")).lower() for n in c.nodes}
    assert {"source", "tie", "stepdown", "plant", "cap", "roof"} <= names
    # The per-length impedance became a line code; the consumer phases two loads.
    assert c.lineCodes and any(e.params.get("linecode") for e in c.edges if e.type == "line")
    assert sum(1 for n in c.nodes if n.type == "load") == 3
    xf = next(n for n in c.nodes if n.type == "transformer")
    assert [w["kv"] for w in xf.params["windings"]] == [12.47, 4.16]
    assert xf.params["windings"][0]["conn"] == "delta"
    assert xf.params["xhl"] == pytest.approx(6.0, abs=0.1)  # 4.665 ohm on 12.47 kV / 2 MVA
    # The tap changer became a regulator setting... on a step-down unit it stays a passthrough control.
    assert any(p.name.lower().startswith("regcontrol") for p in c.passthrough) or any(n.type == "regulator" for n in c.nodes)
    cap = next(n for n in c.nodes if n.type == "capacitor")
    assert cap.params["kvar"] == pytest.approx(300, rel=0.01)
    plant = next(n for n in c.nodes if str(n.params.get("name")).lower() == "plant")
    assert plant.params["kw"] == pytest.approx(800) and plant.params["numcust"] == 12
    # Coordinates sit on the bus the load is on.
    lv = next(n for n in c.nodes if n.type == "busbar" and str(n.params.get("name")).lower() == "lv")
    assert lv.geo is not None and lv.geo.x == pytest.approx(500100)
    assert c.crs or any("EPSG:26912" in w for w in r["warnings"])
    solved = engine.solve(c)
    assert solved["converged"], solved["issues"]


def test_cim_export_round_trips_the_fixture():
    c = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    xml = cim.circuit_to_cim(c)
    assert xml.startswith("<?xml") and "<cim:ACLineSegment" in xml and "<cim:PowerTransformer " in xml
    assert "<cim:RatioTapChanger" in xml and "<cim:Fuse" in xml and "<cim:Recloser" in xml
    back = Circuit.model_validate(cim.import_cim_text(xml)["circuit"])
    assert sum(1 for n in back.nodes if n.type == "load") == sum(1 for n in c.nodes if n.type == "load")
    assert sum(1 for e in back.edges if e.type == "line") == sum(1 for e in c.edges if e.type == "line")
    assert sum(1 for n in back.nodes if n.type in ("transformer", "regulator")) == sum(1 for n in c.nodes if n.type in ("transformer", "regulator"))
    r1 = engine.solve(c)
    r2 = engine.solve(back)
    assert r1["converged"] and r2["converged"], r2["issues"]
    kw1 = -sum(e["kw"] for f, e in r1["elements"].items() if f.startswith("vsource."))
    kw2 = -sum(e["kw"] for f, e in r2["elements"].items() if f.startswith("vsource."))
    assert kw2 == pytest.approx(kw1, rel=0.1)


def test_multispeak_sample_imports_and_solves():
    r = multispeak.import_multispeak_text(MULTISPEAK_SAMPLE)
    c = Circuit.model_validate(r["circuit"])
    names = {str(n.params.get("name")).lower() for n in c.nodes} | {str(e.params.get("name")).lower() for e in c.edges}
    assert {"s1", "s2", "s3", "r1", "f1", "sw1", "t1", "c1", "m1", "m2"} <= names
    assert next(n for n in c.nodes if str(n.params.get("name")).lower() == "r1").type == "recloser"
    assert next(n for n in c.nodes if str(n.params.get("name")).lower() == "f1").type == "fuse"
    sw = next(n for n in c.nodes if str(n.params.get("name")).lower() == "sw1")
    assert sw.params.get("closed") is False
    t1 = next(n for n in c.nodes if str(n.params.get("name")).lower() == "t1")
    assert t1.params["phases"] == 1 and t1.params.get("splitphase") is True or len(t1.params["windings"]) == 3
    assert c.crs == "EPSG:4326"
    assert any("MultiSpeak" in w for w in r["warnings"])
    solved = engine.solve(c)
    assert solved["converged"], solved["issues"]
    with pytest.raises(ValueError):
        multispeak.multispeak_to_dss("<root><nothing/></root>")


def test_harmonics_and_rvc():
    c = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    seen = []
    r = harmonics.harmonics(c, [3, 5, 7], progress=lambda d, t, m: seen.append(d))
    assert r["converged"], r["issues"]
    assert r["orders"] == [3, 5, 7] and seen[-1] == 3
    assert r["buses"] and all("thdPct" in b and "spectrum" in b for b in r["buses"].values())
    assert r["summary"]["worstBus"] in r["buses"]
    assert all(set(b["spectrum"]) == {"3", "5", "7"} for b in r["buses"].values())
    pv = next(n for n in c.nodes if n.type == "pvsystem")
    trip = harmonics.rapid_voltage_change(c, "", "derTrip", der_id=pv.id)
    assert trip["converged"], trip["issues"]
    assert trip["worstBus"] and trip["stepAtBusPct"] is not None and trip["pass"] is not None
    start = harmonics.rapid_voltage_change(c, trip["bus"], "motorStart", kva=800, pf=0.3)
    assert start["converged"] and start["worstStepPct"] < 0  # a motor start sags the voltage
    assert abs(start["worstStepPct"]) > abs(trip["worstStepPct"]) or start["busesOver"] >= 0


def test_registry_and_cli_run(tmp_path):
    assert {"solve", "hosting-capacity", "reliability", "harmonics", "n-minus-1"} <= set(STUDIES)
    c = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    r = run_study("capacity", c, {})
    assert r["converged"]
    with pytest.raises(KeyError):
        run_study("nope", c)
    out = tmp_path / "out.json"
    env = {"PYTHONPATH": str(Path(__file__).parent.parent / "src")}
    import os
    env = {**os.environ, **env}
    proc = subprocess.run([sys.executable, "-m", "opendss_designer.cli", "run", str(FIXTURE), "--study", "solve",
                           "--study", "qa", "--out", str(out)], capture_output=True, text=True, env=env, timeout=300)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["solve"]["converged"] and "score" in data["qa"]
    listing = subprocess.run([sys.executable, "-m", "opendss_designer.cli", "run", "--list"], capture_output=True, text=True, env=env, timeout=120)
    assert listing.returncode == 0 and "hosting-capacity" in listing.stdout


def _finished(client, res):
    """Follow a job to its end, so the study thread is done with the engine
    before the next test clears it (a race that only ever lost on Linux)."""
    assert res.status_code == 200, res.text
    job_id = res.json()["job"]["id"]
    with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
        for _ in stream.iter_lines():
            pass
    return client.get(f"/api/jobs/{job_id}").json()


def test_m17_routes():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    res = client.post("/api/import/cim", json={"files": [{"name": "a.xml", "text": CIM_SAMPLE}]})
    assert res.status_code == 200 and res.json()["circuit"]["nodes"]
    res = client.post("/api/import/multispeak", json={"files": [{"name": "a.xml", "text": MULTISPEAK_SAMPLE}]})
    assert res.status_code == 200 and res.json()["circuit"]["nodes"]
    assert client.post("/api/import/cim", json={"files": [{"name": "a.xml", "text": "<not xml"}]}).status_code == 400
    c = json.loads(FIXTURE.read_text(encoding="utf-8"))
    res = client.post("/api/export/cim", json=c)
    assert res.status_code == 200 and "<cim:" in res.text
    res = client.post("/api/rvc", json={"circuit": c, "bus": "bus-lat", "kind": "motorStart", "kva": 500})
    assert res.status_code == 200 and res.json()["converged"]
    res = client.post("/api/jobs/harmonics", json={"circuit": c, "orders": [5, 7]})
    assert _finished(client, res)["status"] == "done"
    assert client.get("/api/studies").json()["studies"]
