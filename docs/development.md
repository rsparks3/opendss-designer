# Development

Contributions are welcome — the project is AGPL-3.0-licensed and developed on
[GitHub](https://github.com/rsparks3/opendss-designer).

## Setup

Backend (FastAPI + OpenDSSDirect.py), from the repo root:

```bash
pip install -e .[dev]
pytest                      # backend test suite
```

Frontend (React + Vite + React Flow), in a second terminal:

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173, proxies /api to :8721
```

Run the API for the dev frontend with:

```bash
python -m opendss_designer.cli --no-browser
```

To bundle the built frontend into the Python package (done automatically by
the release workflow):

```bash
python scripts/build_frontend.py
```

## Architecture

- `frontend/` — React + Vite app. React Flow canvas with custom ANSI-symbol
  nodes; a zustand store is the canonical circuit model (zundo for undo
  history). `window.opendssDesigner` exposes the stores for console scripting.
- `src/opendss_designer/core/connectivity.py` — union-find translation of the
  drawn graph into OpenDSS bus names (wires merge terminals; Line edges are
  series elements).
- `src/opendss_designer/core/compiler.py` — circuit JSON → ordered OpenDSS
  Text commands; the same commands back both `/api/solve` and `.dss` export.
- `src/opendss_designer/core/engine.py` — solves and extracts per-bus voltages
  and per-element loading through the OpenDSSDirect API. Full rebuild per
  solve; no engine state persists between requests.
- `src/opendss_designer/core/importer.py` — imports `.dss` by compiling it
  with OpenDSS's own parser and reading the model back out.

## Tests

- `pytest` — backend suite, including a schema-drift guard: a shared fixture
  is round-tripped by both the Python (Pydantic) and TypeScript schemas so the
  hand-mirrored models break loudly if they diverge.
- `cd frontend && npm test` — vitest unit tests.
- `cd frontend && npm run e2e` — Playwright end-to-end smoke suite
  (place/solve/export/import) booting the real server.

All three run in CI on every push and pull request.

## Adding a new element type

There's a dedicated checklist: [Adding an element type](adding-an-element.md).

The roadmap lives in
[`FUTURE_IMPROVEMENTS.md`](https://github.com/rsparks3/opendss-designer/blob/main/FUTURE_IMPROVEMENTS.md).
