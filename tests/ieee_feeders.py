"""The IEEE PES distribution test feeders as a benchmark.

Two questions, asked of the four radial feeders (13, 34, 37 and 123 bus)
that every commercial planning tool advertises against:

1. **Does the engine reproduce the published solution?** Compile EPRI's own
   .dss file for the feeder, lock the regulator taps to the values Kersting
   reports, solve, and compare every bus voltage with the published profile.
   This pins the numerical claim the whole product rests on.

2. **Does the app's import keep the model?** Push the same files through
   `importer.import_dss_files`, solve the resulting circuit with
   `engine.solve` (the path the Solve button takes) and compare with the
   engine's own solution of the original file, regulators free in both. Any
   gap here is the importer's, not the engine's - it is M11's yardstick.

Shared by `tests/test_ieee_feeders.py` (CI) and `scripts/ieee_validation.py`
(which writes docs/validation.md). Fixture provenance is in
tests/fixtures/ieee/README.md.
"""
from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from pathlib import Path

import opendssdirect as dss

from opendss_designer.core import engine, importer
from opendss_designer.core.model import Circuit

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ieee"


@dataclass(frozen=True)
class Feeder:
    key: str
    folder: str
    main: str
    title: str
    # "ln": the published profile is line-to-neutral (wye feeders);
    # "ll": line-to-line, as Kersting reports the three-wire delta 37-bus.
    voltage: str
    # Commands that put the regulators on the taps the published solution
    # used, copied from EPRI's Run_*.dss "2nd script" for each feeder.
    published_taps: tuple[str, ...]
    # Modelling changes applied before *every* run of this feeder, as
    # (commands, reason) groups. Only the 37-bus needs any.
    adjustments: tuple[tuple[tuple[str, ...], str], ...] = ()
    # Buses whose deviation is reported but not asserted against, with why.
    known: dict[str, str] = field(default_factory=dict)
    # Companion files an import needs beyond the main file.
    companions: tuple[str, ...] = ()
    # Voltage tolerance (pu) for the locked-tap comparison.
    tolerance: float = 0.002


FEEDERS: tuple[Feeder, ...] = (
    Feeder(
        key="13", folder="13Bus", main="IEEE13Nodeckt.dss",
        title="IEEE 13-bus", voltage="ln",
        companions=("IEEELineCodes.DSS", "IEEE13Node_BusXY.csv"),
        published_taps=(
            "Transformer.Reg1.Taps=[1.0 1.0625]",
            "Transformer.Reg2.Taps=[1.0 1.0500]",
            "Transformer.Reg3.Taps=[1.0 1.06875]",
            "Set Controlmode=OFF",
        ),
    ),
    Feeder(
        key="34", folder="34Bus", main="ieee34Mod1.dss",
        title="IEEE 34-bus", voltage="ln",
        companions=("IEEELineCodes.DSS", "IEEE34_BusXY.csv"),
        published_taps=(
            "Transformer.reg1a.wdg=2 Tap=(0.00625 12 * 1 +)",
            "Transformer.reg1b.wdg=2 Tap=(0.00625 5 * 1 +)",
            "Transformer.reg1c.wdg=2 Tap=(0.00625 5 * 1 +)",
            "Transformer.reg2a.wdg=2 Tap=(0.00625 13 * 1 +)",
            "Transformer.reg2b.wdg=2 Tap=(0.00625 11 * 1 +)",
            "Transformer.reg2c.wdg=2 Tap=(0.00625 12 * 1 +)",
            "Set Controlmode=OFF",
        ),
    ),
    Feeder(
        key="37", folder="37Bus", main="ieee37.dss",
        title="IEEE 37-bus", voltage="ll",
        companions=("IEEELineCodes.DSS", "IEEE37_BusXY.csv"),
        adjustments=(
            (("Transformer.SubXF.Xhl=0.0001",
              "Transformer.SubXF.%rs=[0.00001 0.00001]"),
             "the published case starts at 1.0 pu at bus 799; EPRI's file "
             "keeps an 8 % substation transformer, which drops 799 to 0.92 pu "
             "at this load. EPRI's 13-bus file makes the same change itself."),
            (("Transformer.reg1a.XHL=0.001", "Transformer.reg1a.%loadloss=0.00001",
              "Transformer.reg1c.XHL=0.001", "Transformer.reg1c.%loadloss=0.00001"),
             "Kersting's regulators are ideal; EPRI's file gives the open-delta "
             "bank 1 % reactance, which costs 0.01 pu at the regulator output. "
             "EPRI's 123-bus file uses 0.001 % for the same reason."),
        ),
        published_taps=(
            "Transformer.reg1a.wdg=2 Tap=(0.00625 7 * 1 +)",
            "Transformer.reg1c.wdg=2 Tap=(0.00625 4 * 1 +)",
            "Set Controlmode=OFF",
        ),
        tolerance=0.001,
    ),
    Feeder(
        key="123", folder="123Bus", main="IEEE123Master.dss",
        title="IEEE 123-bus", voltage="ln",
        companions=("IEEELineCodes.DSS", "IEEE123Loads.DSS",
                    "IEEE123Regulators.DSS", "BusCoords.dat"),
        published_taps=(
            "Transformer.reg1a.wdg=2 Tap=(0.00625 7 * 1 +)",
            "Transformer.reg2a.wdg=2 Tap=(0.00625 -1 * 1 +)",
            "Transformer.reg3a.wdg=2 Tap=(0.00625 0 * 1 +)",
            "Transformer.reg3c.wdg=2 Tap=(0.00625 -1 * 1 +)",
            "Transformer.reg4a.wdg=2 Tap=(0.00625 8 * 1 +)",
            "Transformer.reg4b.wdg=2 Tap=(0.00625 1 * 1 +)",
            "Transformer.reg4c.wdg=2 Tap=(0.00625 5 * 1 +)",
            "Set Controlmode=OFF",
        ),
        known={
            "610": "the 480 V secondary of transformer XFM1. Kersting's "
                   "solution treats the 150 kVA delta-delta unit differently "
                   "from the engine (the three phases are off by -0.008, "
                   "+0.016 and -0.008 pu); every 4.16 kV bus agrees.",
        },
    ),
)

BY_KEY = {f.key: f for f in FEEDERS}

# Reported for the free-tap run of the 123-bus; EPRI's Run file sets it so
# seven regulators moving one tap per iteration can settle.
_FREE_TAP_SETUP = {"123": ("Set MaxControlIter=30",)}

Voltages = dict[str, dict[str, float]]  # bus -> phase letter -> pu magnitude


@dataclass
class Row:
    bus: str
    phase: str
    published: float
    solved: float

    @property
    def deviation(self) -> float:
        return abs(self.solved - self.published)


@dataclass
class Comparison:
    rows: list[Row]
    missing: list[str]  # published nodes with no bus in the solution
    excluded: list[Row]  # rows on `known` buses, reported but not asserted

    @property
    def max_deviation(self) -> float:
        return max((r.deviation for r in self.rows), default=0.0)

    @property
    def mean_deviation(self) -> float:
        return sum(r.deviation for r in self.rows) / len(self.rows) if self.rows else 0.0

    def over(self, tol: float) -> list[Row]:
        return sorted((r for r in self.rows if r.deviation > tol),
                      key=lambda r: -r.deviation)

    @property
    def worst(self) -> Row | None:
        return max(self.rows, key=lambda r: r.deviation, default=None)


def published_voltages(feeder: Feeder) -> list[tuple[str, str, float]]:
    """(bus, phase, pu) rows from the published profile, bus names lowered.

    Kersting's tables carry pseudo-nodes for regulator and transformer
    outputs (RG60, XFXFM1, RG1..RG4, XF1) that are not buses in the .dss
    file; they come through here and show up as `missing` in a comparison,
    which is expected.
    """
    path = FIXTURES / feeder.folder / "published-voltages.csv"
    with path.open(encoding="utf-8") as fh:
        return [(r["node"].lower(), r["phase"], float(r["vmag_pu"]))
                for r in csv.DictReader(fh)]


def fixture_files(feeder: Feeder) -> list[dict[str, str]]:
    """The feeder's files in the shape the import API takes."""
    out = []
    for name in (feeder.main, *feeder.companions):
        text = (FIXTURES / feeder.folder / name).read_text(encoding="utf-8",
                                                           errors="replace")
        out.append({"name": name, "text": text})
    return out


def _bus_voltages(voltage: str) -> Voltages:
    out: Voltages = {}
    for bus in dss.Circuit.AllBusNames():
        dss.Circuit.SetActiveBus(bus)
        nodes = list(dss.Bus.Nodes())
        if voltage == "ll":
            # Kersting reports the delta feeder line-to-line, on the
            # line-to-line base; the API's puVLL is on a different footing,
            # so form the differences from the raw phasors.
            raw = dss.Bus.Voltages()
            phasor = {n: complex(raw[2 * i], raw[2 * i + 1]) for i, n in enumerate(nodes)}
            base = dss.Bus.kVBase() * 1000.0 * math.sqrt(3)
            pairs = {"A": (1, 2), "B": (2, 3), "C": (3, 1)}
            out[bus.lower()] = {
                ph: abs(phasor[a] - phasor[b]) / base
                for ph, (a, b) in pairs.items() if a in phasor and b in phasor}
        else:
            mags = dss.Bus.puVmagAngle()[0::2]
            out[bus.lower()] = {"ABC"[n - 1]: v for n, v in zip(nodes, mags, strict=False)
                                if 1 <= n <= 3}
    return out


def _taps() -> dict[str, int]:
    taps: dict[str, int] = {}
    i = dss.RegControls.First()
    while i:
        taps[dss.RegControls.Name().lower()] = int(dss.RegControls.TapNumber())
        i = dss.RegControls.Next()
    return taps


@engine.on_engine_thread
def solve_original(feeder: Feeder, lock_taps: bool, voltage: str | None = None,
                   adjust: bool = True) -> tuple[Voltages, dict[str, int], float]:
    """Compile EPRI's file as shipped (plus the feeder's documented
    adjustments, unless `adjust` is off), solve, and return bus voltages,
    regulator taps and total losses in kW. `voltage` defaults to the footing
    the published profile uses."""
    with engine.dss_guard():
        engine._ensure_init()
        dss.Text.Command("clear")
        dss.Text.Command(f'compile "{FIXTURES / feeder.folder / feeder.main}"')
        for cmds, _why in (feeder.adjustments if adjust else ()):
            for cmd in cmds:
                dss.Text.Command(cmd)
        extra = feeder.published_taps if lock_taps else _FREE_TAP_SETUP.get(feeder.key, ())
        for cmd in extra:
            dss.Text.Command(cmd)
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("solve")
        if not dss.Solution.Converged():
            raise RuntimeError(f"{feeder.title}: the original file did not converge")
        try:
            losses_kw = dss.Circuit.Losses()[0] / 1000.0
            return _bus_voltages(voltage or feeder.voltage), _taps(), losses_kw
        finally:
            # Compiling moved the engine's working directory into the
            # fixture folder; put it back so nothing lands beside the files.
            dss.Basic.DataPath(str(engine.WORKDIR))


def compare(feeder: Feeder, solved: Voltages) -> Comparison:
    rows: list[Row] = []
    excluded: list[Row] = []
    missing: list[str] = []
    for bus, phase, pu in published_voltages(feeder):
        got = solved.get(bus)
        if got is None or phase not in got:
            if bus not in missing:
                missing.append(bus)
            continue
        row = Row(bus, phase, pu, got[phase])
        (excluded if bus in feeder.known else rows).append(row)
    return Comparison(rows=rows, missing=missing, excluded=excluded)


@dataclass
class RoundTrip:
    circuit: Circuit
    unsupported: list[str]
    warnings: list[str]
    solve: dict
    reference_losses_kw: float
    # The app's solution against the engine's solution of the same file
    # (regulators free in both), keyed like `compare`'s rows.
    rows: list[Row]
    missing: list[str]

    @property
    def converged(self) -> bool:
        return bool(self.solve.get("converged"))

    @property
    def max_deviation(self) -> float:
        return max((r.deviation for r in self.rows), default=0.0)

    @property
    def mean_deviation(self) -> float:
        return sum(r.deviation for r in self.rows) / len(self.rows) if self.rows else 0.0


def round_trip(feeder: Feeder) -> RoundTrip:
    """Import the feeder the way the Import button does, solve the circuit
    the way the Solve button does, and measure against the engine's own
    solution of the original file."""
    # Line-to-neutral on both sides (the only footing the app reports), and
    # the file exactly as shipped: the import sees no adjustments either.
    reference, _, reference_losses_kw = solve_original(
        feeder, lock_taps=False, voltage="ln", adjust=False)
    imported = importer.import_dss_files(fixture_files(feeder))
    circuit = Circuit.model_validate(imported["circuit"])
    result = engine.solve(circuit)
    rows: list[Row] = []
    missing: list[str] = []
    solved = {name.lower(): v for name, v in result.get("buses", {}).items()}
    for bus, phases in reference.items():
        got = solved.get(bus)
        if got is None:
            missing.append(bus)
            continue
        by_phase = {"ABC"[n - 1]: v for n, v in zip(got["nodes"], got["vmagPu"], strict=False)
                    if 1 <= n <= 3}
        for phase, pu in phases.items():
            if phase in by_phase:
                rows.append(Row(bus, phase, pu, by_phase[phase]))
    return RoundTrip(circuit=circuit, unsupported=list(imported["unsupported"]),
                     warnings=list(imported["warnings"]), solve=result,
                     reference_losses_kw=reference_losses_kw,
                     rows=rows, missing=missing)
