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

## M2 — Editor UX quick wins — ✅ DONE (2026-08-30)

All frontend-only; the M1 vitest harness covers the store changes.

- ~~**Copy/paste** and duplicate (Ctrl+C/V/D)~~ — collision-safe renaming, cascading offsets
- ~~**Keyboard palette shortcuts**~~ — S/B/T/K/L place, W/E switch wire/line mode
- ~~**Rotate symbols** (R key)~~ — params.rotation, handles follow; busbars excluded
- ~~**Right-click context menus**~~ — open/close breaker, rotate, duplicate, delete,
  straighten edge
- ~~**Result tooltips** on hover~~ — per-phase V/angle (backend now returns `vangDeg`),
  currents, power, loading
- ~~**Finer undo granularity**~~ — per-gesture grouping via begin/endGesture; selection
  changes excluded from history
- Still open from this bucket: **multi-select property editing** (deferred to a later
  milestone; single-element editing plus spreadsheet fill-down covers most of it)

## M3 — Component pack 1: real-feeder essentials — ✅ DONE (2026-08-30)

- ~~**Capacitor banks**~~ — shunt kvar, delta/wye, numsteps; imports/exports/solves
- ~~**Generators**~~ — kW/pf with model 1 (const PQ) or 3 (PV, holds vpu); circle-G symbol
- ~~**Line codes**~~ — built-in conductor preset library (`lib/lineCodes.ts`, 8 typical
  OH/UG constructions) that stamps editable Ω/km values; imported linecode names kept
  as reference tags. True LineCode entity round-trip stays in M7.
- ~~Importer support~~ — capacitors and generators read back; `docs/adding-an-element.md`
  checklist written so remaining component types are mechanical

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
