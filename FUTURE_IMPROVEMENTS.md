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

> **Facility planning track (added 2026-11-20).** A second track for installation-scale systems (bases, campuses: ERRE, MILCON, loss-of-utility) runs alongside this direction, in `OPENDSS_DESIGNER_DEV_PLAN.md`. Milestone A (trace and priority, scenario gaps, islanding, metered allocation) comes next.

## Direction — the distribution planning market (decided 2026-09-11)

M10–M18 are aimed at a specific goal: becoming an open-source alternative to the
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
**next: M12's planning studies**, starting with the load-level and control
foundation and then hosting capacity. M12 onward was rewritten on
2026-11-08 from a study-by-study audit of what a distribution planning
group is actually asked to produce — `PLANNING_AUDIT.md` keeps the
reasoning, the criteria tables and the references, so the items below can
stay short. Each milestone below is chosen to be
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
- ~~**Geographic view**~~ — 2026-10-12: **One-line | Map** on the canvas (`GeoCanvas`):
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
- **ETAP import** — asked 2026-10-14, not started: no sample to verify
  against. No open-source ETAP reader exists (neither DiTTo has one), and an
  `.oti` project is an undocumented Microsoft Access or SQL Server LocalDB
  container, so reading it directly means reverse-engineering hundreds of
  tables per ETAP version. The workable route is a converter reader for what
  ETAP 22+ exports itself: an element dump from its Python API (etapPy) or
  REST etapAPI, or failing that the DataX/report Excel export through the
  CSV mapping dialog. ETAP exports neither CIM nor OpenDSS. Blocked on
  obtaining one export from a real ETAP 22+ install (its bundled Example-ANSI
  project would do); ETAP's typical model is a balanced industrial plant
  (motors, MCCs, cables) rather than a feeder, so expect motors to land as
  loads and the fit to be weaker than CYME/Synergi. **SKM PowerTools** is the
  same case, ranked lower: its project is a proprietary database folder with
  no reader anywhere (ETAP's converter handles PTW 6–8, closed), its only
  scriptable export is the Datablock CSV, and it serves the arc-flash market
  this project chose not to enter. Cheap test before any code: run a PTW
  Datablock CSV (buses, cables, transformers, loads) through File → Import
  from → CSV; if the mapping dialog gets most of the way, SKM becomes a saved
  mapping preset, not a reader

## M12 — Planning foundation: load levels, controls, scenarios — ✅ DONE (2026-11-08)

Planned 2026-11-08 (`PLANNING_AUDIT.md` §2.3, §2.4, §2.15, §3). Every
planning study is "this feeder, at this load condition, base against
alternative". The app has none of the three nouns yet: a snapshot solves
every load at rated kW, two of the three control classes on a real feeder
cannot be drawn, and there is one circuit and one result at a time. This
milestone is useful on its own (a planner can finally run a minimum-load
case and compare two designs) and everything in M13–M17 stands on it.

- ~~**Named load levels**~~ — done 2026-11-08: a project-level list (Peak 1.0 normal, Minimum
  daytime 0.3 normal, Emergency peak 1.0 emergency, editable) applied as
  `set loadmult` plus optional per-class factors; snapshot, fault,
  protection and every later study pick a level, the status bar and the
  report name it. The engine change is one line; the rest is schema, a
  toolbar picker and report plumbing
- ~~**Emergency and seasonal ratings**~~ — done 2026-11-08 (`emergamps`/`emerghkva`; seasonal sets of ratings were not added — a level picks normal or emergency, which is what the criteria name): `emergamps` on lines and switches,
  `emerghkva` on transformers and regulators, read and written by the
  importer and exporter; the loading overlay, abnormal-condition report
  and limits dialog switch between normal and emergency, and a load level
  says which applies
- ~~**Capacitor controls**~~ — done 2026-11-08: `CapControl` as parameters on the capacitor
  (type voltage/current/kvar/PF/time, monitored element and terminal,
  on/off settings, PT/CT ratios, delay, dead time), emitted under the
  capacitor's name like a regulator's `RegControl`; an imported
  passthrough `CapControl` folds back into its capacitor
- ~~**Smart inverter functions**~~ — done 2026-11-08: `InvControl` as parameters on PV and
  storage: volt-var, volt-watt, watt-pf and the combined mode, each with
  an editable XY curve in the Curves tab (the TCC curve editor already has
  the shape), IEEE 1547-2018 Category A and B defaults one click away, one
  control per inverter group as the engine wants it. Regulators gain
  reverse-power mode (`reversible`, `revvreg`, `revband`) and `cogen`
- ~~**Control operation counters**~~ — done 2026-11-08: tap changes per regulator and
  switching operations per bank per time-series run, as a summary row and
  a plottable series; this is a hosting-capacity criterion and the
  measure of a Volt/VAR scheme's wear
- ~~**Scenario manager**~~ — done 2026-11-08, with one design change: the editor swaps a scenario's effective drawing in while it is open and diffs it against the base on the way out, so any edit the editor can make (add, remove, wire) is a scenario change with no second code path; a project holds a base case and alternatives as
  element-level deltas (a changed setting, an added bank, an opened tie, a
  new DER), each solvable at any load level; deltas rather than copies keep
  autosave and the library small and make the diff view trivial.
  Supersedes the parked "multi-circuit tabs" item, which was the same
  need stated as a UI feature
- ~~**Compare view**~~ — done 2026-11-08: two result sets as a difference overlay (ΔV pu,
  Δloading %, Δlosses) and a table of what changed, sortable by magnitude;
  a *Base vs alternative* report section
- ~~**Batch runs**~~ — done 2026-11-08: every scenario × every load level in one click with
  progress and cancel over the time-series SSE channel, summarised as a
  matrix (worst voltage, worst loading, losses, violations)
- ~~**One study library for two apps**~~ — done 2026-11-08 as `opendss_designer.studies` (scenarios, batch; the loops of M13–M16 go beside them) over `core/jobs.py`, a one-worker job queue with progress, cancel and the last twenty results; parallel engine contexts were not measured, since the first loops run as one engine call each (the time-series pattern) and the job queue serialises them. Before any study loop is written,
  the loops in M13–M16 go in one Python package that both this repo and
  `opendss-designer-desktop` import (compiled circuit in, plain dicts out;
  FastAPI here, in-process there), so hosting capacity is not written
  twice. Decide the package boundary and the engine-context rule (one
  thread per `dss.NewContext()`) in this milestone, measure parallel
  engines, and add server-side **background jobs** (submit, progress,
  cancel, fetch later, keep the last N) that the long studies need and
  the hosted plans can meter as a *study cost* beside the time-series cost

## M13 — Hosting capacity and interconnection screening — ✅ DONE (2026-11-08)

The wedge (`PLANNING_AUDIT.md` §2.1, §2.2, §2.9 in part): the study
regulators require, small utilities are priced out of, and the one that
turns an interconnection queue into a day's work.

- ~~**Hosting capacity, iterative**~~ — done 2026-11-08 (protection reach waits for M16's sliding fault; control operations are a post-check option, not yet wired): DER placed at each candidate bus and
  grown by bisection until a criterion binds, at a chosen load level; the
  criteria, each switchable and each reported as the binding one:
  overvoltage against the project limit (or a tighter DER limit), rapid
  voltage change on DER trip (3 %), thermal at normal or emergency rating
  in either direction, reverse power through a regulator and at the
  substation, fault-current increase (10 %) and interrupting headroom
  (87.5 %), protection reach, islanding ratio in a protection section, and
  control operations from a QSTS pass. **Load hosting capacity** (EV and
  electrification: the same loop with the sign reversed, binding on
  undervoltage and thermal) ships in the same release
- ~~**Hosting capacity, sensitivity method**~~ — done 2026-11-08: one base solve plus one
  perturbation per bus gives dV/dP and dI/dP; voltage- and thermal-limited
  capacity by linear extrapolation, confirmed by one or two solves. This is
  the shape of EPRI's DRIVE and the only way an 8760 hosting-capacity
  profile per bus is affordable; the iterative method stays as the check
- ~~**Time-granular results**~~ — done 2026-11-08 (a list of hours over the daily shapes; the per-bus profile is kept and the worst hour reported): the loop at 24 representative hours or
  every hour of a year, giving a per-bus hosting-capacity profile, the form
  California's ICA publishes
- ~~**Outputs**~~ — done 2026-11-08: bus → kW by criterion with the binding one named; colour
  overlay on the one-line and the map; GeoJSON/shapefile/CSV export keyed
  by bus so the result can go onto a public ICA map; a report section with
  method, criteria, load level, scenario and engine version; compare two
  runs (before and after a mitigation) through M12's compare view
- **Methodology and validation page** — `docs/hosting-capacity.md` written 2026-11-08 with the criteria, methods and the internal checks; the comparison with a published reference is still open: `docs/hosting-capacity.md` with
  the criteria, equations and limits, held against a public reference
  (EPRI's published DRIVE results on the IEEE 123-bus and ckt5, NREL's
  hosting-capacity papers on the same feeders) the way `docs/validation.md`
  holds the power flow. Without it a utility will not trust the number
- ~~**Fault solves the screen needs**~~ — done 2026-11-08 (`studies/faults.py`: fault point and sweep; inverter contribution stays analytic, since OpenDSS has no snapshot fault model for an inverter): `Fault`-element snapshot solves
  (LG, LL, LLG, with fault resistance) beside `mode=faultstudy`, so a
  fault study reports minimum as well as maximum current and includes
  inverter and generator contribution, which the Thevenin study cannot
- ~~**Interconnection screening**~~ — done 2026-11-08 (flicker is not evaluated; the smart-inverter settings are reported, not judged): a *Screen a DER here* dialog at a point
  of common coupling that runs the tariff screens in one go and writes the
  standard screening report: aggregate DER against 15 % of line-section
  peak (or 100 % of minimum daytime load for export), fault-current
  contribution under 10 %, interrupting duty under 87.5 %, rapid voltage
  change under 3 %, effective grounding from the X0/X1 and R0/X1 ratios the
  fault study already has, and the Category A/B smart-inverter settings
  the DER must run. Pass/fail per screen with the number and the limit

## M14 — Contingency, Volt/VAR and capacity — ✅ DONE (2026-11-08)

Batch studies over the solves M12 made available (`PLANNING_AUDIT.md`
§2.4, §2.5, §2.7, §2.8).

- ~~**Tie switches and switching sequences**~~ — done 2026-11-08 (a `tie` flag on breakers; sequences as `POST /api/switching`, kept as scenarios): a normally-open switch
  between feeders as a first-class element with both feeders named; a
  scripted sequence (open X, close Y) on a scenario, solved at a load
  level, with the energised/de-energised state shown (the phases walk
  already knows *unfed*)
- ~~**N-1 enumeration and restoration ranking**~~ — done 2026-11-08 (unserved load from the de-energised buses rather than EnergyMeter EEN/UE registers, which need a meter per feeder): for each sectionalising
  device, substation transformer or feeder breaker: take it out, close the
  best tie, solve, record worst voltage, worst loading and unserved load
  (the EnergyMeter's EEN/UE registers); a ranked table and an overlay of
  what can be restored and what cannot
- ~~**Transfer capability**~~ — done 2026-11-08: for each tie, the kW it can carry at the
  emergency rating before a criterion binds, which is M13's load hosting
  loop at a tie
- ~~**Volt/VAR setting sweeps**~~ — done 2026-11-08: a grid of regulator setpoint × bandwidth
  (or LDC R × X) and capacitor settings run over a day or a year,
  tabulating losses, voltage range, operations and violations
- ~~**CVR evaluation**~~ — done 2026-11-08: paired runs at normal and reduced setpoint with
  loads on the CVR models, reporting energy saved, CVR factor and the
  lowest customer voltage
- ~~**Capacitor placement**~~ — done 2026-11-08 (direct trial solves rather than M13's sensitivities, which were not needed at this size): rank candidate buses by loss reduction and
  voltage lift for a bank size, by greedy search over M13's sensitivities
- ~~**Phase balancing**~~ — done 2026-11-08: unbalance % at the feeder head and each device
  (NEMA and IEEE definitions, as a column everywhere per-phase voltages
  are shown), a ranked list of single-phase laterals to re-pin with the
  predicted unbalance after the swap, and *apply* that re-pins and re-solves
- ~~**Loss evaluation and capacity**~~ — done 2026-11-08 (capacity by the app's own bisection on `loadmult`, which needs no EnergyMeter): yearly technical losses by element
  class with a cost line, and the engine's `Capacity` search (the load
  multiplier at which EEN/UE begin) as a report row
- **Reconfiguration suggestions** — not done; the N-1 loop's tie evaluation is the building block, and a branch-exchange search over the tie set waits for a feeder with enough ties to need it: the open-point
  set that minimises losses or balances feeders, by branch exchange over
  the tie set

## M15 — Model quality, libraries and the secondary — ✅ DONE (2026-11-08)

The model a planner will sign (`PLANNING_AUDIT.md` §2.6, §2.12, §2.13).
Runs alongside M13–M14 because it is mostly schema and import work.

- ~~**Equipment libraries**~~ — done 2026-11-08 (conductors and geometries editable, a starter conductor library and a transformer catalogue as CSV; the report prints miles and feet on request; libraries live with the project and the catalogues with the server, not yet shared across projects in the browser): conductors (`WireData`, `CNData`, `TSData`)
  and pole/trench configurations (`LineGeometry`) editable in the app and
  shared across projects, with a starter library of standard ACSR/AAC
  conductors and common cables; transformer and regulator catalogue
  entries (impedance, losses, ratings) so a unit is picked, not typed.
  Today only a geometry's computed matrix survives import. Imperial and
  metric throughout, including the report
- ~~**Model QA report**~~ — done 2026-11-08: one click, beyond the live validation: missing
  ratings and impedances, lengths implausible for the voltage class, loads
  with no customers or kV, voltage bases matching no winding, loops in a
  radial feeder, open points with no tie, phasing conflicts, orphan
  passthrough references; a completeness score per class and a CSV. The
  first thing a utility runs on a converted model
- ~~**Load classes**~~ — done 2026-11-08 (a free-text *Class* on loads, used by levels, allocation, adoption and the report): residential/commercial/industrial or the utility's
  own, used by allocation, adoption scenarios, growth and reports
- ~~**Service transformers and secondaries**~~ — done 2026-11-08 (the existing transformer symbol with a *splitphase* flag rather than a new symbol; loads pin to leg A, B or both): a split-phase 120/240 V
  centre-tapped transformer symbol (the single-phase three-winding form),
  secondary conductors, loads at 120/240 V, a **transformer load
  management** table (peak loading, hours over rating, IEEE C57.91 loss
  of life per unit) and a secondary voltage check against 114 V at the
  meter. The electrification question is asked here, not on the primary
- ~~**Distributed load along a section**~~ — done 2026-11-08 in the GIS/CSV import (the converter's CYME and Synergi readers already lump it, and changing them is work in that repo): CYME and Synergi spread load
  along a line and OpenDSS cannot; the converter and importer split the
  line or place the equivalent at one-third/two-thirds, and say which
- ~~**Growth and adoption scenarios**~~ — done 2026-11-08 (growth as generated load levels rather than `GrowthShape`, which the level machinery already does; adoption draws as scenarios with built-in EV shapes): `GrowthShape` per load or class and
  a study-year selector on M12's scenarios; EV, heat-pump and PV adoption
  rates by class or zone drawn at random with a seed, shapes attached (EV
  charging shapes from user CSV or a public source), run as QSTS over
  several draws with the spread reported
- ~~**Load allocation and calibration**~~ — done 2026-11-08 (the app's own scaling to the metered head rather than the engine's `AllocateLoads`, which needs a meter and a sensor): billing kWh or AMI interval kW
  per customer or per service transformer, matched by transformer ID,
  meter ID or coordinates in a mapping dialog (the GIS import dialog is
  the pattern); kWh to kW by class load factor or profile; the engine's
  `AllocateLoads` against feeder-head `Sensor`/`EnergyMeter` readings;
  AMI intervals become loadshapes directly; a report of the allocation
  and the mismatch to SCADA. Every incumbent has this and without it a
  model is nameplate
- ~~**Audit trail**~~ — done 2026-11-08: who changed what and when at element level, saved
  with the project and printable, built on M12's scenario deltas

## M16 — Protection and reliability depth — ✅ DONE (2026-11-08)

What the protection engineer and the reliability analyst ask for after M6
and M10 (`PLANNING_AUDIT.md` §2.9, §2.10).

- ~~**Fault anywhere on a line**~~ — done 2026-11-08: a sliding fault at a chosen distance
  (the line split in the compiled model only) with the current seen by
  every upstream device
- ~~**Reach and fuse-saving**~~ — done 2026-11-08 (DER infeed taken off analytically; total clear from a fuse's own curve or melt × 1.15): minimum fault at the end of each device's
  zone against its pickup, with and without DER; fuse-saving versus
  fuse-blowing evaluation for recloser–fuse pairs (fast curve clears before
  the fuse's minimum melt at maximum fault, delayed curve after total clear
  at minimum fault)
- ~~**Sectionalizers, sequences and ratings**~~ — done 2026-11-08 (OpenDSS has no sectionalizer class; it compiles as a relay nothing trips, which heads a reliability section and stays off the TCC plot): `Sectionalizer`, recloser
  shots and reclose intervals, continuous and interrupting ratings on
  fuses and reclosers, not only breakers
- ~~**Settings sheet**~~ — done 2026-11-08: per-device settings in the report as a relay
  technician reads them: pickup in primary amps and multiples, curve, time
  dial, instantaneous
- ~~**Reliability indices**~~ — done 2026-11-08 (CEMI as the expectation over the sections above each load, not a Monte Carlo draw; outage cost at order-of-magnitude default rates): MAIFI from recloser fast operations and
  `pctperm`, ASAI, CEMI/CELID, load-weighted ASIFI, and outage cost by
  customer class
- ~~**Device placement what-if**~~ — done 2026-11-08 (reclosers on lines; automated switches are the same loop with a `tie`/`sectionalizer` flag and wait for a request): a loop over candidate recloser or
  automated-switch locations ranked by ΔSAIDI per device, through the
  scenario manager; the number that justifies the spend

## M17 — Interoperability and power quality — ✅ DONE (2026-11-08)

- ~~**CIM import, then export**~~ — done 2026-11-08 (an own reader and writer in `core/cim.py` rather than the grid-data-models reader, which the converter plugin keeps): IEC 61968-13 CDPSM / CIM100 RDF/XML, the
  exchange format large utilities and both Synergi and CYME support; the
  grid-data-models fork under the converter has a reader to build on
- ~~**MultiSpeak**~~ — done 2026-11-08 from the specification, verified against a synthetic sample only; a real export is wanted: the co-op standard WindMil and most co-op GIS/CIS
  speak; the route to that market without reverse-engineering WindMil
  files. **WindMil reader** and **ETAP/SKM** stay as noted under M11
- ~~**Results to GIS**~~ — done 2026-11-08 as GeoJSON, CSV and KML (a shapefile writer was not added: GeoJSON opens in every GIS and QGIS converts): every study result as GeoJSON/shapefile/CSV keyed
  by element, and KML, so hosting capacity, voltage and loading publish in
  the utility's GIS; result legends, click-to-table and layer export on
  the map
- ~~**Documented Python API and CLI**~~ — done 2026-11-08 (`studies.run_study`, `STUDIES`, `opendss-designer run`, `docs/api.md`): the study library of M12 as the
  public surface (`opendss_designer.studies`), `opendss-designer run
  <project> --study …` headless, and OpenAPI docs for the REST routes;
  matches CYME's CymPy and Synergi's automation
- ~~**Harmonics**~~ — done 2026-11-08 (the engine's default spectra; a project spectrum library waits for a user with spectra): `mode=harmonics` with a `Spectrum` library, THD per bus
  against IEEE 519, a report section; last because planning studies come
  first and users rarely have spectra
- ~~**Flicker and rapid voltage change**~~ — done 2026-11-08: ΔV from paired solves for motor
  starting and PV transients against IEEE 1453 / 1547 §4.7, reusing M13's
  trip test

## Before M12–M17 go to the hosted instance (found 2026-11-15) — ✅ DONE the same day

Resolved 2026-11-15: gateway 0.6.0 (cloud branch `studies-gateway`) holds a
worker per background job, follows it, meters it and pins its calls; the
direct studies joined its engine paths; studies are withheld below Pro
(`features.studies`, in the deploy repo's `gateway/plans.json`); the ckt5
importer regression is fixed (8797349). Workers `sha-5a2270c` (0.9.0) are
live. What was found, for the record:

- **Background jobs need worker affinity.** `JobManager` is in-process and
  the gateway round-robins every unknown `/api` path over two workers, so a
  `GET /api/jobs/{id}` lands on the wrong worker half the time. Either the
  gateway pins `/api/jobs/*` (worker index in the job id, or a sticky cookie)
  or job state moves to a shared store.
- **~30 new engine endpoints are unmetered.** Everything the branch added
  (`/api/jobs/*`, `/faultpoint`, `/switching`, `/transfer`, `/cvr`,
  `/capacity`, `/qa`, `/allocate`, `/faultline`, `/fusesaving`, `/rvc`,
  `/screen`, `/import/cim`, `/import/multispeak`, `/export/cim`) bypasses the
  gateway's slot and plan metering (`ENGINE_PATHS` in the cloud repo lists
  four paths). Jobs also need their engine seconds reported at completion,
  not on submit.
- **EPRI ckt5 and ckt24 round-trips fail on this branch** (58 pu at bus
  8086.1 on ckt5; `tests/test_large_feeders.py`, 4 failures) and pass on
  `main`. The samples live outside the repo, so CI does not see it.

## M18 — Team-scale modeling

Where a utility could standardise on it — and where support and liability become
the real questions, not features.

- **Multi-project and versioning** — open two projects, compare across
  them, keep history; the library is single-circuit today
- **Shared model store, versions, review** — collides with this repo's rule that
  it has no user concept (see M8). It belongs in `opendss-designer-cloud` or a
  separate sync service, not here
- **Methodology documents and support posture** — a page per study in
  `docs/` with criteria, equations and limits and a validation page each;
  a changelog that names schema changes; a saved-project migration path;
  long-term support of the engine version the validation pages were run
  with; printing a 10,000-element one-line in tiles with a key map

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
- **Stochastic hosting capacity** (EPRI's original distributed-portfolio
  method) — utilities report it mostly as a check on the node-by-node
  result; add after M13 if a user asks
- **Cost and NPV of alternatives** — unit costs on scenarios and a
  present-value comparison; CYME sells it as a module, but every utility
  has its own spreadsheet and model, so wait for a request
- **Esri Utility Network / file geodatabase direct read** — needs GDAL or
  the ArcGIS API; shapefile export from QGIS/ArcGIS covers it today
- **Dynamics and motor starting in `mode=dynamics`** — outside planning;
  the flicker check in M17 covers the voltage question
- **Parking a wire mid-air** (an end connected to nothing) — considered alongside
  drag-to-re-route and declined: ReactFlow has no dangling edge, so it would need a
  placeholder node standing in for "not connected", and grab-and-drop makes the
  two-step park-then-reconnect workflow unnecessary. If temporarily removing a
  branch is ever wanted, an edge-level "out of service" flag (still attached at
  both ends, omitted from the compile) is the cheaper answer.

- **More help hints.** `lib/struggles.ts` (added 2026-11-14) is a table of
  rules over signals the components report; a new struggle is one hint, one
  rule and one `signalStruggle` call. Candidates not yet detected: a drawing
  key (R, Delete, a placement letter) pressed while a text field has focus;
  busbar end grips never used (elements wired to a bar's middle); the Elements
  spreadsheet never found for bulk edits; a scenario left active while editing
  what was meant for the base case. The map view reports nothing yet.
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
