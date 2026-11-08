"""CIM import and export: IEC 61968-13 (CDPSM / CIM100) RDF/XML.

The exchange format the large utilities' GIS and both Synergi and CYME
speak. This reader covers the distribution profile's equipment classes
and turns them into OpenDSS text for the ordinary importer, so a CIM file
arrives on the drawing the same way a `.dss` file does:

* buses from `ConnectivityNode` (`TopologicalNode` when that is all there
  is), joined to equipment through `Terminal`;
* `ACLineSegment` with its own r/x/r0/x0 or a `PerLengthSequenceImpedance`
  / `PerLengthPhaseImpedance`; `EnergyConsumer` (+ `EnergyConsumerPhase`);
  `EnergySource`; `PowerTransformer` with `PowerTransformerEnd`s (or the
  asset form, `TransformerTank` + `TransformerTankEnd` + `TransformerEndInfo`)
  and a `RatioTapChanger` as a RegControl; `Breaker`, `Disconnector`,
  `LoadBreakSwitch`, `Fuse`, `Recloser`, `Sectionaliser`, `Jumper`;
  `LinearShuntCompensator`; `PowerElectronicsConnection` with a
  `PhotoVoltaicUnit` or `BatteryUnit`; `SynchronousMachine`;
  `BaseVoltage`; `Location` / `PositionPoint` for coordinates.

The writer emits the same classes from a circuit, so a model drawn here
can go to a CIM tool. Element names are `IdentifiedObject.name`; rdf:IDs
are kept as the element ids where they are legal names.
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from typing import Any
from xml.sax.saxutils import escape

from .connectivity import synthesize
from .model import Circuit

RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
CIM_NS_CANDIDATES = ("http://iec.ch/TC57/CIM100#", "http://iec.ch/TC57/2013/CIM-schema-cim16#",
                     "http://iec.ch/TC57/2012/CIM-schema-cim16#", "http://iec.ch/TC57/CIM-generic#")

_SWITCH_CLASSES = {"Breaker": "breaker", "Disconnector": "breaker", "LoadBreakSwitch": "breaker",
                   "Switch": "breaker", "Jumper": "breaker", "GroundDisconnector": "breaker",
                   "Fuse": "fuse", "Recloser": "recloser", "Sectionaliser": "sectionalizer",
                   "ProtectedSwitch": "breaker"}


def _local(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _safe(name: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_\-]+", "_", str(name).strip()) or "x"
    return out[:60]


class _Obj:
    __slots__ = ("id", "cls", "props", "refs")

    def __init__(self, oid: str, cls: str) -> None:
        self.id = oid
        self.cls = cls
        self.props: dict[str, str] = {}
        self.refs: dict[str, str] = {}

    def num(self, key: str, default: float | None = None) -> float | None:
        v = self.props.get(key)
        if v is None:
            return default
        try:
            return float(v)
        except ValueError:
            return default

    @property
    def name(self) -> str:
        return self.props.get("IdentifiedObject.name") or self.props.get("IdentifiedObject.mRID") or self.id


def _parse(text: str) -> dict[str, _Obj]:
    root = ET.fromstring(text)
    objs: dict[str, _Obj] = {}
    for el in root:
        oid = el.get(f"{{{RDF}}}ID") or el.get(f"{{{RDF}}}about") or ""
        oid = oid.lstrip("#").removeprefix("_") if oid else f"anon{len(objs)}"
        if oid.startswith("urn:uuid:"):
            oid = oid[9:]
        obj = _Obj(oid, _local(el.tag))
        for child in el:
            key = _local(child.tag)
            ref = child.get(f"{{{RDF}}}resource")
            if ref is not None:
                target = ref.lstrip("#").removeprefix("_")
                if target.startswith("urn:uuid:"):
                    target = target[9:]
                obj.refs[key] = target
                # Enumerations arrive as references into the CIM namespace.
                if "#" in ref and "." in target:
                    obj.props[key] = target.rsplit(".", 1)[1]
            elif child.text is not None:
                obj.props[key] = child.text.strip()
        objs[oid] = obj
    return objs


def _by_class(objs: dict[str, _Obj], *classes: str) -> list[_Obj]:
    return [o for o in objs.values() if o.cls in classes]


def cim_to_dss(text: str) -> tuple[str, list[str]]:
    """OpenDSS text for a CIM RDF/XML document, and the notes to show."""
    objs = _parse(text)
    notes: list[str] = []
    # Terminals: equipment -> ordered connectivity nodes.
    terms: dict[str, list[tuple[int, str, str]]] = {}
    node_names: dict[str, str] = {}
    for cn in _by_class(objs, "ConnectivityNode", "TopologicalNode"):
        node_names[cn.id] = _safe(cn.name).lower()
    for t in _by_class(objs, "Terminal"):
        eq = t.refs.get("Terminal.ConductingEquipment")
        cn = t.refs.get("Terminal.ConnectivityNode") or t.refs.get("Terminal.TopologicalNode")
        if not eq or not cn:
            continue
        seq = int(t.num("ACDCTerminal.sequenceNumber", t.num("Terminal.sequenceNumber", 0)) or 0)
        phases = t.props.get("Terminal.phases", "")
        terms.setdefault(eq, []).append((seq or len(terms.get(eq, [])) + 1, node_names.get(cn, _safe(cn).lower()), phases))
    for v in terms.values():
        v.sort()

    def buses(eq_id: str) -> list[str]:
        return [b for _, b, _ in terms.get(eq_id, [])]

    base_kv: dict[str, float] = {}
    for bv in _by_class(objs, "BaseVoltage"):
        v = bv.num("BaseVoltage.nominalVoltage")
        if v:
            base_kv[bv.id] = v / 1000.0

    def kv_of(obj: _Obj, default: float = 12.47) -> float:
        bv = obj.refs.get("ConductingEquipment.BaseVoltage")
        return base_kv.get(bv, default) if bv else default

    def phase_suffix(code: str) -> str:
        letters = [c for c in code.upper() if c in "ABC"]
        if not letters or len(letters) == 3:
            return ""
        return "." + ".".join(str("ABC".index(c) + 1) for c in letters)

    lines: list[str] = []
    kv_bases: set[float] = set()
    # Sources
    sources = _by_class(objs, "EnergySource")
    if sources:
        src = sources[0]
        kv = kv_of(src, (src.num("EnergySource.nominalVoltage") or 12470) / 1000.0)
        kv_bases.add(kv)
        bus = (buses(src.id) or ["sourcebus"])[0]
        vmag = src.num("EnergySource.voltageMagnitude")
        pu = (vmag / 1000.0 / kv) if vmag else 1.0
        if pu > 1.5:  # line-to-neutral magnitude
            pu = pu / math.sqrt(3)
        r1, x1 = src.num("EnergySource.r", 0.0) or 0.0, src.num("EnergySource.x", 0.0) or 0.0
        r0, x0 = src.num("EnergySource.r0", r1) or r1, src.num("EnergySource.x0", x1) or x1
        imp = f" r1={r1:.6g} x1={x1:.6g} r0={r0:.6g} x0={x0:.6g}" if (r1 or x1) else " mvasc3=2000 mvasc1=2100"
        lines.append(f"new circuit.{_safe(src.name)} basekv={kv:.6g} pu={pu:.5g} phases=3 bus1={bus}{imp}")
        for extra in sources[1:]:
            b = (buses(extra.id) or ["sourcebus"])[0]
            lines.append(f"new vsource.{_safe(extra.name)} basekv={kv_of(extra):.6g} pu=1 phases=3 bus1={b}")
    else:
        notes.append("No EnergySource in the file; a 12.47 kV source was placed at the first bus.")
        first = next(iter(node_names.values()), "sourcebus")
        lines.append(f"new circuit.cim basekv=12.47 pu=1 phases=3 bus1={first} mvasc3=2000 mvasc1=2100")
        kv_bases.add(12.47)

    # Per-length impedances
    plsi: dict[str, str] = {}
    for p in _by_class(objs, "PerLengthSequenceImpedance"):
        r, x = p.num("PerLengthSequenceImpedance.r", 0.1) or 0.1, p.num("PerLengthSequenceImpedance.x", 0.3) or 0.3
        r0, x0 = p.num("PerLengthSequenceImpedance.r0", 3 * r) or 3 * r, p.num("PerLengthSequenceImpedance.x0", 3 * x) or 3 * x
        c = p.num("PerLengthSequenceImpedance.bch")
        name = _safe(p.name)
        cap = f" c1={c / (2 * math.pi * 60) * 1e9:.6g}" if c else ""
        lines.append(f"new linecode.{name} nphases=3 units=m r1={r * 1000:.6g} x1={x * 1000:.6g} r0={r0 * 1000:.6g} x0={x0 * 1000:.6g}{cap}")
        plsi[p.id] = name
    for p in _by_class(objs, "PerLengthPhaseImpedance"):
        n = int(p.num("PerLengthPhaseImpedance.conductorCount", 3) or 3)
        data = [d for d in _by_class(objs, "PhaseImpedanceData") if d.refs.get("PhaseImpedanceData.PhaseImpedance") == p.id]
        if not data:
            continue
        rm = [[0.0] * n for _ in range(n)]
        xm = [[0.0] * n for _ in range(n)]
        for d in data:
            i = int(d.num("PhaseImpedanceData.row", d.num("PhaseImpedanceData.sequenceNumber", 1)) or 1) - 1
            j = int(d.num("PhaseImpedanceData.column", 1) or 1) - 1
            if not d.props.get("PhaseImpedanceData.column"):
                # sequence-numbered lower triangle
                seq = i
                i, j = _triangle(seq, n)
            if 0 <= i < n and 0 <= j < n:
                rm[i][j] = rm[j][i] = (d.num("PhaseImpedanceData.r", 0.0) or 0.0) * 1000
                xm[i][j] = xm[j][i] = (d.num("PhaseImpedanceData.x", 0.0) or 0.0) * 1000
        name = _safe(p.name)
        tri = lambda m: " | ".join(" ".join(f"{m[i][j]:.6g}" for j in range(i + 1)) for i in range(n))  # noqa: E731
        lines.append(f"new linecode.{name} nphases={n} units=m rmatrix=({tri(rm)}) xmatrix=({tri(xm)})")
        plsi[p.id] = name

    # Lines
    for seg in _by_class(objs, "ACLineSegment"):
        b = buses(seg.id)
        if len(b) < 2:
            notes.append(f"ACLineSegment {seg.name} has fewer than two terminals and was skipped.")
            continue
        kv_bases.add(kv_of(seg))
        length = seg.num("Conductor.length", 1.0) or 1.0
        phases = terms[seg.id][0][2] if terms.get(seg.id) else ""
        sfx = phase_suffix(phases)
        nph = len(sfx.split(".")) - 1 if sfx else 3
        code = plsi.get(seg.refs.get("ACLineSegment.PerLengthImpedance", ""))
        if code:
            imp = f"linecode={code}"
        else:
            r, x = seg.num("ACLineSegment.r", 0.1) or 0.1, seg.num("ACLineSegment.x", 0.3) or 0.3
            r0, x0 = seg.num("ACLineSegment.r0", 3 * r) or 3 * r, seg.num("ACLineSegment.x0", 3 * x) or 3 * x
            # CIM r/x are totals for the segment; OpenDSS wants per unit length.
            imp = f"r1={r / length:.6g} x1={x / length:.6g} r0={r0 / length:.6g} x0={x0 / length:.6g}"
        amps = _current_limit(objs, seg.id)
        rating = f" normamps={amps:.6g}" if amps else ""
        lines.append(f"new line.{_safe(seg.name)} bus1={b[0]}{sfx} bus2={b[1]}{sfx} phases={nph} {imp} length={length:.6g} units=m{rating}")

    # Switches and protective devices
    for sw in [o for o in objs.values() if o.cls in _SWITCH_CLASSES]:
        b = buses(sw.id)
        if len(b) < 2:
            continue
        kind = _SWITCH_CLASSES[sw.cls]
        name = _safe(sw.name)
        is_open = sw.props.get("Switch.open", sw.props.get("Switch.normalOpen", "false")).lower() == "true"
        amps = sw.num("Switch.ratedCurrent") or _current_limit(objs, sw.id)
        rating = f" normamps={amps:.6g}" if amps else ""
        phases = terms[sw.id][0][2] if terms.get(sw.id) else ""
        sfx = phase_suffix(phases)
        nph = len(sfx.split(".")) - 1 if sfx else 3
        lines.append(f"new line.{name} bus1={b[0]}{sfx} bus2={b[1]}{sfx} phases={nph} switch=yes{rating}")
        watch = f"monitoredobj=line.{name} monitoredterm=1 switchedobj=line.{name} switchedterm=1"
        if kind == "fuse":
            lines.append(f"new fuse.{name} {watch} fusecurve=tlink ratedcurrent={amps or 65:.6g}")
        elif kind == "recloser":
            lines.append(f"new recloser.{name} {watch} phasefast=a phasedelayed=d phasetrip={(amps or 100):.6g}")
        if is_open:
            lines.append(f"open line.{name} term=1")

    # Transformers: end form or tank form.
    for xf in _by_class(objs, "PowerTransformer"):
        ends = [e for e in _by_class(objs, "PowerTransformerEnd") if e.refs.get("PowerTransformerEnd.PowerTransformer") == xf.id]
        if not ends:
            tanks = [t for t in _by_class(objs, "TransformerTank") if t.refs.get("TransformerTank.PowerTransformer") == xf.id]
            ends = [e for e in _by_class(objs, "TransformerTankEnd") if e.refs.get("TransformerTankEnd.TransformerTank") in {t.id for t in tanks}]
        if len(ends) < 2:
            notes.append(f"PowerTransformer {xf.name} has no usable ends and was skipped.")
            continue
        ends.sort(key=lambda e: int(e.num("TransformerEnd.endNumber", 1) or 1))
        end_bus: list[str] = []
        kvs: list[float] = []
        kvas: list[float] = []
        conns: list[str] = []
        rs: list[float] = []
        for e in ends:
            t_ref = e.refs.get("TransformerEnd.Terminal")
            tobj = objs.get(t_ref or "")
            cn = tobj.refs.get("Terminal.ConnectivityNode") if tobj else None
            end_bus.append(node_names.get(cn or "", _safe(cn or "x").lower()))
            u = e.num("PowerTransformerEnd.ratedU") or _end_info(objs, e, "ratedU") or 12470.0
            s = e.num("PowerTransformerEnd.ratedS") or _end_info(objs, e, "ratedS") or 1e6
            kvs.append(u / 1000.0)
            kvas.append(s / 1000.0)
            conn = e.props.get("PowerTransformerEnd.connectionKind") or _end_info_str(objs, e, "connectionKind") or "Y"
            conns.append("delta" if conn.upper().startswith("D") else "wye")
            r = e.num("PowerTransformerEnd.r") or 0.0
            rs.append(100.0 * r * s / (u * u) if (r and u) else 0.0)
        x = ends[0].num("PowerTransformerEnd.x") or 0.0
        xhl = 100.0 * x * (kvas[0] * 1000) / ((kvs[0] * 1000) ** 2) if x else _end_info_x(objs, ends[0]) or 8.0
        nph = 3
        name = _safe(xf.name)
        bus_list = ", ".join(end_bus[:3])
        rpart = f" %rs=({', '.join(f'{r:.5g}' for r in rs[:3])})" if any(rs) else ""
        lines.append(f"new transformer.{name} phases={nph} windings={min(len(ends), 3)} buses=({bus_list}) "
                     f"conns=({', '.join(conns[:3])}) kvs=({', '.join(f'{k:.6g}' for k in kvs[:3])}) "
                     f"kvas=({', '.join(f'{k:.6g}' for k in kvas[:3])}) xhl={xhl:.6g}{rpart}")
        kv_bases.update(kvs[:3])
        # Tap changer -> RegControl
        for tc in _by_class(objs, "RatioTapChanger"):
            if tc.refs.get("RatioTapChanger.TransformerEnd") in {e.id for e in ends}:
                ctrl = objs.get(tc.refs.get("TapChanger.TapChangerControl", "") or "")
                vreg = (ctrl.num("RegulatingControl.targetValue") if ctrl else None) or 120.0
                band = (ctrl.num("RegulatingControl.targetDeadband") if ctrl else None) or 2.0
                if vreg > 300:  # volts on the regulated side rather than the 120 V base
                    end_idx = next((i for i, e in enumerate(ends) if e.id == tc.refs.get("RatioTapChanger.TransformerEnd")), 1)
                    ratio = kvs[end_idx] * 1000 / math.sqrt(3) / 120.0
                    vreg, band = vreg / ratio, band / ratio
                lines.append(f"new regcontrol.{name} transformer={name} winding=2 vreg={vreg:.5g} band={band:.4g}")
                break

    # Loads
    for ld in _by_class(objs, "EnergyConsumer", "ConformLoad", "NonConformLoad"):
        b = buses(ld.id)
        if not b:
            continue
        p = ld.num("EnergyConsumer.p", 0.0) or 0.0
        q = ld.num("EnergyConsumer.q", 0.0) or 0.0
        phs = [o for o in _by_class(objs, "EnergyConsumerPhase") if o.refs.get("EnergyConsumerPhase.EnergyConsumer") == ld.id]
        kv = kv_of(ld)
        kv_bases.add(kv)
        cust = ld.num("EnergyConsumer.customerCount")
        cust_s = f" numcust={int(cust)}" if cust else ""
        if phs:
            for ph in phs:
                letter = ph.props.get("EnergyConsumerPhase.phase", "A")[-1:]
                idx = "ABC".find(letter.upper()) + 1 if letter.upper() in "ABC" else 1
                pp, pq = (ph.num("EnergyConsumerPhase.p", 0.0) or 0.0) / 1000, (ph.num("EnergyConsumerPhase.q", 0.0) or 0.0) / 1000
                lines.append(f"new load.{_safe(ld.name)}_{letter} bus1={b[0]}.{idx} phases=1 kv={kv / math.sqrt(3):.6g} kw={pp:.6g} kvar={pq:.6g} model=1{cust_s}")
        else:
            phases = terms[ld.id][0][2] if terms.get(ld.id) else ""
            sfx = phase_suffix(phases)
            nph = len(sfx.split(".")) - 1 if sfx else 3
            lkv = kv if nph == 3 else kv / math.sqrt(3)
            lines.append(f"new load.{_safe(ld.name)} bus1={b[0]}{sfx} phases={nph} kv={lkv:.6g} kw={p / 1000:.6g} kvar={q / 1000:.6g} model=1{cust_s}")

    # Shunt capacitors
    for cap in _by_class(objs, "LinearShuntCompensator"):
        b = buses(cap.id)
        if not b:
            continue
        nom = (cap.num("ShuntCompensator.nomU") or kv_of(cap) * 1000) / 1000.0
        bps = cap.num("LinearShuntCompensator.bPerSection", 0.0) or 0.0
        sections = cap.num("ShuntCompensator.normalSections", 1) or 1
        kvar = bps * (nom * 1000) ** 2 / 1000.0 * sections
        kv_bases.add(nom)
        lines.append(f"new capacitor.{_safe(cap.name)} bus1={b[0]} phases=3 kv={nom:.6g} kvar={kvar:.6g} numsteps={int(sections)}")

    # DER
    for pec in _by_class(objs, "PowerElectronicsConnection"):
        b = buses(pec.id)
        if not b:
            continue
        units = [u for u in _by_class(objs, "PhotoVoltaicUnit", "BatteryUnit", "PowerElectronicsWindUnit")
                 if u.refs.get("PowerElectronicsUnit.PowerElectronicsConnection") == pec.id]
        kva = (pec.num("PowerElectronicsConnection.ratedS") or 100000) / 1000.0
        maxp = (units[0].num("PowerElectronicsUnit.maxP") if units else None) or (pec.num("PowerElectronicsConnection.p") or kva * 1000)
        kv = kv_of(pec)
        kv_bases.add(kv)
        if units and units[0].cls == "BatteryUnit":
            kwh = (units[0].num("BatteryUnit.ratedE") or maxp * 2) / 1000.0
            lines.append(f"new storage.{_safe(pec.name)} bus1={b[0]} phases=3 kv={kv:.6g} kwrated={abs(maxp) / 1000:.6g} kwhrated={kwh:.6g}")
        else:
            lines.append(f"new pvsystem.{_safe(pec.name)} bus1={b[0]} phases=3 kv={kv:.6g} kva={kva:.6g} pmpp={abs(maxp) / 1000:.6g} irradiance=1 pf=1")
    for gen in _by_class(objs, "SynchronousMachine"):
        b = buses(gen.id)
        if not b:
            continue
        kv = kv_of(gen)
        kv_bases.add(kv)
        p = abs(gen.num("RotatingMachine.p", 0.0) or 0.0) / 1000.0
        s = (gen.num("RotatingMachine.ratedS") or p * 1200) / 1000.0
        unit = objs.get(gen.refs.get("RotatingMachine.GeneratingUnit", "") or "")
        if not p and unit is not None:
            p = (unit.num("GeneratingUnit.ratedNetMaxP") or unit.num("GeneratingUnit.initialP") or 0.0) / 1000.0
        lines.append(f"new generator.{_safe(gen.name)} bus1={b[0]} phases=3 kv={kv:.6g} kw={p or 100:.6g} kva={s or 120:.6g} pf=1 model=1")

    # Coordinates
    coords: list[str] = []
    loc_points: dict[str, list[tuple[int, float, float]]] = {}
    for pp in _by_class(objs, "PositionPoint"):
        loc = pp.refs.get("PositionPoint.Location")
        x, y = pp.num("PositionPoint.xPosition"), pp.num("PositionPoint.yPosition")
        if loc and x is not None and y is not None:
            loc_points.setdefault(loc, []).append((int(pp.num("PositionPoint.sequenceNumber", 1) or 1), x, y))
    bus_xy: dict[str, tuple[float, float]] = {}
    for o in objs.values():
        loc = o.refs.get("PowerSystemResource.Location")
        if not loc or loc not in loc_points:
            continue
        pts = sorted(loc_points[loc])
        b = buses(o.id)
        if len(b) == 1 or len(pts) == 1:
            for bus in b:
                bus_xy.setdefault(bus, (pts[0][1], pts[0][2]))
        elif len(b) >= 2:
            bus_xy.setdefault(b[0], (pts[0][1], pts[0][2]))
            bus_xy.setdefault(b[1], (pts[-1][1], pts[-1][2]))
    for bus, (x, y) in bus_xy.items():
        coords.append(f"{bus} {x:.8g} {y:.8g}")
    crs_note = None
    cs = _by_class(objs, "CoordinateSystem")
    if cs:
        crs_note = cs[0].props.get("CoordinateSystem.crsUrn")

    lines.append(f"set voltagebases=[{', '.join(f'{v:.6g}' for v in sorted(kv_bases))}]")
    lines.append("calcvoltagebases")
    text_out = "! Converted from CIM RDF/XML by OpenDSS Designer\n" + "\n".join(lines) + "\n"
    if coords:
        text_out += "! BusCoords follow\n"
    notes.append(f"{len(objs)} CIM objects read: {sum(1 for o in objs.values() if o.cls == 'ACLineSegment')} line segments, "
                 f"{len(_by_class(objs, 'PowerTransformer'))} transformers, {len(_by_class(objs, 'EnergyConsumer', 'ConformLoad', 'NonConformLoad'))} loads.")
    if crs_note:
        notes.append(f"Coordinate system from the file: {crs_note}")
    return text_out, notes, coords  # type: ignore[return-value]


def _triangle(seq: int, n: int) -> tuple[int, int]:
    k = 0
    for i in range(n):
        for j in range(i + 1):
            if k == seq:
                return i, j
            k += 1
    return 0, 0


def _current_limit(objs: dict[str, _Obj], eq_id: str) -> float | None:
    """The first CurrentLimit in an OperationalLimitSet on the equipment's terminals."""
    term_ids = {t.id for t in _by_class(objs, "Terminal") if t.refs.get("Terminal.ConductingEquipment") == eq_id}
    sets = [s.id for s in _by_class(objs, "OperationalLimitSet")
            if s.refs.get("OperationalLimitSet.Terminal") in term_ids or s.refs.get("OperationalLimitSet.Equipment") == eq_id]
    for lim in _by_class(objs, "CurrentLimit"):
        if lim.refs.get("OperationalLimit.OperationalLimitSet") in sets:
            v = lim.num("CurrentLimit.value") or lim.num("CurrentLimit.normalValue")
            if v:
                return v
    return None


def _end_info(objs: dict[str, _Obj], end: _Obj, prop: str) -> float | None:
    info = objs.get(end.refs.get("TransformerTankEnd.TransformerEndInfo", "") or end.refs.get("TransformerEnd.TransformerEndInfo", "") or "")
    return info.num(f"TransformerEndInfo.{prop}") if info else None


def _end_info_str(objs: dict[str, _Obj], end: _Obj, prop: str) -> str | None:
    info = objs.get(end.refs.get("TransformerTankEnd.TransformerEndInfo", "") or end.refs.get("TransformerEnd.TransformerEndInfo", "") or "")
    return info.props.get(f"TransformerEndInfo.{prop}") if info else None


def _end_info_x(objs: dict[str, _Obj], end: _Obj) -> float | None:
    for sc in _by_class(objs, "ShortCircuitTest"):
        if sc.refs.get("ShortCircuitTest.EnergisedEnd") == (end.refs.get("TransformerTankEnd.TransformerEndInfo") or end.refs.get("TransformerEnd.TransformerEndInfo")):
            return sc.num("ShortCircuitTest.leakageImpedance")
    return None


# --- export ---------------------------------------------------------------------------

def circuit_to_cim(circuit: Circuit) -> str:
    """A CIM100 RDF/XML document for the circuit's power system model."""
    conn = synthesize(circuit)
    cim = CIM_NS_CANDIDATES[0]
    out: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<rdf:RDF xmlns:rdf="{RDF}" xmlns:cim="{cim}">',
    ]
    bases: dict[float, str] = {}

    def base_id(kv: float) -> str:
        key = round(kv, 4)
        if key not in bases:
            bases[key] = f"BV_{str(key).replace('.', '_')}"
            out.append(f'  <cim:BaseVoltage rdf:ID="{bases[key]}">\n    <cim:IdentifiedObject.name>{key} kV</cim:IdentifiedObject.name>\n'
                       f'    <cim:BaseVoltage.nominalVoltage>{key * 1000:.6g}</cim:BaseVoltage.nominalVoltage>\n  </cim:BaseVoltage>')
        return bases[key]

    nodes_done: set[str] = set()

    def node(bus: str) -> str:
        nid = f"CN_{_safe(bus)}"
        if bus not in nodes_done:
            nodes_done.add(bus)
            out.append(f'  <cim:ConnectivityNode rdf:ID="{nid}">\n    <cim:IdentifiedObject.name>{escape(bus)}</cim:IdentifiedObject.name>\n  </cim:ConnectivityNode>')
        return nid

    def terminal(eq: str, bus: str, seq: int) -> None:
        out.append(f'  <cim:Terminal rdf:ID="T_{eq}_{seq}">\n    <cim:IdentifiedObject.name>{eq}_T{seq}</cim:IdentifiedObject.name>\n'
                   f'    <cim:ACDCTerminal.sequenceNumber>{seq}</cim:ACDCTerminal.sequenceNumber>\n'
                   f'    <cim:Terminal.ConductingEquipment rdf:resource="#{eq}"/>\n'
                   f'    <cim:Terminal.ConnectivityNode rdf:resource="#{node(bus)}"/>\n  </cim:Terminal>')

    def num(p: dict, k: str, d: float) -> float:
        try:
            return float(p.get(k, d))
        except (TypeError, ValueError):
            return d

    for n in circuit.nodes:
        p = n.params
        eq = _safe(f"{n.type}_{p.get('name') or n.id}")
        b = conn.node_buses.get(n.id, [])
        if n.type == "vsource" and b:
            kv = num(p, "basekv", 12.47)
            out.append(f'  <cim:EnergySource rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n'
                       f'    <cim:EnergySource.nominalVoltage>{kv * 1000:.6g}</cim:EnergySource.nominalVoltage>\n'
                       f'    <cim:EnergySource.voltageMagnitude>{kv * 1000 * num(p, "pu", 1.0):.6g}</cim:EnergySource.voltageMagnitude>\n'
                       f'    <cim:ConductingEquipment.BaseVoltage rdf:resource="#{base_id(kv)}"/>\n  </cim:EnergySource>')
            terminal(eq, b[0], 1)
        elif n.type == "load" and b:
            kv = num(p, "kv", 12.47)
            kw = num(p, "kw", 100.0)
            pf = num(p, "pf", 0.95)
            kvar = kw * math.tan(math.acos(min(abs(pf), 1.0))) if pf else 0.0
            out.append(f'  <cim:EnergyConsumer rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n'
                       f'    <cim:EnergyConsumer.p>{kw * 1000:.6g}</cim:EnergyConsumer.p>\n    <cim:EnergyConsumer.q>{kvar * 1000:.6g}</cim:EnergyConsumer.q>\n'
                       + (f'    <cim:EnergyConsumer.customerCount>{int(num(p, "numcust", 1))}</cim:EnergyConsumer.customerCount>\n' if p.get("numcust") is not None else "")
                       + f'    <cim:ConductingEquipment.BaseVoltage rdf:resource="#{base_id(kv if int(num(p, "phases", 3)) == 3 else kv * math.sqrt(3))}"/>\n  </cim:EnergyConsumer>')
            terminal(eq, b[0], 1)
        elif n.type in ("breaker", "fuse", "recloser", "relay") and len(b) >= 2:
            cls = {"breaker": "Breaker", "fuse": "Fuse", "recloser": "Recloser", "relay": "Breaker"}[n.type]
            if p.get("sectionalizer") is True:
                cls = "Sectionaliser"
            is_open = not p.get("closed", True)
            out.append(f'  <cim:{cls} rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n'
                       f'    <cim:Switch.normalOpen>{"true" if is_open else "false"}</cim:Switch.normalOpen>\n    <cim:Switch.open>{"true" if is_open else "false"}</cim:Switch.open>\n'
                       f'    <cim:Switch.ratedCurrent>{num(p, "normamps", 600):.6g}</cim:Switch.ratedCurrent>\n  </cim:{cls}>')
            terminal(eq, b[0], 1)
            terminal(eq, b[1], 2)
        elif n.type in ("transformer", "regulator") and len(b) >= 2:
            windings = p.get("windings") if n.type == "transformer" and isinstance(p.get("windings"), list) else [
                {"kv": num(p, "kv", 12.47), "kva": num(p, "kva", 5000), "conn": p.get("conn", "wye")},
                {"kv": num(p, "kv", 12.47), "kva": num(p, "kva", 5000), "conn": p.get("conn", "wye")}]
            out.append(f'  <cim:PowerTransformer rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n  </cim:PowerTransformer>')
            xhl = num(p, "xhl", 8.0)
            for i, (w, bus) in enumerate(zip(windings[:3], b[:3]), start=1):
                kv, kva = float(w.get("kv", 12.47)), float(w.get("kva", 1000))
                x_ohm = xhl / 100 * (kv * 1000) ** 2 / (kva * 1000) if i == 1 else 0.0
                terminal(eq, bus, i)
                out.append(f'  <cim:PowerTransformerEnd rdf:ID="{eq}_E{i}">\n    <cim:IdentifiedObject.name>{eq} end {i}</cim:IdentifiedObject.name>\n'
                           f'    <cim:TransformerEnd.endNumber>{i}</cim:TransformerEnd.endNumber>\n'
                           f'    <cim:PowerTransformerEnd.ratedU>{kv * 1000:.6g}</cim:PowerTransformerEnd.ratedU>\n'
                           f'    <cim:PowerTransformerEnd.ratedS>{kva * 1000:.6g}</cim:PowerTransformerEnd.ratedS>\n'
                           f'    <cim:PowerTransformerEnd.x>{x_ohm:.6g}</cim:PowerTransformerEnd.x>\n'
                           f'    <cim:PowerTransformerEnd.connectionKind rdf:resource="{cim}WindingConnection.{"D" if str(w.get("conn", "wye")).startswith("d") else "Y"}"/>\n'
                           f'    <cim:PowerTransformerEnd.PowerTransformer rdf:resource="#{eq}"/>\n'
                           f'    <cim:TransformerEnd.Terminal rdf:resource="#T_{eq}_{i}"/>\n'
                           f'    <cim:TransformerEnd.BaseVoltage rdf:resource="#{base_id(kv)}"/>\n  </cim:PowerTransformerEnd>')
            if n.type == "regulator":
                out.append(f'  <cim:RatioTapChanger rdf:ID="{eq}_TC">\n    <cim:IdentifiedObject.name>{eq} tap changer</cim:IdentifiedObject.name>\n'
                           f'    <cim:RatioTapChanger.TransformerEnd rdf:resource="#{eq}_E2"/>\n'
                           f'    <cim:TapChanger.TapChangerControl rdf:resource="#{eq}_TCC"/>\n  </cim:RatioTapChanger>')
                out.append(f'  <cim:TapChangerControl rdf:ID="{eq}_TCC">\n    <cim:RegulatingControl.targetValue>{num(p, "vreg", 122.0):.6g}</cim:RegulatingControl.targetValue>\n'
                           f'    <cim:RegulatingControl.targetDeadband>{num(p, "band", 2.0):.6g}</cim:RegulatingControl.targetDeadband>\n  </cim:TapChangerControl>')
        elif n.type == "capacitor" and b:
            kv = num(p, "kv", 12.47)
            kvar = num(p, "kvar", 600)
            steps = max(1, int(num(p, "numsteps", 1)))
            bps = kvar * 1000 / steps / (kv * 1000) ** 2
            out.append(f'  <cim:LinearShuntCompensator rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n'
                       f'    <cim:ShuntCompensator.nomU>{kv * 1000:.6g}</cim:ShuntCompensator.nomU>\n    <cim:ShuntCompensator.normalSections>{steps}</cim:ShuntCompensator.normalSections>\n'
                       f'    <cim:LinearShuntCompensator.bPerSection>{bps:.8g}</cim:LinearShuntCompensator.bPerSection>\n'
                       f'    <cim:ConductingEquipment.BaseVoltage rdf:resource="#{base_id(kv)}"/>\n  </cim:LinearShuntCompensator>')
            terminal(eq, b[0], 1)
        elif n.type in ("pvsystem", "storage") and b:
            kv = num(p, "kv", 12.47)
            kva = num(p, "kva", num(p, "kwrated", 100))
            out.append(f'  <cim:PowerElectronicsConnection rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n'
                       f'    <cim:PowerElectronicsConnection.ratedS>{kva * 1000:.6g}</cim:PowerElectronicsConnection.ratedS>\n'
                       f'    <cim:ConductingEquipment.BaseVoltage rdf:resource="#{base_id(kv)}"/>\n  </cim:PowerElectronicsConnection>')
            unit_cls = "PhotoVoltaicUnit" if n.type == "pvsystem" else "BatteryUnit"
            maxp = num(p, "pmpp", kva) if n.type == "pvsystem" else num(p, "kwrated", kva)
            extra = f'    <cim:BatteryUnit.ratedE>{num(p, "kwhrated", maxp * 2) * 1000:.6g}</cim:BatteryUnit.ratedE>\n' if n.type == "storage" else ""
            out.append(f'  <cim:{unit_cls} rdf:ID="{eq}_U">\n    <cim:IdentifiedObject.name>{eq} unit</cim:IdentifiedObject.name>\n'
                       f'    <cim:PowerElectronicsUnit.maxP>{maxp * 1000:.6g}</cim:PowerElectronicsUnit.maxP>\n{extra}'
                       f'    <cim:PowerElectronicsUnit.PowerElectronicsConnection rdf:resource="#{eq}"/>\n  </cim:{unit_cls}>')
            terminal(eq, b[0], 1)
        elif n.type == "generator" and b:
            kv = num(p, "kv", 12.47)
            out.append(f'  <cim:SynchronousMachine rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or n.id))}</cim:IdentifiedObject.name>\n'
                       f'    <cim:RotatingMachine.ratedS>{num(p, "kva", num(p, "kw", 1000) * 1.2) * 1000:.6g}</cim:RotatingMachine.ratedS>\n'
                       f'    <cim:RotatingMachine.p>{-num(p, "kw", 1000) * 1000:.6g}</cim:RotatingMachine.p>\n'
                       f'    <cim:ConductingEquipment.BaseVoltage rdf:resource="#{base_id(kv)}"/>\n  </cim:SynchronousMachine>')
            terminal(eq, b[0], 1)
    for e in circuit.edges:
        if e.type != "line" or e.id not in conn.line_buses:
            continue
        p = e.params
        eq = _safe(f"line_{p.get('name') or e.id}")
        b1, b2 = conn.line_buses[e.id]
        length = num(p, "length", 1.0) * {"km": 1000, "m": 1, "mi": 1609.344, "kft": 304.8, "ft": 0.3048}.get(str(p.get("units", "km")), 1000)
        per_m = {"km": 1000, "m": 1, "mi": 1609.344, "kft": 304.8, "ft": 0.3048}.get(str(p.get("units", "km")), 1000)
        code = circuit.lineCodes.get(str(p.get("linecode") or ""))
        r1 = (code.r1 if code and code.r1 is not None else num(p, "r1", 0.12)) / (1000 if code and code.units == "km" else per_m) * length
        x1 = (code.x1 if code and code.x1 is not None else num(p, "x1", 0.38)) / (1000 if code and code.units == "km" else per_m) * length
        r0 = (code.r0 if code and code.r0 is not None else num(p, "r0", 0.4)) / (1000 if code and code.units == "km" else per_m) * length
        x0 = (code.x0 if code and code.x0 is not None else num(p, "x0", 1.2)) / (1000 if code and code.units == "km" else per_m) * length
        out.append(f'  <cim:ACLineSegment rdf:ID="{eq}">\n    <cim:IdentifiedObject.name>{escape(str(p.get("name") or e.id))}</cim:IdentifiedObject.name>\n'
                   f'    <cim:Conductor.length>{length:.6g}</cim:Conductor.length>\n'
                   f'    <cim:ACLineSegment.r>{r1:.6g}</cim:ACLineSegment.r>\n    <cim:ACLineSegment.x>{x1:.6g}</cim:ACLineSegment.x>\n'
                   f'    <cim:ACLineSegment.r0>{r0:.6g}</cim:ACLineSegment.r0>\n    <cim:ACLineSegment.x0>{x0:.6g}</cim:ACLineSegment.x0>\n  </cim:ACLineSegment>')
        terminal(eq, b1, 1)
        terminal(eq, b2, 2)
    # Coordinates
    if circuit.crs or any(n.geo for n in circuit.nodes):
        out.append(f'  <cim:CoordinateSystem rdf:ID="CS">\n    <cim:CoordinateSystem.crsUrn>{escape(circuit.crs or "")}</cim:CoordinateSystem.crsUrn>\n  </cim:CoordinateSystem>')
        for n in circuit.nodes:
            if n.geo is None or n.type in ("note", "zone"):
                continue
            eq = _safe(f"{n.type}_{n.params.get('name') or n.id}")
            out.append(f'  <cim:Location rdf:ID="L_{eq}">\n    <cim:Location.CoordinateSystem rdf:resource="#CS"/>\n  </cim:Location>')
            out.append(f'  <cim:PositionPoint rdf:ID="PP_{eq}">\n    <cim:PositionPoint.Location rdf:resource="#L_{eq}"/>\n'
                       f'    <cim:PositionPoint.sequenceNumber>1</cim:PositionPoint.sequenceNumber>\n'
                       f'    <cim:PositionPoint.xPosition>{n.geo.x:.8g}</cim:PositionPoint.xPosition>\n    <cim:PositionPoint.yPosition>{n.geo.y:.8g}</cim:PositionPoint.yPosition>\n  </cim:PositionPoint>')
    out.append("</rdf:RDF>")
    return "\n".join(out) + "\n"


def import_cim_text(text: str) -> dict[str, Any]:
    """A CIM document as the importer's result dict (circuit, warnings...)."""
    from .importer import import_dss_files
    dss_text, notes, coords = cim_to_dss(text)  # type: ignore[misc]
    files = [{"name": "cim.dss", "text": dss_text}]
    if coords:
        files[0]["text"] += "buscoords cim_buscoords.csv\n"
        files.append({"name": "cim_buscoords.csv", "text": "\n".join(coords) + "\n"})
    result = import_dss_files(files)
    result["warnings"] = [*notes, *result.get("warnings", [])]
    return result
