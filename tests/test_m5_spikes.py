"""M5 risk spikes, kept as regression tests.

These exercise the OpenDSSDirect surfaces the DER/time-series work depends on
before any app code relies on them: giant inline loadshape commands, PVSystem
and Storage snapshot behavior, step-driven daily mode, and the read-back APIs
the importer needs (some iterators lack getters; Properties.Value is the
fallback path).
"""
import math

import opendssdirect as dss
import pytest


def _cmd(c: str) -> None:
    dss.Text.Command(c)
    result = dss.Text.Result()
    assert not (result and "error" in result.lower()), f"{c[:80]!r} -> {result}"


def _fresh(name: str) -> None:
    dss.Basic.AllowForms(False)
    _cmd("clear")
    _cmd("set defaultbasefrequency=60")
    _cmd(f"new circuit.{name} basekv=12.47 pu=1.0 phases=3 mvasc3=500 mvasc1=525")
    _cmd("new line.ln1 bus1=sourcebus bus2=mid phases=3 "
         "r1=0.12 x1=0.38 r0=0.4 x0=1.2 length=1 units=km normamps=400")


def _element_kw(full_name: str) -> float:
    assert dss.Circuit.SetActiveElement(full_name) >= 0
    ncond = dss.CktElement.NumConductors()
    return sum(dss.CktElement.Powers()[0 : 2 * ncond : 2])


def test_inline_loadshape_at_supported_ceiling() -> None:
    """Inline mult=(...) is safe up to MAX_INLINE_SHAPE_PTS (288 = a 15-min
    daily shape). Anything larger goes through a CSV side file: very long
    inline commands parse "successfully" but corrupt the DSS Text parser's
    heap on Linux, segfaulting the process later (found via CI exit 139)."""
    from opendss_designer.core.compiler import MAX_INLINE_SHAPE_PTS

    _fresh("spike_ls_inline")
    npts = MAX_INLINE_SHAPE_PTS
    points = [round(0.5 + 0.5 * math.sin(2 * math.pi * i / 96), 5)
              for i in range(npts)]
    mult = " ".join(f"{v:g}" for v in points)
    _cmd(f"new loadshape.small npts={npts} minterval=15 mult=({mult})")
    dss.LoadShape.Name("small")
    assert dss.LoadShape.Npts() == npts


@pytest.mark.parametrize("npts,minterval", [(8760, 60.0), (35040, 15.0)])
def test_file_loadshape_mult_size(tmp_path, npts: int, minterval: float) -> None:
    """Yearly-scale shapes load via mult=(file=...) — the solve path's format."""
    _fresh("spike_ls_file")
    points = [round(0.5 + 0.5 * math.sin(2 * math.pi * i / 96), 5)
              for i in range(npts)]
    csv_path = tmp_path / "big.csv"
    csv_path.write_text("\n".join(f"{v:g}" for v in points) + "\n", encoding="utf-8")
    _cmd(f'new loadshape.big npts={npts} minterval={minterval:g} '
         f'mult=(file="{csv_path}")')
    dss.LoadShape.Name("big")
    assert dss.LoadShape.Npts() == npts
    pmult = list(dss.LoadShape.PMult())
    assert len(pmult) == npts
    assert pmult[0] == pytest.approx(points[0], abs=1e-4)
    assert pmult[-1] == pytest.approx(points[-1], abs=1e-4)


def test_pvsystem_storage_snapshot() -> None:
    """PVSystem and Storage solve in snapshot mode and inject/absorb power."""
    _fresh("spike_der")
    _cmd("new load.ld1 bus1=mid phases=3 conn=wye kv=12.47 kw=2000 pf=0.95 model=1")
    _cmd("new pvsystem.pv1 bus1=mid phases=3 conn=wye kv=12.47 kva=500 "
         "pmpp=500 pf=1.0 irradiance=1.0 temperature=25")
    _cmd("new loadshape.dispatch npts=24 interval=1 "
         "mult=(" + " ".join("1" if 18 <= h < 21 else "-0.5" if h < 6 else "0"
                             for h in range(24)) + ")")
    _cmd("new storage.bat1 bus1=mid phases=3 conn=wye kv=12.47 kwrated=250 "
         "kwhrated=1000 %stored=50 %reserve=20 dispmode=follow daily=dispatch")
    _cmd("set voltagebases=[12.47]")
    _cmd("calcvoltagebases")
    _cmd("set mode=snapshot")
    _cmd("solve")
    assert dss.Solution.Converged()
    # Load consumes (positive), PV injects (negative) in load convention.
    assert _element_kw("load.ld1") > 1900
    assert _element_kw("pvsystem.pv1") == pytest.approx(-500, rel=0.05)


def test_daily_step_loop() -> None:
    """Driving mode=daily one step at a time advances the clock and the load
    follows its daily shape — the core of solve_timeseries."""
    _fresh("spike_daily")
    shape = [0.4] * 8 + [1.0] * 10 + [0.4] * 6  # peak 08:00-18:00
    _cmd("new loadshape.day24 npts=24 interval=1 "
         "mult=(" + " ".join(f"{v:g}" for v in shape) + ")")
    _cmd("new load.ld1 bus1=mid phases=3 conn=wye kv=12.47 kw=1000 pf=0.95 "
         "model=1 daily=day24")
    _cmd("set voltagebases=[12.47]")
    _cmd("calcvoltagebases")
    _cmd("set mode=daily stepsize=1h number=1")
    _cmd("set hour=0 sec=0")
    hours = []
    load_kw = []
    for _ in range(24):
        dss.Solution.Solve()
        assert dss.Solution.Converged()
        hours.append(dss.Solution.DblHour())
        load_kw.append(_element_kw("load.ld1"))
    # Clock advances one hour per step, monotonically.
    steps = [round(b - a, 6) for a, b in zip(hours, hours[1:], strict=False)]
    assert steps == [1.0] * 23
    # The load tracked the shape: peak/off-peak ratio ~ 1.0/0.4.
    assert max(load_kw) / min(load_kw) == pytest.approx(2.5, rel=0.1)
    assert max(load_kw) == pytest.approx(1000, rel=0.05)


def test_readback_apis() -> None:
    """Importer read-back paths: PVsystems iterator getters exist; Storage has
    no rating getters so Properties.Value is the path; load daily assignment
    reads back via Properties.Value too."""
    _fresh("spike_readback")
    _cmd("new loadshape.day24 npts=24 interval=1 mult=("
         + " ".join("1" for _ in range(24)) + ")")
    _cmd("new load.ld1 bus1=mid phases=3 conn=wye kv=12.47 kw=500 pf=0.95 "
         "model=1 daily=day24")
    _cmd("new pvsystem.pv1 bus1=mid phases=3 conn=wye kv=12.47 kva=800 "
         "pmpp=750 pf=1.0 irradiance=0.9 daily=day24")
    _cmd("new storage.bat1 bus1=mid phases=3 conn=wye kv=12.47 kwrated=250 "
         "kwhrated=1000 %stored=45 %reserve=20 %effcharge=95 %effdischarge=94 "
         "dispmode=follow daily=day24")
    _cmd("set voltagebases=[12.47]")
    _cmd("calcvoltagebases")

    assert dss.PVsystems.First() == 1
    assert dss.PVsystems.Name().lower() == "pv1"
    assert dss.PVsystems.Pmpp() == pytest.approx(750)
    assert dss.PVsystems.kVARated() == pytest.approx(800)
    assert dss.PVsystems.Irradiance() == pytest.approx(0.9)
    assert dss.PVsystems.daily().lower() == "day24"

    assert dss.Circuit.SetActiveElement("storage.bat1") >= 0
    assert float(dss.Properties.Value("kwrated")) == pytest.approx(250)
    assert float(dss.Properties.Value("kwhrated")) == pytest.approx(1000)
    assert float(dss.Properties.Value("%stored")) == pytest.approx(45)
    assert float(dss.Properties.Value("%reserve")) == pytest.approx(20)
    assert float(dss.Properties.Value("%effcharge")) == pytest.approx(95)
    assert float(dss.Properties.Value("%effdischarge")) == pytest.approx(94)
    assert dss.Properties.Value("dispmode").lower() == "follow"
    assert dss.Properties.Value("daily").lower() == "day24"

    assert dss.Circuit.SetActiveElement("load.ld1") >= 0
    assert dss.Properties.Value("daily").lower() == "day24"

    dss.LoadShape.Name("day24")
    assert dss.LoadShape.Npts() == 24
