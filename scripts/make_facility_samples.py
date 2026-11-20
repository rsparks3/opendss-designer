"""Write the two hand-laid facility-planning samples.

    python scripts/make_facility_samples.py

- ``installation-campus``: a fictional installation-scale system — a 69 kV
  utility service, a main substation with a split 13.2 kV bus, three
  feeders, a normally-open tie, two standby generators, and building loads at
  every priority. It is the Milestone A demonstration circuit (trace,
  priority, loss of utility, allocation by zone).
- ``looped-two-source``: a small 12.47 kV loop fed from both ends, plus a
  fused spur, for the trace tests on a meshed circuit.

Positions are chosen so that every connection lands on a real busbar handle:
a busbar's handles sit 10, 30, 50, ... px from its left edge (b<i> on top,
c<i> beneath), and a symbol's terminal is at its horizontal centre. Every
element below is placed by its centre for that reason.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "src" / "opendss_designer" / "samples"

PITCH = 20
SIZE = {"vsource": (40, 60), "transformer": (40, 80), "breaker": (40, 60), "fuse": (40, 60),
        "load": (40, 60), "generator": (40, 60)}


class Builder:
    def __init__(self, name: str) -> None:
        self.name = name
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, Any]] = []
        self.busbars: dict[str, tuple[int, int]] = {}  # id -> (left x, width)
        self.centre: dict[str, int] = {}

    def sym(self, nid: str, ntype: str, cx: int, y: int, **params: Any) -> str:
        w, _ = SIZE[ntype]
        self.nodes.append({"id": nid, "type": ntype, "position": {"x": cx - w // 2, "y": y},
                           "params": params})
        self.centre[nid] = cx
        return nid

    def bus(self, nid: str, name: str, kv: float, x: int, y: int, width: int) -> str:
        assert x % PITCH == 0 and width % PITCH == 0, nid
        self.nodes.append({"id": nid, "type": "busbar", "position": {"x": x, "y": y},
                           "width": width, "params": {"name": name, "basekv": kv}})
        self.busbars[nid] = (x, width)
        return nid

    def _end(self, nid: str, handle: str, at: int | None) -> str:
        """A busbar end takes the handle under `at` (default: the other end's
        centre); a symbol end is the handle given."""
        if nid not in self.busbars or handle[1:].isdigit():
            return handle
        x, width = self.busbars[nid]
        offset = at - x - PITCH // 2
        assert offset % PITCH == 0 and 0 <= offset < width, (nid, at)
        return f"{handle}{offset // PITCH}"

    def _edge(self, kind: str, eid: str, a: str, ah: str, b: str, bh: str,
              at: int | None, params: dict[str, Any]) -> None:
        at_a = at if at is not None else self.centre.get(b)
        at_b = at if at is not None else self.centre.get(a)
        self.edges.append({"id": eid, "type": kind, "source": a,
                           "sourceHandle": self._end(a, ah, at_a), "target": b,
                           "targetHandle": self._end(b, bh, at_b), "params": params})

    def wire(self, eid: str, a: str, ah: str, b: str, bh: str, at: int | None = None) -> None:
        self._edge("wire", eid, a, ah, b, bh, at, {})

    def line(self, eid: str, a: str, ah: str, b: str, bh: str, at: int | None = None,
             **params: Any) -> None:
        self._edge("line", eid, a, ah, b, bh, at, params)

    def write(self, extra: dict[str, Any] | None = None) -> None:
        doc = {"version": 2, "name": self.name, "busNames": {}, "nodes": self.nodes,
               "edges": self.edges, "loadShapes": {}, **(extra or {})}
        path = SAMPLES / f"{self.name}.oneline.json"
        path.write_text(json.dumps(doc, indent=1) + "\n")
        print("wrote", path.relative_to(ROOT))


MV = 13.2
LV = 0.48
CABLE = {"units": "km", "r1": 0.10, "x1": 0.12, "r0": 0.30, "x0": 0.36,
         "normamps": 400, "phases": 3}


def building(b: Builder, key: str, bus: str, cx: int, y: int, kva: float, load: dict[str, Any],
             fuse: bool = False) -> None:
    """A building service off an MV bus: (fuse →) transformer → 480 V load."""
    top = bus
    if fuse:
        top = b.sym(f"fu_{key}", "fuse", cx, y, name=f"F-{key.upper()}", closed=True,
                    ratedcurrent=65, phases=3)
        b.wire(f"w_{key}_f", bus, "c", top, "t1")
        y += 110
    xf = b.sym(f"xf_{key}", "transformer", cx, y, name=f"T-{key.upper()}", phases=3, xhl=5.75,
               pctloadloss=1.0, windings=[{"kv": MV, "kva": kva, "conn": "delta"},
                                          {"kv": LV, "kva": kva, "conn": "wye"}])
    if fuse:
        b.wire(f"w_{key}_x", top, "t2", xf, "t1")
    else:
        b.wire(f"w_{key}_x", bus, "c", xf, "t1")
    ld = b.sym(f"ld_{key}", "load", cx, y + 130, kv=LV, phases=3, conn="wye", model=1, **load)
    b.wire(f"w_{key}_l", xf, "t2", ld, "t1")


def installation() -> None:
    b = Builder("installation-campus")
    b.sym("util", "vsource", 330, 0, name="UTILITY", kind="utility", basekv=69, pu=1.03, angle=0,
          phases=3, mvasc3=500, mvasc1=450, x1r1=10, x0r0=8)
    b.sym("t1", "transformer", 330, 100, name="T1 MAIN", phases=3, xhl=8, pctloadloss=0.5,
          windings=[{"kv": 69, "kva": 10000, "conn": "delta"},
                    {"kv": MV, "kva": 10000, "conn": "wye"}])
    b.sym("brk_m", "breaker", 330, 220, name="52-M", closed=True, normamps=600, phases=3)
    b.wire("w_util", "util", "t1", "t1", "t1")
    b.wire("w_t1", "t1", "t2", "brk_m", "t1")
    b.bus("bus_a", "MAIN BUS A", MV, 100, 330, 480)
    b.bus("bus_b", "MAIN BUS B", MV, 720, 330, 900)
    b.wire("w_m", "brk_m", "t2", "bus_a", "b")
    b.sym("brk_t", "breaker", 650, 230, name="52-T BUS TIE", closed=True, normamps=1200, phases=3)
    b.wire("w_t_a", "bus_a", "b", "brk_t", "t1", at=570)
    b.wire("w_t_b", "brk_t", "t2", "bus_b", "b", at=730)

    # Feeder 1: the hospital, with G1 on its MV bus.
    b.sym("brk_f1", "breaker", 230, 430, name="52-F1", closed=True, normamps=400, phases=3)
    b.wire("w_f1", "bus_a", "c", "brk_f1", "t1")
    b.bus("bus_hosp", "HOSPITAL MV", MV, 120, 620, 300)
    b.line("ln_f1", "brk_f1", "t2", "bus_hosp", "b", length=1.2, name="F1-MAIN", **CABLE)
    building(b, "hosp", "bus_hosp", 170, 720, 1500,
             {"name": "HOSPITAL", "kw": 900, "pf": 0.92, "priority": "critical",
              "building": "Bldg 1200", "tags": ["medical"], "numcust": 1})
    building(b, "clinic", "bus_hosp", 290, 720, 500,
             {"name": "DENTAL CLINIC", "kw": 250, "pf": 0.9, "priority": "essential",
              "building": "Bldg 1210", "tags": ["medical"], "numcust": 1}, fuse=True)
    b.sym("gen1", "generator", 370, 720, name="G1", kv=MV, kw=1200, pf=0.9, kva=1500, phases=3,
          conn="wye", model=1, enabled=False, islandMode="grid", xdpp=0.15, fuelHours=72)
    b.wire("w_g1", "bus_hosp", "c", "gen1", "t1")

    # Feeder 2: operations and support, with G2 at the central plant and a
    # normally-open tie at its far end to feeder 3.
    b.sym("brk_f2", "breaker", 830, 430, name="52-F2", closed=True, normamps=400, phases=3)
    b.wire("w_f2", "bus_b", "c", "brk_f2", "t1")
    b.bus("bus_ops", "OPS MV", MV, 760, 620, 400)
    b.line("ln_f2", "brk_f2", "t2", "bus_ops", "b", length=0.9, name="F2-MAIN", **CABLE)
    building(b, "ops", "bus_ops", 790, 720, 1000,
             {"name": "OPS CENTER", "kw": 600, "pf": 0.9, "priority": "critical",
              "building": "Bldg 300", "tags": ["c2"], "numcust": 1})
    building(b, "comms", "bus_ops", 870, 720, 300,
             {"name": "COMMS NODE", "kw": 150, "pf": 0.95, "priority": "critical",
              "building": "Bldg 310", "tags": ["c2", "comms"], "numcust": 1}, fuse=True)
    b.sym("gen2", "generator", 950, 720, name="G2 CENTRAL PLANT", kv=MV, kw=1500, pf=0.9,
          kva=2000, phases=3, conn="wye", model=1, enabled=False, islandMode="grid", xdpp=0.15,
          fuelHours=48)
    b.wire("w_g2", "bus_ops", "c", "gen2", "t1")
    b.bus("bus_wh", "SUPPORT MV", MV, 1040, 1100, 200)
    b.line("ln_f2b", "bus_ops", "c", "bus_wh", "b", at=1110, length=0.7, name="F2-SUPPORT", **CABLE)
    building(b, "wh", "bus_wh", 1070, 1200, 750,
             {"name": "WAREHOUSE", "kw": 400, "pf": 0.85, "priority": "nonessential",
              "building": "Bldg 450", "tags": ["logistics"], "numcust": 1})
    building(b, "dining", "bus_wh", 1150, 1200, 500,
             {"name": "DINING FACILITY", "kw": 300, "pf": 0.9, "priority": "essential",
              "building": "Bldg 460", "tags": ["support"], "numcust": 1})
    b.sym("brk_tie", "breaker", 1210, 1200, name="52-TIE F2-F3", closed=False, tie=True,
          normamps=400, phases=3)
    b.wire("w_tie", "bus_wh", "c", "brk_tie", "t1")

    # Feeder 3: housing and the school, no generation.
    b.sym("brk_f3", "breaker", 1470, 430, name="52-F3", closed=True, normamps=400, phases=3)
    b.wire("w_f3", "bus_b", "c", "brk_f3", "t1")
    b.bus("bus_hous", "HOUSING MV", MV, 1360, 620, 300)
    b.line("ln_f3", "brk_f3", "t2", "bus_hous", "b", length=1.5, name="F3-MAIN", **CABLE)
    building(b, "hous", "bus_hous", 1410, 720, 2000,
             {"name": "FAMILY HOUSING", "kw": 1200, "pf": 0.95, "priority": "nonessential",
              "building": "Housing area", "tags": ["residential"], "numcust": 300})
    building(b, "school", "bus_hous", 1530, 720, 500,
             {"name": "SCHOOL", "kw": 300, "pf": 0.92, "priority": "essential",
              "building": "Bldg 900", "tags": ["shelter"], "numcust": 1})
    b.line("ln_tie", "brk_tie", "t2", "bus_hous", "c", at=1630, length=0.6, name="TIE-F2-F3",
           **CABLE)

    b.write({"tagVocabulary": ["medical", "c2", "comms", "logistics", "support", "residential",
                               "shelter"]})


def looped() -> None:
    b = Builder("looped-two-source")
    kv = 12.47
    for nid, name, cx in (("sa", "SOURCE A", 110), ("sb", "SOURCE B", 710)):
        b.sym(nid, "vsource", cx, 0, name=name, kind="utility", basekv=kv, pu=1.0, angle=0,
              phases=3, mvasc3=200, mvasc1=180)
    b.bus("bus_a", "BUS A", kv, 40, 100, 160)
    b.bus("bus_b", "BUS B", kv, 640, 100, 160)
    b.wire("w_sa", "sa", "t1", "bus_a", "b")
    b.wire("w_sb", "sb", "t1", "bus_b", "b")
    b.bus("bus_c", "BUS C", kv, 100, 300, 200)
    b.bus("bus_d", "BUS D", kv, 500, 300, 200)
    oh = {"units": "km", "r1": 0.3, "x1": 0.4, "r0": 0.6, "x0": 1.2, "normamps": 300, "phases": 3}
    b.line("l1", "bus_a", "c", "bus_c", "b", at=170, length=1.0, name="L1", **oh)
    # L2 joins handles at different x, so each end names its handle.
    b.line("l2", "bus_c", "c8", "bus_d", "b1", length=1.5, name="L2", **oh)
    b.line("l3", "bus_d", "b", "bus_b", "c", at=670, length=1.0, name="L3", **oh)
    b.sym("ld_c", "load", 130, 420, name="LOAD C", kv=kv, kw=800, pf=0.95, phases=3, conn="wye",
          model=1, priority="critical", building="Bldg C")
    b.wire("w_lc", "bus_c", "c", "ld_c", "t1")
    b.sym("ld_d", "load", 570, 420, name="LOAD D", kv=kv, kw=600, pf=0.95, phases=3, conn="wye",
          model=1, priority="essential", building="Bldg D")
    b.wire("w_ld", "bus_d", "c", "ld_d", "t1")
    b.sym("fu_e", "fuse", 650, 420, name="FUSE E", closed=True, ratedcurrent=65, phases=3)
    b.wire("w_fe", "bus_d", "c", "fu_e", "t1")
    b.bus("bus_e", "BUS E", kv, 580, 600, 160)
    b.line("l4", "fu_e", "t2", "bus_e", "b", length=0.5, name="L4", **oh)
    b.sym("ld_e", "load", 630, 700, name="LOAD E", kv=kv, kw=200, pf=0.95, phases=3, conn="wye",
          model=1, priority="nonessential")
    b.wire("w_le", "bus_e", "c", "ld_e", "t1")
    b.write()


if __name__ == "__main__":
    installation()
    looped()
