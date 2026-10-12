# Roadmap

Features deferred from v1, organized into milestones. Each milestone leaves the app
in a coherent, working state. Ordering rationale: foundation first (tests/CI protect
everything after), then balanced passes across editor UX, new components, analysis,
and platform. From M10 on the roadmap follows a stated target — competing with the
commercial distribution planning tools; see **Direction** below for what that rules
in and out.

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
- ~~**Multi-select property editing**~~ — landed 2026-09-19: a multi-selection turns
  the properties panel into *Edit N elements* (shared fields, relative number edits),
  with downstream / all-of-type / on-phase picks and an Elements-table filter

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
- **NREL EULP import** — backend proxy
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

## M6 — Regulation, protection & phases — ✅ DONE (2026-09-17)

- ~~**Voltage regulators**~~ — an equal-ratio transformer plus its `RegControl`,
  emitted under one name; setpoint/band/PT ratio/CT primary/LDC R and X in the
  properties panel, PT ratio derived from the rated kV when left blank, and a
  controlled transformer imports back as a regulator
- ~~**3-winding transformers**~~ — a third entry in `windings` grows terminal `t3`
  (leaving the symbol to the right, name moved to the left), X(H-T) and X(L-T)
  appear in the properties panel only for a three-winding unit, connectivity and
  validation take the terminal list from the winding count, and the importer reads
  three-winding units back instead of reporting them as unsupported
- ~~**Fuses, reclosers, relays**~~ — each is a switch plus its control, kept as one
  element in the editor; curve choices are limited to the ten the engine ships, since
  naming any other stops the solve; a relay with no ground curve gets no ground unit;
  open/close (blow/replace) like a breaker; imports back as the device, not as a switch
- ~~**TCC curves** (`TCC_Curve`)~~ — Graph tab → Protection plots every device on
  log-log paper from the engine's own curve objects scaled by each pickup, with the
  prospective 3φ fault current at each device's downstream bus as a dashed line, a
  dotted flat tail past the end of the curve data, hover readout and a legend that
  toggles devices. `core/protection.py` + `POST /api/tcc`
- ~~**Coordination checks**~~ — pickup above the available fault current, a series pair
  inside the 0.25 s margin, and interrupting duty against a new `interruptingka` rating;
  the upstream/downstream pairing comes from a walk outward from the source over the
  conducting elements (open switches cut the path). Breakers take part in the duty check
  and are listed under the plot, since they carry no curve. The 75% melt rule for fuse
  pairs and ground-fault coordination landed with them; grading stops where the curve
  data does, because past it every curve runs flat
- ~~**A user-editable curve library**~~ — the Curves tab: points typed or pasted as
  "multiple of pickup, seconds", previewed, saved with the circuit, emitted as
  `TCC_Curve` and read back on import; `GET /api/tcccurves` lists the engine's own.
  Still the editor and never a manufacturer device library — see Out of scope
- ~~**Phase pinning**~~ — a `phasing` param holding letters ("B", "A-C") that every
  element with a phase count can set; `core/phasing.py` is the only place letters and
  node suffixes meet. Left at "(default)" an element takes the first N phases, so
  every circuit drawn before this compiles unchanged. A pin carries through lines,
  switches and regulators but stops at a transformer, whose secondary starts at A
  again. The "mostly UI" estimate was wrong in one place: breakers and protective
  devices hard-coded `.1` on both terminals and the importer dropped their suffixes,
  so a fuse in a pinned lateral silently islanded everything past it. Validation walks
  the phases out from the source and flags an element asking for one its bus never
  receives; lines not carrying all three are labelled on the one-line
- ~~**Per-phase display**~~ — the tooltip names phases A/B/C rather than node
  positions, element currents are tagged with the phase they flow on (the engine
  now reports each conductor's node), and the voltage badge names the lowest
  phase on a lateral or on a three-phase bus whose phases disagree by more than
  0.002 pu; a balanced bus keeps its plain badge
- ~~**Phases overlay**~~ — colour-by-phase on the one-line, the everyday view in
  WindMil/CYME/Synergi: lines and symbols by the phases they are on (every symbol
  draws in `--ink`, so `usePhaseInk` overrides that one variable), wires and busbars by the
  phases that reach them (`/api/validate` now ships the validation walk's result
  as `phases`, so the view needs no solve), a bus nothing reaches reads *unfed*,
  and a legend on the canvas. The palette is one constant in `lib/phasing.ts`;
  making it a user preference waits for M7's theming rather than growing a
  settings panel for one value. A transformer is tinted whole by its primary
  pin, though its secondary starts again at A

## M7 — Platform & polish — ✅ DONE (2026-09-27, branch `m7`)

- ~~**Smarter .dss import layout**~~ — 2026-09-19, without elkjs: `lib/layout.ts`
  now ranks with dagre and does the rest itself (every shunt in one evenly
  spaced row under its bar, bars sized to their slots, parallel devices fanned
  out, lines bent below the load row on their own routing points, an overlap
  sweep), exposed as **✦ Clean up** and run on every import. Ryan chose a
  top-down tree, everything shunt under the bar, full re-layout with undo, and
  no elkjs. The two follow-ups landed 2026-09-27: pass-through buses become
  **compact** bars (60 px, no label; Ryan chose a tiny bar over a new junction
  node type), and **Layout direction → Left to right** (series devices turned
  270°) for either engine
- ~~**Automatic wire routing** (elkjs)~~ — 2026-09-27: Arrange → Layered layout
  with routed wires (`lib/elkLayout.ts`, dynamic import, its own 436 kB gz
  chunk). A bar and its hanging row are one ELK box, symbol terminals are
  FIXED_POS ports, and bend points become waypoints re-attached to the snapped
  handles. Left to right puts every bar port on top, since horizontal bars with
  bottom ports stair-step. Dagre Clean up stays the default and the import
  layout until ELK proves itself on real feeders
- ~~**File System Access API** in-place saves~~ — File → Save to file / Open file
  (2026-09-26). The browser library stays primary (Ryan's choice); a file opened
  or saved from disk stays linked and later saves write back over it in Chrome
  and Edge, while other browsers download. `lib/fileSystem.ts`
- ~~**Printable/exportable diagram (SVG/PNG export)**~~ — Image: SVG / PNG in the
  toolbar. `lib/exportDiagram.ts` reads the rendered canvas and writes it back as
  native SVG (edge paths with computed strokes, symbol SVGs with styles inlined
  relative to their parent, HTML text as `<text>`, coloured boxes as `<rect>`),
  so the file is editable in Inkscape/Visio/PowerPoint rather than a screenshot
  in a foreignObject. Carries the active overlay with a legend (`legendFor`) and
  a caption; PNG is the same SVG rasterised at 2× on a canvas. No dependency.
  This is the M10 study report's diagram source
- ~~**Dark mode**~~ — 2026-09-26. Every colour is a token in `index.css` with a
  `[data-theme='dark']` set; `lib/theme.ts` picks light, dark or the system's,
  React Flow gets `colorMode`, and exports switch to light for the capture
  (`inLightTheme`) so files stay on white. The phase palette is now CSS
  variables with a per-theme default and a Preferences override
- ~~**Menu bar**~~ — 2026-09-26, not on the original list: File / Edit / View /
  Arrange / Analysis / Help the way draw.io lays them out, over a slimmed
  toolbar. Menus are data (`lib/menus.ts`), shortcuts one table
  (`lib/shortcuts.ts`) that Help lists
- ~~**Round-trip preservation** of comments and unsupported elements~~ —
  2026-09-27. `core/passthrough.py` reads the sanitized upload in compile
  order and keeps every `New` of an unmodelled element (plus its `Edit`s) as
  `Circuit.passthrough`, and comments as `Circuit.comments` keyed by
  class.name. Ryan chose export *and* solve: `check()` admits only New/Edit
  lines of an allowlisted class that read no file and whose element/bus
  references exist; the engine treats a rejected one as a warning. A stale
  entry is exported commented out so the file still compiles (a judgement
  call: "still exported" was the decision, a file that no longer compiles
  was not). Renames rewrite references (`lib/passthroughRefs.ts`)
- ~~**Split line**~~ — 2026-09-27: right-click → *Split line here* (or Arrange →
  Split line for the midpoint) inserts a 60 px busbar named `<line>_MID`, keeps
  the original edge id on the upstream half, and divides `length` by the drawn
  arc length to the click (`lib/splitLine.ts`)

## M8 — Public deployment — ✅ DONE (2026-09-01)

Making the app safe to expose, without changing what a local install does.

- ~~**Security fixes** (0.1.3)~~ — static-file path containment, `Host`
  validation, `.dss` import treated as data rather than a program, unused
  OpenDSS capabilities disabled, property-value allowlists, no server detail in
  responses
- ~~**Demo mode** (0.2.0)~~ — opt-in size, cost and rate limits; bounded
  caches; security headers. Off by default, so the pip-install experience is
  unchanged
- ~~**Deployability**~~ — `--host`/`$PORT`, idle shutdown, per-process scratch
  directory, shared cache volume, `Dockerfile`, structured logging
- ~~**Sample circuits**~~ — served from the package and openable from the
  toolbar
- ~~**Docs**~~ — `docs/deployment.md`, `docs/security.md`, `SECURITY.md`

Still open: **authentication and hosting** live in a separate wrapper project —
this repo deliberately has no user concept. See `docs/deployment.md` for the
split.

## M9 — Hosted service (planned 2026-09-04)

A free-with-limits public instance at `opendssdesigner.ryanmsparks.com`, a free
account that raises the limits, and a paid plan ($20 a year) that sells
**compute** — bigger circuits, longer runs, priority, a monthly engine-time
budget — and never storage. Full design, plan table and stage-by-stage
roadmap in `docs/hosted-service.md`. Took priority over M6/M7 while it was
being built; with Stage 4 live (2026-09-06) the remaining stages are
operational work in the cloud and deploy repositories, so app-repo work
resumes at **M6**, which the M10–M13 direction depends on.

The only work that lands in *this* repository is **Stage 1, "worker
contract" (0.4.0) — ✅ DONE (2026-09-05)**, all opt-in and inert in local mode:

- ~~Per-request limit overrides from a trusted header~~
  (`OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER`): a `contextvars` overlay
  (`context.current_settings()`) that `on_engine_thread` and the time-series
  worker thread carry across their thread hops; `Settings.tightened()` can
  only lower a worker's own env limits, never raise them
- ~~Engine-time reporting~~: `X-Engine-Seconds` on engine-backed responses,
  `engineSeconds` in the final time-series SSE event, measured on the engine
  thread
- ~~A generic `plan` block~~ (`name`, `message`, `links`) echoed by
  `/api/health` and rendered by `DemoBanner` via `lib/plan.ts`
- ~~Limit messages name the plan~~ instead of "the public demo"
- ~~Request-id passthrough~~ echoed and attached to JSON logs
- Stage 0 (ship the demo, docs to `opendssdesigner-docs.ryanmsparks.com`)
  ✅ DONE (2026-09-05)
- Stage 2 (gateway v0.1, guests only: one slot per worker, priority queue,
  engine-second ledger, two workers behind it on the box) ✅ DONE
  (2026-09-05) — lives in `opendss-designer-cloud`; nothing in this repo
- Stage 3 (accounts: magic link, GitHub, Google; Free plan; account and
  legal pages) — code shipped and deployed 2026-09-05 (gateway 0.2.0);
  live since 2026-09-05 with all three sign-in methods. The only change
  here: the banner remembers a dismissal per plan title, and the toolbar
  gained a permanent plan corner
- Stage 4 (Pro via Stripe: Checkout, Customer Portal, webhooks) ✅ LIVE
  (2026-09-06, gateway 0.3.0, $20 a year). Nothing in this repo

Accounts, plans, the solver queue, metering and Stripe live in a new AGPL
repository, `opendss-designer-cloud`; deployment stays in
`opendss-designer-demo`. Stage 0 (ship the demo, move the docs site to
`opendssdesigner-docs.ryanmsparks.com`) precedes all of it.

## Direction — the distribution planning market (decided 2026-09-11)

M10–M13 are aimed at a specific goal: becoming an open-source alternative to the
commercial **distribution planning** tools — DNV Synergi Electric, Eaton CYME,
Milsoft WindMil — rather than to the facility/arc-flash tools (SKM PowerTools,
EasyPower, ETAP's core). The two markets look adjacent and are not. The arc-flash
business sells a PE-stamped IEEE 1584 / NFPA 70E deliverable backed by a
protective-device curve library nobody can reproduce (Eaton documents 15,000+
devices from 100+ manufacturers), so it is out of reach and out of scope. Utility
planning is what the OpenDSS engine is already for, which means most of the gap
to Synergi and CYME is **interface work, not numerical work** — the engine
already does unbalanced power flow, fault study, yearly time series, reliability
indices, and it is what EPRI's DRIVE hosting-capacity method runs on.

Ordering: **M6 came first** (done 2026-09-17) — regulators, fuses/reclosers/relays,
three-winding transformers and per-phase laterals are table stakes for anything
below, because a feeder without them is not a feeder. The two M7 items the rest
depended on followed — SVG/PNG export (the prerequisite for M10's study report) and
Clean up, the import layout for M11's real feeders — and the rest of M7 with
them (2026-09-27). M10 (study output) and M11 (real models in) are done;
**next: M12's planning studies**, starting with hosting capacity. Each
milestone below is chosen to be
useful to someone real on its own, not only at the end of the list.

## M10 — Study output & proof

The cheapest credibility available, and the first milestone that lets someone
hand a study to a colleague.

- ~~**IEEE PES test feeder validation**~~ — done 2026-09-18. EPRI's 13, 34,
  37 and 123-bus files and Kersting's published voltage profiles live in
  `tests/fixtures/ieee/`; `tests/test_ieee_feeders.py` holds the engine to the
  published solution in CI (within 0.002 pu at every node with the published
  taps, 0.0001 pu on the 37-bus once its regulators are made ideal the way
  EPRI's own 13-bus file does), and `scripts/ieee_validation.py` writes
  `docs/validation.md`. "The engine already passes it" was right; "reporting,
  not work" missed that the same page measures the *import* round trip, and
  that is where the work is — see M11's first bullet. The round-trip
  assertions started as strict `xfail`s and became ordinary tests once line
  codes closed the gap
- ~~**Study report export**~~ — done 2026-09-28 (branch `m10`). PDF and Excel,
  built in the browser: title block and criteria, load-flow summary, abnormal
  conditions, bus voltages with a profile, branch flows, loads and generation,
  losses, the one-line, and optionally short circuit, protection (settings,
  operating times, interrupting duty, TCC plot) and time series. It came with
  two things it needed: abnormal-condition limits as a project setting (they
  were hard-coded in six places) and notes on the drawing. `docs/report.md`
  describes it. The two loose ends closed 2026-10-11: a PDF whose text goes
  beyond Latin-1 is set in DejaVu Sans, fetched only when needed
  (`lib/report/fonts.ts`), and generators, PV, storage and capacitors are
  held to their ratings (kVA, or the engine's 135 % continuous current for a
  capacitor) in the overlay, the tooltip and the report
- ~~**Reliability indices**~~ — done 2026-10-11. SAIFI/SAIDI/CAIDI from
  OpenDSS's own `EnergyMeter` reliability calculation (`core/reliability.py`):
  meters go on every element leaving the source bus, or on elements flagged
  *Reliability meter here*; lines, transformers, regulators and switches
  carry `faultrate`/`pctperm`/`repair`, loads `numcust` (compiled, imported,
  exported); a *Reliability* overlay colours by protection section with a
  legend of the indices, a *Reliability* tab holds the sections table, and the
  study report has a *Reliability* section. The engine's convention that
  branches above the first fuse, recloser or relay count for nothing is
  surfaced as a warning rather than hidden. It was, as predicted, UI over an
  engine feature that already existed
- ~~**Drawing annotations**~~ — done 2026-10-11, decided the same day as a
  small follow-on to notes rather than a milestone: **zones** (a labelled,
  tinted rectangle behind a group of elements, drawn with Z, resizable,
  pointer-transparent inside, redrawn around what it held by Clean up,
  exported as a `! Zone:` comment) and a **sheet border and title block** on
  image exports, switched on in Project properties. Deliberately not done:
  arbitrary shapes, free lines, colour pickers, images — draw.io's job, not a
  planning tool's, and each one adds schema, export and dark-mode surface

## M11 — Real models in — ✅ DONE (2026-10-12, branch `m11`)

Nobody hand-draws a utility feeder. Until an engineer can open the model they
already own, the analysis features have no audience — this is the first real gate.

- ~~**Import fidelity**~~ — measured 2026-09-18 on the IEEE feeders and closed
  2026-09-19; `docs/validation.md` keeps the score. Every element of all four
  feeders imported and solved, but the answers were off by up to 0.07 pu and
  the 13-bus lost half its losses, because a `LineCode` with `rmatrix`/
  `xmatrix`/`cmatrix` was flattened to `r1 x1 r0 x0` — and for a matrix-defined
  line the engine reports its *defaults* for those (0.058 Ω per unit length),
  so every line of every real feeder was wrong. The fix is the circuit-level
  `lineCodes` collection, like `loadShapes` and `tccCurves`: lines reference a
  code by name, the compiler emits `LineCode` objects, the importer reads them
  back whole (a `LineGeometry` line gets a code named after the geometry, an
  inline matrix a code of its own name, and a shared code file's unused
  entries are left out with a note), and the Line codes tab edits them in
  OpenDSS's own matrix spelling. Along the way: transformer `%loadloss`,
  `Vsource` `MVAsc3`/`MVAsc1`, load `vminpu`, a switch's own impedance and
  capacitance and a regulator's winding connection now survive import; the
  last 0.0015 pu on the 37-bus was a jumper's `c1=0 c0=0` against the engine's
  default capacitance. All four feeders now round-trip within 2e-5 pu, and
  `tests/test_ieee_feeders.py` holds them there. Still engine-side only:
  `LineGeometry`/`WireData`/`CNData` themselves (their computed matrix comes
  through; the geometry does not), which can wait until someone needs to edit
  a pole configuration in the app
- ~~**Real feeders import faithfully**~~ — 2026-10-12, not on the original
  list but what the rest stood on. EPRI's ckt5, ckt7 and ckt24 and the IEEE
  8500-node feeder (2,000–10,000 elements, BSD-licensed, in
  `tests/fixtures/large/`) all broke the importer: ckt7 did not import (the
  master redirects to the file with `New Circuit`), ckt24 put a bus at 269 pu
  (two-phase lines on a one-phase code) and turned its 230/34.5 kV LTC into a
  230/230 kV regulator, ckt5 dropped its open ties (`enabled=no`) and read
  240 V services at 1.75 pu (the file's `voltagebases` were not kept), and the
  8500-node feeder did not converge. Now: the main file is the top of the
  redirect tree; disabled elements are drawn out of service (`enabled`
  param, "In service" in the panel); voltage bases, CVR/ZIP load exponents,
  a source's X/R, transformer taps, no-load loss, magnetising current and
  unequal winding resistances survive; series reactors are drawn as lines;
  an LTC keeps its control as a passthrough; names keep their dashes. All
  four round-trip within 1e-5 pu (ckt7 2e-4) and `tests/test_large_feeders.py`
  holds them there; `docs/validation.md` section 4 keeps the score
- ~~**Scale to thousands of elements**~~ — 2026-10-12. ckt24 (10,800 nodes)
  did not finish drawing in ten minutes; it now imports, lays out and draws in
  2.2 s, pans at 60 fps and solves in 1.2 s. The costs were all in the
  browser, found with Chrome traces: the undo history stringified the whole
  document twice per store change, every edge and badge found itself with
  `array.find` (O(n²) per render), validation re-posted the circuit on every
  click, busbars rendered twenty terminals each, and dagre took 7–12 s.
  Fixed with id indexes (`lib/indexes.ts`), reference-equality undo,
  validation on electrical change only, sparse busbar terminals and
  visible-only rendering above 1,500 nodes, an **overview canvas** below zoom
  0.15 (`OverviewLayer`), and a linear Reingold–Tilford **tidy tree**
  (`lib/treeLayout.ts`, trunk straight, laterals alternating) for Clean up on
  large circuits. **Incremental solve is not needed**: rebuild-and-solve is
  0.6 s on ckt24 and 1.4 s on a synthetic 15,000-bus feeder, so the hosted
  workers stay stateless and the parking-lot item is closed
- ~~**Bulk import formats**~~ — 2026-10-12: **File → Import from → GIS layers
  or CSV tables** reads shapefiles (loose or zipped), GeoJSON and CSV in the
  browser with no dependency (`lib/gis/`). A mapping dialog assigns each layer
  an element class and its columns to properties (auto-matched, remembered);
  topology comes from bus columns or, as GIS draws it, from geometry — ends
  snapped, point devices attached, a switch or transformer drawn as a point
  inserted with what is downstream moved past it. The result is OpenDSS text
  read by the ordinary importer. Still not read: Esri file geodatabases
  (they need GDAL; export them to shapefiles from QGIS or ArcGIS), Smallworld
  and Intergraph
- ~~**Geographic view**~~ — 2026-10-12: **Map** on the toolbar (`GeoCanvas`):
  OpenStreetMap, any XYZ tiles or none; lines along their routes, devices as
  marks, overlays coloured; select, edit, drag a bus (placing and wiring stay
  on the one-line). Coordinates stay as the file gave them in the circuit's
  `crs` — 1,601 named systems bundled (`scripts/make_crs_list.py`), or a
  pasted proj4/WKT — and proj4js maps them; an export writes them back as
  `SetBusXY`. Ryan chose map-style symbols, an own tile layer over a map
  library, and select/edit/move only
- ~~**Incumbent model conversion**~~ — 2026-10-12: **opendss-designer-convert**,
  a separate BSD-3 repository of that name (to be published on GitHub),
  forked from NREL/NLR's DiTTo with its history and trimmed to the CYME and
  Synergi readers and the OpenDSS writer. The URL the
  roadmap pointed at turned out to hold NLR's *active* 2024–26 rewrite (on
  grid-data-models), not the dormant DiTTo with a WindMil reader, and the
  fork follows the rewrite. Fixed along the way: regulator banks (#77),
  multiple sources, line-drop compensation, Synergi read without mdbtools
  (pure-Python `access_parser`), Synergi feeder-head and transformer
  orientation. Verified on CYME 5.04/8.00 exports of IEEE 13 and 123 (within
  1 % of EPRI's models) and one Synergi 6.4 model (a real Hawaiian Electric
  feeder, committed with provenance). The app finds it as an optional plugin
  (`core/convert.py`, **File → Import from → CYME… / Synergi…**). Still to
  do: **WindMil** (port the legacy DiTTo reader; needs sample files), offer
  the fixes upstream, and slim its dependencies (geopandas, pyarrow, h5py,
  plotly) so the hosted image can include it — today it is behind
  `--build-arg CONVERTER=...`, off by default

## M12 — Planning studies

The studies a utility is under obligation to produce — the reason a tool gets
adopted rather than admired.

- **Hosting capacity / integration capacity analysis** — iterative DER injection
  at each bus until a voltage or thermal limit binds, reusing the time-series
  worker and its SSE progress streaming, with a colour-coded overlay. This is the
  wedge: it is the one study regulators increasingly require and the one small
  utilities are priced out of
- **Contingency & switching** — tie switches, an N-1 loop, and ranked restoration
  candidates
- **Volt/VAR and CVR** — regulator and capacitor setting sweeps with a CVR factor
  report, building on the M6 `RegControl` work
- **Scenario manager & batch runs** — several scenarios per project, run as a
  batch, compared in one table. Supersedes the parked "multi-circuit tabs" item,
  which was the same need stated as a UI feature

## M13 — Team-scale modeling

Where a utility could standardise on it — and where support and liability become
the real questions, not features.

- **Load allocation from billing kWh or AMI data** — OpenDSS's own
  `AllocateLoads` works off `EnergyMeter` readings and per-load allocation
  factors, so the engine side largely exists; the work is the data pipeline and
  the UI for mapping meter data onto loads. Every incumbent has this (CYME's
  state estimator, Synergi's AMI and customer-management modules) and without it
  a model cannot be made to match measurements
- **Documented Python API** — `OpenDSSDirect.py` is already underneath; what is
  missing is a stable, documented surface for scripted runs, matching CYME's
  CymPy and Synergi's COM automation
- **Shared model store, versions, review** — collides with this repo's rule that
  it has no user concept (see M8). It belongs in `opendss-designer-cloud` or a
  separate sync service, not here

## Out of scope (decided 2026-09-11)

Recorded so they stop being reconsidered:

- **A protective-device curve library.** Ship TCC plotting in M6 and let users
  enter curves; do not try to match a library assembled over forty years
- **Arc flash labels.** The deliverable is legal rather than numerical — it needs
  a PE stamp, and buyers pick the tool their insurer already accepts
- **Real-time, SCADA, ADMS, OMS.** An operations business with 24/7 support
  obligations
- **Transmission and EMS.** PowerWorld and PSS/E own it, and the engine is not
  aimed at it

## Parking lot (deferred until actually needed)

- ~~**Incremental solve**~~ — closed 2026-10-12 by measurement: rebuild-and-solve
  is 0.6 s on a 10,000-element feeder, so it is not worth giving up stateless
  workers (see M11)
- **Multi-circuit tabs** / compare two scenarios side by side — big architectural change;
  wait until the single-circuit workflow is mature. Superseded by M12's scenario
  manager, which is the same need stated as a study rather than as a UI feature
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
- Shape-preserving routing points (2026-08-31): the first waypoint on an edge used to
  swap ReactFlow's smoothstep elbows for a straight polyline. `lib/edgeGeometry.ts` now
  reads the drawn path back off the screen, keeps its corners as waypoints, and puts the
  new point on the line it was clicked on.
