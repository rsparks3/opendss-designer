# OpenDSS Designer

A free, open-source **graphical user interface (GUI) for
[OpenDSS](https://www.epri.com/pages/sa/opendss)**, EPRI's distribution system
simulator — built on [OpenDSSDirect.py](https://github.com/dss-extensions/OpenDSSDirect.py).
Draw a substation-style one-line (single-line) diagram in your browser — the
drawing **is** the circuit model — then run a power flow and see voltages,
loading, and violations right on the diagram. Import existing `.dss` files,
edit visually or in a spreadsheet view, and export runnable OpenDSS scripts.

🚀 **Try it: [opendssdesigner.ryanmsparks.com](https://opendssdesigner.ryanmsparks.com)** — no sign-up, runs in your browser

📖 **Documentation: [opendssdesigner-docs.ryanmsparks.com](https://opendssdesigner-docs.ryanmsparks.com)**

![screenshot](docs/screenshot.png)

## Features (v1)

- **Click-and-place palette**: Source (Vsource), Busbar, 2-winding Transformer, Breaker/Switch, Load —
  placement is sticky, so keep clicking to drop several; Esc to stop
- **Drag-to-wire**: drag between terminals; choose **Wire** (ideal connection, merges buses) or
  **Line** (a real OpenDSS Line with impedance and length). Illegal connections (busbar-to-busbar
  wires, self-connections, duplicates) are refused with an explanation
- **Stretchable busbars** with connection points along both edges (top and bottom rows), plus
  implicit junction buses when you wire elements directly together
- **Double-click a breaker** to open/close it; **double-click a wire or line** to add a draggable
  routing point and shape the run yourself (double-click a point to remove it)
- **Properties panel** with the OpenDSS parameters for each element (kV, kVA, impedances,
  phases 1/2/3, wye/delta, load model…)
- **Solve** button → snapshot power flow → overlays on the diagram:
  bus voltages (pu), element loading as pie charts + %, power flows, with color-coded
  violations (undervoltage blue, overvoltage/overload red) and total losses in the
  status bar — or toggle **Auto** to re-solve automatically on every circuit change
- **Live validation**: unconnected terminals, missing source, islands, duplicate names,
  kV mismatches — errors disable Solve and halo the offending element
- **Spreadsheet view**: an Elements tab in the bottom panel lists every source, busbar,
  transformer, line, breaker, and load in an editable table (plus a read-only bus-results
  table after a solve) — edit values in bulk with an Excel-style fill-down handle,
  click ⌖ to locate an element on the diagram
- **Undo/redo** (Ctrl+Z / Ctrl+Y), delete key, grid snapping, pan/zoom, minimap
- **Save/Open** projects in the browser, **Export/Import** them as JSON;
  **Export** a runnable `.dss` file;
  **Import** existing `.dss` files (select the main file plus anything it redirects to)
  with a hierarchical auto-layout — source at top, loads beneath their buses

## Install & run

Requires Python 3.10+.

```bash
pip install opendss-designer
opendss-designer            # starts a local server and opens your browser
```

(Or from a clone of this repo: `pip install -e .` — see Development below for
building the frontend.)

Options: `--port 8721`, `--no-browser`.

Try it: pick a circuit from the **Samples** dropdown, press **Solve**.

## Development

Backend (FastAPI + OpenDSSDirect.py):

```bash
pip install -e .[dev]
pytest                      # backend test suite
PYTHONPATH=src python -m opendss_designer.cli --no-browser   # serve API + built frontend
```

Frontend (React + Vite + React Flow), in a second terminal:

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173, proxies /api to :8721
```

To bundle the frontend into the Python package (before building a wheel):

```bash
python scripts/build_frontend.py
```

### Architecture

- `frontend/` — React + Vite app. React Flow canvas with custom ANSI-symbol nodes;
  zustand store is the canonical circuit model (zundo for undo history).
  `window.opendssDesigner` exposes the stores for console scripting.
- `src/opendss_designer/core/connectivity.py` — union-find translation of the drawn graph
  into OpenDSS bus names (wires merge terminals; Line edges are series elements).
- `src/opendss_designer/core/compiler.py` — circuit JSON → ordered OpenDSS Text commands;
  the same commands back both `/api/solve` and `.dss` export.
- `src/opendss_designer/core/engine.py` — solves and extracts per-bus voltages and
  per-element loading through the OpenDSSDirect API. Full rebuild per solve; no engine
  state persists between requests.
- `src/opendss_designer/core/importer.py` — imports `.dss` by compiling it with OpenDSS's
  own parser and reading the model back out.

See `FUTURE_IMPROVEMENTS.md` for the roadmap.
