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

## M4 — Analysis pack 1 — ✅ DONE (2026-08-30)

- ~~**Fault study**~~ — `/api/faultstudy` (mode=faultstudy → per-bus Zsc1/Zsc0);
  "Fault" overlay shows 3φ kA badges on busbars, tooltip adds 1φ/SC-MVA/Z1;
  runs lazily on overlay select, invalidated by any circuit edit
- ~~**Losses breakdown**~~ — per-series-element kW/kvar losses (shunt elements
  deliberately report none) in a sortable Losses tab with % of total
- ~~**Voltage profile plot**~~ — grew into a general **Graph tab**: pick Y
  (bus V min/max, or per-element P/Q flow, current, loading, losses) vs X
  (km from source via solver `busDistances`, or bus voltage); classic
  OpenDSS plot styling — per-phase traces (black/red/blue), bold red
  0.95/1.05 limit lines, framed white plot — with zoom buttons, drag-pan,
  Shift+drag zoom box, wheel zoom, and phase toggles. Bottom panel is
  drag-resizable (persisted height).

## M5 — DER pack + time series — ✅ DONE (2026-08-30)

- ~~**PV systems**~~ — inverter kVA/Pmpp/pf/irradiance with canned
  efficiency + P-T curves; `P` places, panel-in-circle symbol
- ~~**Storage**~~ — kW/kWh ratings, efficiency, reserve, initial SOC;
  dispatch = follow-shape (+/− mult) or OpenDSS default-mode triggers;
  `A` places, battery symbol. (Storage is auto-disabled during fault
  studies — DSS-Extensions 0.9.4 crashes faultstudy mode with them.)
- ~~**LoadShape editor**~~ — `Circuit.loadShapes` collection (first non-graph
  schema field), Shapes bottom-panel tab: CSV paste, draggable curve editor
  (≤96 pts), peak/avg normalize; `loadshape` field kind gives every
  load/PV/storage a shape dropdown in properties + spreadsheet
- **NREL EULP import** (added at Ryan's request) — backend proxy
  (`core/nrel.py`, disk-cached) for the public End-Use Load Profiles S3
  aggregates: climate zone × building type (5 residential + 14 commercial),
  hourly or native 15-min, peak/average normalization
- **Typed shapes + NSRDB irradiance** (follow-up) — `LoadShapeSpec.kind`
  ('load' | 'irradiance') splits the Shapes tab into two libraries; element
  dropdowns filter by kind (loads → load, PV → irradiance, storage → any;
  mismatches warn). `core/irradiance.py` fetches hourly 2018 GHI from the
  NLR NSRDB PSM4 API (per-user free API key, place-name geocoding via
  Open-Meteo, disk-cached, kW/m² or peak-normalized scaling) — 2018 matches
  the EULP weather year so PV stays correlated with building load
- ~~**Daily/yearly time series**~~ — step-driven engine loop
  (`solve_timeseries`) records every bus/element automatically (no
  monitor elements needed), integrates energy/losses/peaks; SSE progress
  streaming (`POST /api/timeseries`) with cancel; Graph tab grew a Time
  mode (polylines, entity picker, month axis, min/max envelope
  downsampling >2k steps, summary table) — still zero charting dependencies
- **Time-series analysis mode + scrubbing** (follow-up) — Snapshot/Time
  series toolbar toggle; TS mode grays out Solve/Auto and shows a transport
  bar (`TimeBar.tsx`): run controls, play/pause, and a scrubber that drives
  the canvas overlays (voltage/loading/power badges, line colors, tooltips)
  through the recorded run via `tsSlice` (recorded step reshaped as a
  SolveResult; scrubber parks at the peak hour). Downsampled yearly runs
  pop an envelope-explanation dialog and keep an "envelope ≈12 h" chip;
  the Time chart draws a synced cursor line

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
- **Parking a wire mid-air** (an end connected to nothing) — considered alongside
  drag-to-re-route and declined: ReactFlow has no dangling edge, so it would need a
  placeholder node standing in for "not connected", and grab-and-drop makes the
  two-step park-then-reconnect workflow unnecessary. If temporarily removing a
  branch is ever wanted, an edge-level "out of service" flag (still attached at
  both ends, omitted from the compile) is the cheaper answer.

## Done since v1

- Project autosave to browser storage (debounced localStorage save + restore in `App.tsx`)
- M1 (2026-08-30): vitest unit tests (`frontend/src/**/*.test.ts`), Playwright e2e
  (`frontend/e2e/`), GitHub Actions CI, schema-drift guard
  (`tests/fixtures/full-circuit.oneline.json` round-tripped by both pytest and vitest),
  flash-toast error surfacing (no more `alert()`), import bugs now 500 not 400
- Drag-to-re-route (2026-08-31): dragging from a terminal that holds exactly one wire
  moves that wire's end instead of drawing a second one — the edge itself is the drag
  preview (`useEdgePath`), the gesture is a DOM-free state machine (`store/grabStore.ts`)
  wired to a `Terminal` wrapper over ReactFlow's `<Handle>`, and drops reuse
  `validateConnection`. Frontend only; the wire format is unchanged.
