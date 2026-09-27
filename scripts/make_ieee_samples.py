"""Turn the IEEE test feeders in tests/fixtures/ieee into shipped samples.

    PYTHONPATH=src python scripts/make_ieee_samples.py

Runs each feeder through the importer (the same path the Import button
takes), lays it out with the frontend's own layout (frontend/scripts/
layout-circuit.ts, bundled with the frontend's esbuild and run under Node)
and writes src/opendss_designer/samples/ieee-<n>-bus.oneline.json. Re-run after an
importer change so the samples say what a fresh import would.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import ieee_feeders as bench  # noqa: E402

from opendss_designer.core import importer  # noqa: E402

SAMPLES = ROOT / "src" / "opendss_designer" / "samples"
FRONTEND = ROOT / "frontend"


def main() -> None:
    node = shutil.which("node")
    if not node:
        sys.exit("node not found; the layout step runs the frontend's layout.ts")
    binary = "esbuild.cmd" if sys.platform == "win32" else "esbuild"
    esbuild = FRONTEND / "node_modules" / ".bin" / binary
    if not esbuild.exists():
        sys.exit("frontend/node_modules missing; run `npm ci` in frontend/ first")
    bundle = Path(tempfile.mkdtemp(prefix="layout_")) / "layout.mjs"
    subprocess.run([str(esbuild), "scripts/layout-circuit.ts", "--bundle", "--platform=node",
                    "--format=esm", "--log-level=warning", f"--outfile={bundle}"],
                   cwd=FRONTEND, check=True)
    for feeder in bench.FEEDERS:
        result = importer.import_dss_files(bench.fixture_files(feeder))
        circuit = result["circuit"]
        circuit["name"] = feeder.title
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw.json"
            laid = Path(tmp) / "laid.json"
            raw.write_text(json.dumps(circuit), encoding="utf-8")
            subprocess.run([node, str(bundle), str(raw), str(laid)], cwd=FRONTEND, check=True)
            out = SAMPLES / f"ieee-{feeder.key}-bus.oneline.json"
            out.write_text(laid.read_text(encoding="utf-8"), encoding="utf-8")
        notes = [w for w in result["warnings"] if "Ignored" not in w]
        print(f"wrote {out.relative_to(ROOT)}: {len(circuit['nodes'])} nodes, "
              f"{len(circuit['edges'])} edges, {len(circuit['lineCodes'])} line codes"
              + (f"; {notes}" if notes else ""))


if __name__ == "__main__":
    main()
