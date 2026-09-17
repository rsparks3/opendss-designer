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

## M7 — Platform & polish

- **Smarter .dss import layout**: elkjs layered layout; keep 2-terminal pass-through
  buses as plain wires instead of busbars
- **Automatic wire routing** (elkjs edge routing — shares the elkjs dependency)
- **File System Access API** in-place saves (localStorage autosave already shipped)
- **Dark mode**, printable/exportable diagram (SVG/PNG export)
- **Round-trip preservation** of comments and unsupported elements on export
- **Split line**: drop a bus in the middle of an existing Line edge

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
account that raises the limits, and a paid plan (~$5/month) that sells
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
below, because a feeder without them is not a feeder. **Next: the two M7 items the
rest depends on** — SVG/PNG export is the prerequisite for M10's study report, and
the elkjs layout for M11's real-feeder import. Each milestone below is chosen to be
useful to someone real on its own, not only at the end of the list.

## M10 — Study output & proof

The cheapest credibility available, and the first milestone that lets someone
hand a study to a colleague.

- **IEEE PES test feeder validation** — import the 13, 34, 37 and 123-bus
  feeders, compare bus voltages against the published solutions, and publish the
  comparison as a docs page. CYME and WindMil both advertise this benchmark; the
  engine already passes it, so this is reporting, not work. Worth pinning as a CI
  fixture alongside `tests/fixtures/full-circuit.oneline.json`
- **Study report export** — a PDF/Excel report of violations, losses, element
  tables and the one-line itself. Depends on M7's SVG/PNG diagram export. This is
  the artifact an engineer actually delivers, and no amount of on-screen analysis
  substitutes for it
- **Reliability indices** — SAIFI/SAIDI/CAIDI from OpenDSS's own `EnergyMeter`
  reliability calculations: needs meter placement, per-line `faultrate`/`pctperm`/
  repair-time properties in the properties panel, and an indices table plus a
  per-zone overlay. Every incumbent sells this as a paid module; here it is mostly
  UI over an engine feature that already exists

## M11 — Real models in

Nobody hand-draws a utility feeder. Until an engineer can open the model they
already own, the analysis features have no audience — this is the first real gate.

- **Scale to thousands of elements** — `.dss` import of real feeders needs the
  elkjs layered layout from M7, canvas virtualisation, and a hard look at
  rebuild-per-solve. (The parking-lot "incremental solve" item becomes relevant
  here for *editor responsiveness*; note it trades away the statelessness that
  makes the hosted workers scale horizontally, so if it lands it must stay behind
  a flag — see `docs/hosted-service.md`)
- **Bulk import formats** — CSV element tables, then Esri shapefile/geodatabase
  (bus coordinates and line geometry). GIS is how every incumbent builds models;
  CYME Gateway also reads Smallworld and Intergraph
- **Geographic view** — map background tiles and a schematic/geographic toggle.
  The importer already keeps bus coordinates; today they are only used to seed the
  layout
- **Incumbent model conversion** — CYME, Synergi and WindMil models via NREL's
  DiTTo, which already targets those formats but has had no activity since
  December 2023 and has open conversion bugs. Reviving it beats starting over.
  Belongs in a separate package so this repo does not take on a GIS/converter
  dependency tree. Strategically this is the biggest lever available: proprietary
  formats and unreliable conversion are the loudest documented complaint about
  the incumbents

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

- **Incremental solve** — reuse the compiled circuit when only parameter values changed;
  matters once circuits reach thousands of elements (v1 rebuilds every solve).
  Revisit in M11, where real feeders make it an editor-responsiveness question
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
