"""Write docs/validation.md from the IEEE test feeder benchmark.

    PYTHONPATH=src python scripts/ieee_validation.py

Runs the same comparisons tests/test_ieee_feeders.py asserts on and lays the
numbers out as the docs page. Re-run it after anything that changes a
solution: an engine upgrade, or an importer change that closes part of the
round-trip gap. The page is committed, so a diff of it is the review.
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import ieee_feeders as bench  # noqa: E402

from opendss_designer import __version__  # noqa: E402
from opendss_designer.core import engine  # noqa: E402

OUT = ROOT / "docs" / "validation.md"

PUBLISHED_URL = "https://cmte.ieee.org/pes-testfeeders/resources/"
EPRI_URL = ("https://github.com/dss-extensions/electricdss-tst/tree/master/"
            "Version8/Distrib/IEEETestCases")


def pu(v: float) -> str:
    return f"{v:.4f}"


def engine_version() -> str:
    """'DSS C-API 0.14.5 (OpenDSS SVN 3723), OpenDSSDirect.py 0.9.4' out of
    the engine's multi-line version banner."""
    import re

    banner = engine.opendss_version()
    capi = re.search(r"DSS C-API Library version (\S+)", banner)
    svn = re.search(r"OpenDSS SVN (\d+)", banner)
    odd = re.search(r"OpenDSSDirect.py version: (\S+)", banner)
    parts = []
    if capi:
        parts.append(f"DSS C-API {capi.group(1)}"
                     + (f" (OpenDSS SVN {svn.group(1)})" if svn else ""))
    if odd:
        parts.append(f"OpenDSSDirect.py {odd.group(1)}")
    return ", ".join(parts) or banner.splitlines()[0]


def taps_cell(taps: dict[str, int]) -> str:
    return ", ".join(f"{k} {v:+d}" for k, v in sorted(taps.items()))


def main() -> None:
    lines: list[str] = []
    w = lines.append

    w("---")
    w("description: How OpenDSS Designer's results compare with the published IEEE "
      "PES distribution test feeder solutions, and how much of a model survives import.")
    w("---")
    w("")
    w("# Validation against the IEEE test feeders")
    w("")
    w(f"*Generated {date.today().isoformat()} by `scripts/ieee_validation.py` with "
      f"OpenDSS Designer {__version__} on {engine_version()}. The same "
      "comparison runs in CI (`tests/test_ieee_feeders.py`).*")
    w("")
    w("The [IEEE PES Distribution Test Feeders](" + PUBLISHED_URL + ") are the "
      "benchmark every distribution planning tool is measured against: small radial "
      "feeders with unbalanced loads, single-phase laterals, regulators and "
      "capacitors, each with a published power-flow solution by W. H. Kersting. "
      "This page answers two separate questions about them.")
    w("")
    w("1. **Does the engine reproduce the published solution?** OpenDSS Designer "
      "solves with OpenDSS itself (via OpenDSSDirect.py), so this is EPRI's own "
      "`.dss` file for each feeder, compiled and solved exactly as the app's "
      "Solve button would, with the regulator taps set to the values Kersting "
      "reports so that the comparison is of the power flow and not of two "
      "regulator control models.")
    w("2. **Does the model survive the Import button?** The same files are pushed "
      "through the importer, the resulting one-line is solved, and the answer is "
      "compared with the engine's own solution of the original file. Any gap here "
      "is the importer's, and it is what the *real models in* milestone (M11) is "
      "measured by.")
    w("")
    w("Inputs: the `.dss` files are EPRI's, from the "
      "[OpenDSS test-case collection](" + EPRI_URL + ") (BSD licence); the "
      "published voltage profiles were transcribed from the radial power-flow "
      "reports in each feeder's package on the IEEE site. Both live under "
      "`tests/fixtures/ieee/` with a README on provenance.")
    w("")

    # ---- 1. Engine vs published, taps locked --------------------------------
    w("## 1. Engine against the published solutions")
    w("")
    w("Regulator taps locked to the published values. Deviation is the absolute "
      "difference in per-unit voltage magnitude at every node (bus and phase) in "
      "the published profile.")
    w("")
    w("| Feeder | Node-phases | Max deviation (pu) | Mean deviation (pu) "
      "| Beyond tolerance | Tolerance |")
    w("|---|---:|---:|---:|---:|---:|")
    details: list[str] = []
    for f in bench.FEEDERS:
        voltages, taps, _losses = bench.solve_original(f, lock_taps=True)
        cmp = bench.compare(f, voltages)
        over = cmp.over(f.tolerance)
        w(f"| {f.title} | {len(cmp.rows)} | {pu(cmp.max_deviation)} | "
          f"{cmp.mean_deviation:.5f} | {len(over)} | {f.tolerance} |")

        d: list[str] = []
        d.append(f"### {f.title}")
        d.append("")
        d.append(f"File: `{f.folder}/{f.main}`. Published profile is "
                 + ("line-to-line, as Kersting reports this three-wire delta feeder."
                    if f.voltage == "ll" else "line-to-neutral."))
        d.append("")
        if f.adjustments:
            d.append("Changes applied to EPRI's file before solving, each for the reason given:")
            d.append("")
            for cmds, why in f.adjustments:
                d.append("- " + ", ".join(f"`{c}`" for c in cmds) + f" - {why}")
            d.append("")
        d.append("Taps used: " + taps_cell(taps) + ".")
        d.append("")
        worst = sorted(cmp.rows, key=lambda r: -r.deviation)[:3]
        d.append("Largest deviations:")
        d.append("")
        d.append("| Bus | Phase | Published | Solved | Deviation |")
        d.append("|---|---|---:|---:|---:|")
        for r in worst:
            d.append(f"| {r.bus} | {r.phase} | {pu(r.published)} | {pu(r.solved)} "
                     f"| {pu(r.deviation)} |")
        if cmp.excluded:
            d.append("")
            d.append("Reported but not held to the tolerance:")
            d.append("")
            for bus, why in f.known.items():
                rows = [r for r in cmp.excluded if r.bus == bus]
                cells = ", ".join(f"{r.phase} {pu(r.published)} vs {pu(r.solved)}" for r in rows)
                d.append(f"- **Bus {bus}** ({cells}): {why}")
        if cmp.missing:
            d.append("")
            d.append("Published nodes with no bus in EPRI's file (regulator and transformer "
                     "output pseudo-nodes): "
                     + ", ".join(m.upper() for m in sorted(cmp.missing)) + ".")
        d.append("")
        details.extend(d)
    w("")
    w("Tolerance is 0.002 pu, which is the resolution of the published tables "
      "(four decimals) plus one rounding step. The 37-bus is held to 0.001 pu "
      "because, with the modelling assumptions listed under it, it matches to the "
      "last published digit.")
    w("")
    lines.extend(details)

    # ---- 2. Regulators free ---------------------------------------------------
    w("## 2. With the regulators left to the engine")
    w("")
    w("The same files with `RegControl` active, which is how a user would run "
      "them. Kersting's tap positions come from a different control model, so the "
      "engine settles one or more steps away on some regulators and the voltages "
      "move by a step's worth (0.00625 pu each). EPRI's own run files note the "
      "same thing.")
    w("")
    w("| Feeder | Max deviation (pu) | Mean deviation (pu) | Engine taps | Published taps |")
    w("|---|---:|---:|---|---|")
    for f in bench.FEEDERS:
        v_free, taps_free, _ = bench.solve_original(f, lock_taps=False)
        _v, taps_pub, _ = bench.solve_original(f, lock_taps=True)
        cmp = bench.compare(f, v_free)
        w(f"| {f.title} | {pu(cmp.max_deviation)} | {cmp.mean_deviation:.5f} | "
          f"{taps_cell(taps_free)} | {taps_cell(taps_pub)} |")
    w("")

    # ---- 3. Import round trip -------------------------------------------------
    w("## 3. What survives the Import button")
    w("")
    w("Each feeder imported as a one-line and solved by the app, against the "
      "engine's solution of the original file (regulators free in both, "
      "line-to-neutral, the file exactly as shipped). This is the importer's "
      "scorecard: what the Import button keeps of a model.")
    w("")
    w("| Feeder | Elements imported | Solves | Max deviation (pu) | Mean deviation (pu) "
      "| Losses, app / engine (kW) |")
    w("|---|---:|:---:|---:|---:|---:|")
    for f in bench.FEEDERS:
        rt = bench.round_trip(f)
        n = len([x for x in rt.circuit.nodes if x.type != "busbar"]) + \
            len([e for e in rt.circuit.edges if e.type == "line"])
        losses = rt.solve.get("losses") or {}
        w(f"| {f.title} | {n} | {'yes' if rt.converged else 'no'} | "
          f"{pu(rt.max_deviation)} | {rt.mean_deviation:.5f} | "
          f"{losses.get('kw', float('nan')):.1f} / {rt.reference_losses_kw:.1f} |")
    w("")
    w("Every element in all four feeders is read (nothing is reported as "
      "unsupported), every imported circuit solves and exports again, and the "
      "solution agrees with the original to the rounding of matrix entries on "
      "export (six significant figures). Losses agree to the same precision.")
    w("")
    w("It did not start that way. Measured on 2026-09-18 the same table read "
      "0.07 pu on the 13-bus with a third of its losses, because a `LineCode` "
      "defined by phase impedance matrices came back as the engine's default "
      "`r1 x1 r0 x0`, and three smaller properties were dropped: transformer "
      "`%loadloss`, the source's `MVAsc3`/`MVAsc1` and load `vminpu`. Line "
      "codes now travel with the circuit (see the Line codes tab), and the "
      "last 0.0015 pu on the 37-bus turned out to be a switch's `c1=0 c0=0`, "
      "which the engine's default capacitance is not. Switches now keep their "
      "own impedance and capacitance, regulators their winding connection.")
    w("")
    w("## Reproducing this page")
    w("")
    w("```")
    w("PYTHONPATH=src python scripts/ieee_validation.py")
    w("PYTHONPATH=src python -m pytest tests/test_ieee_feeders.py")
    w("```")
    w("")
    w("The test holds section 1 to each feeder's tolerance and section 3 to "
      "0.0005 pu and 0.2 % of losses, so an engine upgrade or an importer "
      "change that moves either shows up in CI before it shows up here.")
    w("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
