# Roadmap

Features deferred from v1, organized into milestones. Each milestone leaves the app
in a coherent, working state. Ordering rationale: foundation first (tests/CI protect
everything after), then balanced passes across editor UX, new components, analysis,
and platform. Sizing is rough (working sessions).

## M1 — Foundation & hardening — ✅ DONE (2026-08-30)

No visible features; protects everything after.

- **Frontend test harness** (vitest) for the pure logic: `circuitStore.ts`
  (`validateConnection`, `toCircuitJSON`/`fromCircuitJSON`, busbar handle remapping),
  `lib/layout.ts` geometry, `lib/fields.tsx` winding get/patch
- **Playwright smoke e2e**: place source → line → load, solve, assert voltage overlay;
  export/import round-trip
- **CI** (GitHub Actions): pytest + `tsc -b` + vitest + Playwright on push
- **Schema-drift guard**: round-trip test with every node/edge type, catching
  `types/circuit.ts` ↔ `core/model.py` divergence (revisit codegen if it keeps biting)
- **Error UX cleanup**: replace `alert()` call sites with the existing `flash` toast;
  surface errors from `lib/solve.ts`; narrow the bare `except Exception` in `routes.py`
  so server bugs return 500, not 400
- Housekeeping: remove stray root screenshot, drop unused `react-hook-form`

## M2 — Editor UX quick wins (~1–2 sessions)

All frontend-only; the M1 vitest harness covers the store changes.

- **Copy/paste** and duplicate (Ctrl+C/V/D), multi-select property editing
- **Keyboard palette shortcuts** (S=source, B=busbar, T=transformer…)
- **Rotate symbols** (R key) for horizontal feeder layouts
- **Right-click context menus** (open/close breaker without the properties panel)
- **Result tooltips** on hover with full detail (per-phase V, angles, currents, powers —
  the backend already returns per-node arrays)
- **Finer undo granularity**: replace the 300 ms history throttle with per-gesture
  grouping (`temporal.pause()/resume()` around drags)

## M3 — Component pack 1: real-feeder essentials (~2 sessions)

Static power-flow elements — no time-series infrastructure needed. The first component
should produce a written `docs/adding-an-element.md` checklist (adding one type touches
~8 files today) so the remaining component types become mechanical.

- **Capacitor banks** (`Capacitor`) — shunt kvar, delta/wye, switched steps
- **Generators** (`Generator`) — kW/kvar or PV-mode, classic circle-G symbol
- **Line codes** (`LineCode`) — impedance libraries instead of per-line R/X entry, with a
  built-in library of common conductors
- Importer support for all three

## M4 — Analysis pack 1 (~2 sessions)

Self-contained analysis wins; no LoadShape/streaming infrastructure needed.

- **Fault study** (`solve mode=faultstudy`) — short-circuit MVA / fault currents at each
  bus (bus overlay mode + bottom-panel table); single-phase and three-phase
- **Losses breakdown** panel per element
- **Voltage profile plot** — distance-vs-voltage chart along a feeder path

## M5 — DER pack + time series (~3–4 sessions)

The biggest single milestone; the M3 checklist makes the components mechanical.

- **PV systems** (`PVSystem`) — irradiance/temperature curves, inverter kVA
- **Storage** (`Storage`) — kWh rating, charge/discharge dispatch
- **LoadShape editor** (CSV paste + curve editor), assignable to loads/PV/storage
- **Daily/yearly time series** — energy meters and monitors, progress streaming
  (websocket/SSE), result plots over time (add a charting dependency here)

## M6 — Regulation, protection & phases (~2–3 sessions)

- **Voltage regulators** (`RegControl` on an autotransformer) — band, PT ratio, LDC
- **3-winding transformers** — third handle; the per-winding editor already generalizes
- **Fuses, reclosers, relays** (`Fuse`, `Recloser`, `Relay`) — pairs with M4's fault study
- **Phase pinning** — connect 1-phase elements to a chosen phase (`.2`, `.3` suffixes;
  `compiler.py` already accepts explicit suffixes, so this is mostly UI)
- **Per-phase display** — phase labels on wires, per-phase voltage readouts

## M7 — Platform & polish (~2–3 sessions, pick-and-choose)

- **Smarter .dss import layout**: elkjs layered layout; keep 2-terminal pass-through
  buses as plain wires instead of busbars
- **Automatic wire routing** (elkjs edge routing — shares the elkjs dependency)
- **File System Access API** in-place saves (localStorage autosave already shipped)
- **Dark mode**, printable/exportable diagram (SVG/PNG export)
- **Round-trip preservation** of comments and unsupported elements on export
- **Split line**: drop a bus in the middle of an existing Line edge

## Parking lot (deferred until actually needed)

- **Incremental solve** — reuse the compiled circuit when only parameter values changed;
  matters once circuits reach thousands of elements (v1 rebuilds every solve)
- **Multi-circuit tabs** / compare two scenarios side by side — big architectural change;
  wait until the single-circuit workflow is mature
- **Explicit grounding elements** (`Reactor` to ground, grounding transformer symbols)

## Done since v1

- Project autosave to browser storage (debounced localStorage save + restore in `App.tsx`)
- M1 (2026-08-30): vitest unit tests (`frontend/src/**/*.test.ts`), Playwright e2e
  (`frontend/e2e/`), GitHub Actions CI, schema-drift guard
  (`tests/fixtures/full-circuit.oneline.json` round-tripped by both pytest and vitest),
  flash-toast error surfacing (no more `alert()`), import bugs now 500 not 400
