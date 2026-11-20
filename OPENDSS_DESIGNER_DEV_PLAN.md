# OpenDSS Designer — Facility Planning Development Plan

**Scope:** Tiers 1–3 of the facility-planning roadmap. Turns OpenDSS Designer from a power-flow viewer into a resilience and capacity planning tool for installation-scale distribution systems (military bases, campuses, large industrial sites).

**Baseline:** first drafted against v0.8.0. Tier 1 was reconciled with **v0.9.0** (2026-11-15) on 2026-11-20. 0.9.0 adds the following:
- load levels, scenarios and Compare;
- N-1 contingency, hosting capacity and the Studies tab;
- allocation from meter data;
- GIS coordinates and the map view;
- the TCC graph.

**Tiers 2 and 3 have not yet been reconciled.** Several of their items partly exist (2.1 N-1, 2.2 feeder capacity / hosting-capacity load mode, 2.5 TCC graph, 3.2 map view, 3.3 shapes). Reconcile each one, as Tier 1 was, before starting it.

**Relation to the roadmap:** this plan is a second track (facility / installation planning) *alongside* the utility distribution-planning direction in `FUTURE_IMPROVEMENTS.md`. It does not replace that direction.

**Primary user:** an installation energy manager or resilience officer with an existing distribution model, running Energy Resilience Readiness Exercises (ERREs), evaluating large load additions (MILCON), and justifying capital projects. Secondary users: base electricians and planning contractors.

---

## 0. Constraints that govern every feature

These come from the Iron Bank / DoD deployment path and apply to all work below.

| Constraint | Consequence |
|---|---|
| **No runtime network access** | No basemap tiles, no on-demand downloads, no CDN fonts. Everything ships in the wheel. |
| **Stateless server, no auth** | All state lives in the project JSON or the browser. No server-side projects, users, or job queues beyond the existing solver queue. |
| **Stable project file format** | Bases will accumulate project files. Every schema change below is additive and versioned (`schemaVersion`), with a migration on load. Never remove or rename a field. |
| **One maintainer** | Prefer features that reuse the existing solver loop, canvas, and report pipeline. Avoid anything that needs a curated library of third-party data. |
| **Demo-mode limits apply** | Sweeps (contingency, sizing) must respect `--demo` caps: bounded iteration counts, cost estimates shown before running. |
| **Honest labeling** | Screening-grade features (duty check, island modeling) say so in the UI and in the report. Never imply ANSI/IEC standards compliance. |

### Architecture touchpoints

- `frontend/` — React + Vite + React Flow; zustand store is the canonical circuit model (zundo undo). New state slices for scenarios, tags, and study results.
- `src/opendss_designer/core/connectivity.py` — union-find graph → OpenDSS buses. Trace and island features extend this.
- `src/opendss_designer/core/compiler.py` — circuit JSON → OpenDSS commands. Scenario overrides are applied here before compilation.
- `src/opendss_designer/core/engine.py` — solve + extract. Sweeps call `solve()` in a loop; no engine state between calls.
- `src/opendss_designer/core/importer.py` — `.dss` import. New importers go in the `opendss-designer-convert` plugin.
- Report pipeline (PDF/Excel) — new sections appended; existing sections unchanged.

### Schema versioning rule

The document version is `version`, checked in `frontend/src/lib/schema.ts` (`SCHEMA_VERSION`, with the `MIGRATIONS` table there). Every change to the document shape bumps it and adds a migration there. A backend model change (`core/model.py`) is needed only for new **project-level** keys. Element params are a free dict.

Export to `.dss` must continue to work with every field below ignored. Import of an older project must never fail.

---

## 1. Milestone A — Resilience core (Tier 1)

**Goal:** answer the three ERRE questions in the tool: *what is feeding what, what happens when the utility goes away, and what does the system look like under each operating configuration.*

**Reconciled with v0.9.0 on 2026-11-20.** This section was first written against v0.8.0. Since then 0.9.0 shipped scenarios, load levels, comparison, allocation from meter data and N-1. Each item below names what already exists (the design of record) and lists only the remaining work. Where this plan and the code disagreed, the code's design was kept:
- `activeScenario`, not `activeScenarioId`.
- Generator rating is `kva`, not `ratingKVA`.
- Customers are `numcust`.
- The schema version is `version` in `frontend/src/lib/schema.ts`.

**Order:**
- **0. Prerequisites.** The generator-as-island spike and the samples.
- **1.2** Trace and priority.
- **1.1** The rest of the scenario work.
- **1.3** Islanding.
- **1.4** Metered-zone allocation.

The trace (1.2) is a dependency for islanding (1.3) and allocation zones (1.4).

### 1.0 Prerequisites

- **Island-source spike (before any 1.3 UI).** The compiler makes the first `vsource` node the `circuit.source` (`compiler.py`). Prove that this circuit solves with plausible voltages:
  1. Disable the utility source.
  2. Compile one generator as a `Vsource` at its terminal.
  3. Solve the island.

  If disabling `vsource.source` misbehaves, choose the fix here. One option is a synthetic, always-isolated root source; another is reordering so a utility source is always the root. Record the outcome in this section.

  **Spike result (2026-11-20): it works, and no reordering is needed.** The test used the radial-feeder-DER sample plus a `vsource` modelling a 1 MVA generator (Xd'' = 0.15, so MVAsc = 6.67, X/R 20) at the midpoint. Each of the following converges in 2 iterations with island voltage at 0.992 pu:
  - utility `enabled:false`;
  - utility breaker open;
  - generator listed first.

  In every case the power balances (generator 566 kW + PV 337 kW ≈ 900 kW load + 2.5 kW storage), and PV and storage stay PQ. An island with no source solves to 0 pu, with loads at 0 kW and zero losses.

  **Bug found:** with *every* source disabled, `engine.solve` returns `converged: true` and no issue. 1.3 must report that case ("no energized source") instead of a silent empty result. The spike script is not kept in the repo; turn it into tests in 1.3.
- **Samples:**
  - **`installation-campus`**, a synthetic, fictional installation: a utility substation, 2–3 feeders with a normally-open tie, two standby generators, loads at every priority, and building names. It is the Milestone A exit demo.
  - **`looped-two-source`**: small, for the 1.2 loop test.

  Both ship in `samples/` like the IEEE feeders.
- **Schema.** Bump `SCHEMA_VERSION` to 2 in `frontend/src/lib/schema.ts` with a no-op migration (1→2). This marks files that may carry the fields below. Element params are a free dict, so the new load and generator fields need no migration. Only new project-level keys (`tagVocabulary`, `allocations`) touch the backend `Circuit` model. Older builds open a v2 file with the existing "newer version" warning.

### 1.1 Scenario manager — mostly shipped in 0.9.0

**Exists:**
- **Storage and application.** `Scenario` (`core/model.py`) stores sparse `overrides`, plus `addedNodes`/`addedEdges`/`removed`. The server applies it: `core/scenarios.py` (`apply_scenario`, `effective_circuit`).
- **UI.** A toolbar dropdown and Analysis → Scenario. The Scenarios panel can create, duplicate, delete and describe a scenario. Edits while a scenario is open are diffed back into its deltas on exit (`circuitStore.activateScenario`).
- **Runs.** A batch run covers every scenario at every load level (`/api/jobs/batch`). The Compare overlay and tab work against a pinned baseline. The report has *Comparison* and *Scenarios and load levels* sections.
- **Load scaling.** Scaling per condition is handled by **load levels** (`loadmult` + `classMult` by load `class`).

**Dropped from the original plan:**
- **Per-scenario `loadScale`.** Load levels already do this, and batch runs cover scenario × level.
- **A `scenarioId` parameter on the study routes.** The active scenario already travels inside the circuit.
- **Undo/redo across scenario switches.** Switching clears history on purpose; undo works within a scenario.

**Remaining:**
- **Override allowlist per element type**, enforced in `core/scenarios.py` (reuse the compiler's per-property sanitising lists). *Done differently (2026-11-20):* no per-type key allowlist exists to reuse, and base-case params aren't restricted either. The real guard is the compiler, which allowlists or clamps every value where it reads it. `Scenario.overrides` now refuses anything that isn't a parameter patch: identifier keys, plain JSON values nested at most three deep, and at most 64 kB per element.
- **Dashed halo** on elements a scenario overrides, adds or removes. The hover tooltip shows base vs. scenario values.
- **A banner on the canvas:** "Editing scenario X — Return to base case".
- **Scenarios panel:** rename, reorder, and *Promote to base case* (confirm; this replaces the base with the scenario's resolved drawing and removes the scenario).
- **Compare table per element across scenarios** *(done: Scenarios tab → batch view)*: extend the batch job to optionally return per-element results (bus voltages, element loading, losses, unserved kW by priority). Display one column per scenario and highlight the worst value per row. This lives in the Scenarios panel's batch view, not in a new route.
- **`.dss` export scenario picker:** base or any scenario, fully resolved.
- **Report:** scenario definitions with their overrides spelled out in words.

**Acceptance:**
- Three scenarios survive save → load unchanged.
- A file with no `scenarios` key still loads (already true).
- A `.dss` exported from a scenario equals a `.dss` from a hand-edited base in the same state (demo substation).
- An override outside the allowlist is rejected.

### 1.2 Critical-load tagging and upstream/downstream trace

**Exists:**
- `lib/selection.ts` `downstreamOf()`, used by "Select everything downstream". **It ignores open switches and out-of-service elements; fix it as part of this item.**
- `core/protection.py` `_upstream_chain`: the chain of protective devices from each source.
- The `validate.py` reachability check.
- The spreadsheet fill handle (`BottomPanel` `ElementTable`): its columns come from `FIELDS[type]`.
- `Circuit.comments` and the importer's comment collection.

**Data model:**
- Load params gain:
  - `priority`: `critical` | `essential` | `nonessential` | `unassigned`, default `unassigned`. It is independent of the existing free-text `class`, which stays the load-type key for load levels and allocation.
  - `tags`: a string list.
  - `building`: free text.
- Customers stay as `numcust`.
- Project-level `tagVocabulary?: string[]`.

**Backend:**
- `core/connectivity.py` (or a new `core/trace.py`) gains two functions:
  - `upstream_paths(circuit, element_id)`: every path to every in-service source, as ordered series elements and buses.
  - `downstream_set(circuit, element_id)`: whatever loses every source when the element opens.

  Both respect open devices and out-of-service elements, and run on the scenario-resolved circuit.
- `POST /api/trace` for the report and for tests.

**Frontend:**
- A matching client-side trace in TypeScript. It replaces `downstreamOf` and is unit-tested against the same cases as the Python.
- Right-click *Trace to source* highlights the path(s). Right-click a device → *Show downstream* dims everything else and opens a list panel: loads grouped by priority, with kW and `numcust` totals.
- **Priority overlay:** loads coloured by priority. Buses and busbars take the highest priority downstream. Follow the reliability overlay pattern.
- Fields: priority dropdown, tag chips (a new field kind), and building. In the spreadsheet these become editable, fill-down columns.
- **`.dss` round trip:** `! designer: priority=critical tags=a,b building="Bldg 1200"` above the load on export, parsed back on import.

**Report:** a *Critical loads* table listing every critical and essential load with:
- its feeding source;
- its feeder (the first series element out of the substation bus);
- its transformer;
- the first protective device upstream (from `_upstream_chain`).

**Acceptance:**
- IEEE 13-bus: the expected path for every load.
- On the installation sample: downstream of the feeder-head device equals that feeder's loads, and downstream of a lateral fuse equals that lateral only.
- `looped-two-source`: both paths are returned, and a device on the loop drops nothing.
- Python and TypeScript give the same results on all samples.

### 1.3 Islanding / loss-of-utility study

**Exists:**
- Every element has an `enabled` ("In service") flag.
- Scenario overrides can disable a source and change generator params.
- `validate.py` already reports islands as a *warning*.
- `studies/contingency.py` `_Net` has the dark-bus and unserved-kW logic, reusable for per-island summaries.
- Generator `kva` exists (blank means 1.2 × kW).

**Engine approach** (subject to the 1.0 spike):
- OpenDSS has no isochronous generator. A generator in *isochronous* mode compiles as a `Vsource` at its terminal: `basekv` from the generator kV, `pu=1.0`, and `r1/x1` from the subtransient reactance, `x1 = Xd'' · kV² / MVA` on the generator's `kva` base. `Xd''` defaults to 0.15 pu.
- **As built (2026-11-20):** Xd'' sets the source impedance in **fault studies** only (fault study, fault point, fault sweep: `compile_circuit(fault=True)`). In the **power flow**, the machine's voltage regulator holds its terminal, so the source is nearly stiff (a twentieth of Xd''). With the full Xd'' in series, a 1.5 MVA set at 80 % sagged its island to 0.92 pu, a drop the real machine would correct, which would break the honest-labeling rule. G1's fault contribution checks against hand calculation: 465 A vs. 437 A.
- In *grid* mode the generator keeps today's `new generator` emission.
- Zero isochronous sources in an island: all of its loads are unserved. More than one: warn and treat them all as `Vsource`; results are indicative only.
- The island warning becomes a status (not a warning) when the island contains an isochronous source.

**Data model:**
- Generator params gain:
  - `islandMode`: `grid` | `isochronous`, default `grid`. It is *not* `mode`, because the existing `model` field is already labelled "Mode" in the UI.
  - `xdpp`: pu, optional.
  - `fuelHours`: optional, used by the report only.
- Vsource params gain `kind`: `utility` | `other`, default `utility`.
- Add `islandMode` to the 1.1 override allowlist.

**Backend:**
- `POST /api/islands`: a topology-only pass returning islands (bus sets), their sources, and unserved loads by priority.
- `/api/solve` adds a per-island summary when islands exist: served kW/kvar, generator loading as % of `kva`, min/max bus voltage, and unserved kW by priority.

**Frontend:**
- **Islands overlay:** one colour per energized island. Unenergized islands are grey, with their loads shown dark.
- **Island summary cards:** source, served kW, loading, voltage range, unserved critical kW. A card is red if loading is over 100 % or any critical load is unserved.
- **"Utility outage" action:** creates a scenario with every `kind=utility` source disabled and every generator set to isochronous, then opens it.

**Report:** a *Loss-of-utility* section per scenario: an island table and an unserved-load table, plus the modeling note on isochronous sources.

**Acceptance:**
- Radial feeder with PV and storage, plus one added generator: opening the utility yields one island carried by the generator, with PV and storage still PQ.
- A load with no source contributes zero to served kW and losses.
- Generator loading against `kva`: overloaded gives a red card, adequate gives green.
- Installation sample: utility outage forms the expected islands.

### 1.4 Load allocation to a metered value

**Exists:** `studies/allocation.py` (M15), `POST /api/allocate`, and `AllocationDialog`. It turns billing kWh / kW / AMI intervals into kW per load and an AMI loadshape. It can then scale *every* load to a source kW target, in two fixed passes. The results are baked into the loads, in the open circuit or in a new scenario. Keep all of it; metered zones are a layer on top.

**Data model:**
- Load params gain `fixed` (bool).
- Project-level `allocations: [{ id, meterElementId, targetKW, targetKvar?, targetPF?, demandFactors?: {priority|tag: factor}, source?: string, lastFactor?, lastAchievedKW? }]`.

**Approach:**
- **Zone:** `downstream_set(meterElementId)` from 1.2. The default meter is the source.
- **Iteration:**
  1. Apply the demand factors.
  2. Solve.
  3. Read kW (and kvar) at the meter element.
  4. Scale the non-`fixed` zone loads by `target / measured`.
  5. Repeat until within 0.5 % or after 5 iterations. Report a failure to converge rather than hiding it.
- **Overlapping zones** are refused with a message. Nested zones count as overlapping.
- **Storage (decided):** `lastFactor` is stored and applied at compile time, so entered values survive. The `.dss` export writes the scaled values with a `! allocated: factor=…` comment. *Bake into loads* is an explicit action, and so is *Clear*.
- The existing source-target scaling in `allocation.py` moves to the same convergence loop (0.5 %, max 5) instead of two fixed passes.

**Backend:** `POST /api/allocate` gains a `zone` mode (meter element + targets) returning factor, achieved kW/kvar, iterations and converged. The compiler applies stored factors to zone loads.

**Frontend:**
- Right-click a series element → *Allocate to metered value…* opens the dialog in zone mode, with *Apply* / *Bake* / *Clear*.
- Allocated loads get a small badge.

**Report:** a *Load basis* section: each allocation with its target, measurement source (free text), factor and convergence.

**Acceptance:**
- Demo substation, target 90 % of base solved kW: converges within 0.5 % in ≤ 3 iterations.
- `fixed` loads are unchanged.
- Two non-overlapping zones on the installation sample allocate independently. An overlapping zone is refused.
- The existing M15 allocation tests still pass.

---

## 2. Milestone B — Planning studies (Tier 2)

**Goal:** the capacity and contingency deliverables a planner needs for a MILCON review or a resilience assessment.

Suggested order: 2.1 → 2.2 → 2.4 → 2.5 → 2.3.

### 2.1 N-1 contingency sweep

**Approach.** For each series element (line, transformer, breaker, fuse, recloser, regulator) not already open: set `enabled=no`, solve the snapshot (or the peak hour of a chosen load shape), collect metrics, restore. Metrics per outage: unserved kW by priority, worst bus voltage, worst element loading, losses, islands formed.

**Cost control.** Elements × one solve. Show an estimate before running; in demo mode cap at the demo circuit-size limit. Run in the existing solver queue; stream progress events like the time-series run does.

**Options.** Include generators in isochronous mode (so a contingency with backup is evaluated) or not; exclude elements by tag; N-1 on transformers only.

**Frontend.** Contingency tab: ranked table (worst first), click a row to apply that outage as a temporary view on the canvas with the standard overlays. "Save as scenario" promotes a row to 1.1.

**Report.** *Contingency ranking* table, top N configurable, with the criteria.

**Acceptance.** IEEE 13-bus: sweep completes, every row's unserved load equals the downstream set of that element from 1.2 (when no alternate path exists). Timing under 10 s on the 123-bus.

### 2.2 Capacity headroom report and probe load

**Approach.**
- Headroom table: for every transformer, line, regulator and source — rating, peak loading (snapshot or time-series max), spare kVA, spare kW at the circuit's PF, and the limiting constraint (thermal or voltage).
- Probe load: a palette item *Probe* (a Load with a `probe: true` flag) that is excluded from the base case and reports, and exists to be dropped on a bus and sized. Right-click → *Find maximum*: binary search on probe kW between 0 and source rating until the first violation; report the limiting element.
- Growth: optional `growthPct` per year and `years` applied to all non-fixed loads for a time-series run, with headroom computed per year.

**Data model (schema bump).** Load gains `probe` (bool). Project gains `growth: { pct, years }`.

**Frontend.** Headroom tab in the bottom panel; probe load with a distinct symbol; *Find maximum* result shown on the bus.

**Report.** *Capacity headroom* table; *Probe* result if any probe loads exist.

**Acceptance.** Probe on a bus behind a 500 kVA transformer at 60 % loading returns ≈ 200 kVA less existing downstream loading, limiting element = that transformer.

### 2.3 Generator and BESS sizing against an island

**Approach.**
- Input: an island (from 1.3, or any downstream set from 1.2), a load shape (daily or yearly), reserve margin %, and whether PV in the island counts.
- Generator sizing: required kW = max of island net load over the shape × (1 + margin); report hours above 80 % and the peak hour.
- Storage sizing: for a chosen generator kW (or none), kWh = max cumulative deficit of (island load − PV − generator) over the shape; kW = max instantaneous deficit. Use the time-series run with `Storage` in *follow* dispatch to verify the chosen size rides through.
- No optimization beyond this; it is a sizing calculator with a verification run.

**Frontend.** Sizing dialog; result inserts a generator and/or storage element sized accordingly (user confirms).

**Report.** *Backup sizing* section with the profile chart and the sizes.

**Acceptance.** Island with a flat 100 kW load, 20 % margin → 120 kW generator; same island with 50 kW PV midday and 8-hour night → storage kWh equals the night deficit.

### 2.4 Equipment duty screening

**Approach.**
- Devices (breaker/switch, fuse, recloser, relay-controlled breaker) gain `interruptingKA` and optional `withstandKA`; busbars gain optional `bracingKA`.
- Using the existing Fault overlay results (3φ and 1φ bolted fault at each bus), compare the fault current at the device's bus to its rating. Pass if rating ≥ fault × `dutyMargin` (default 1.0; user can set 1.1).
- Optional asymmetry factor: user enters a global multiplier (e.g. 1.25) with a note; no X/R-based correction is computed. State in the UI and report that this is a screening check, not an ANSI C37 or IEC 60909 duty study.

**Data model (schema bump).** Rating fields above.

**Frontend.** Duty overlay: devices coloured pass/fail/unrated; tooltip shows fault, rating, margin. Spreadsheet view: ratings columns.

**Report.** *Equipment duty screening* table with the disclaimer paragraph.

**Acceptance.** Device with 10 kA rating at a bus with 12 kA fault → fail; 8 kA fault → pass; unrated → grey and listed.

### 2.5 Interactive TCC plot

**Approach.**
- Fuses, reclosers and relays already carry `TCC_Curve` references. Render a log-log time-current plot (SVG, in-house component; no new charting dependency) for a selected set of devices, with the 3φ and 1φ fault current tick marks from the Fault study and the existing coordination check results annotated (margin at the fault current, pass/fail).
- Device selection: click a device → *Plot TCC* adds it and every protective device upstream to the plot.
- Editing: changing a device's curve or pickup in the properties panel re-renders. No drag-to-adjust in this milestone.
- Curves library: ship OpenDSS's built-in curves plus the generic ANSI/IEC relay curve families as `TCC_Curve` definitions. No manufacturer curves.

**Report.** TCC plot image for each device set the user saved.

**Acceptance.** Plot of the feeder-head relay and a lateral fuse on the demo feeder shows the 0.25 s margin at the 3φ fault tick; plot updates when the fuse is swapped for a larger size.

---

## 3. Milestone C — Data in, results out (Tier 3)

**Goal:** get a real base model into the tool in an afternoon, locate it on a map, connect it to measured data, and produce the deliverable directly.

Suggested order: 3.1 → 3.4 → 3.2 → 3.3 → 3.5.

### 3.1 SKM PowerTools and EasyPower import

**Why first.** Most installations' existing distribution models were built for an arc flash study and live in SKM PTW or EasyPower, not CYME. These are the models bases can actually hand over.

**Sources.**
- SKM PTW: component data exported via *Data Exchange* (XML) or per-component CSV reports. Target the XML export; fall back to CSV tables for buses, cables, transformers, utilities, generators, motors, loads, protective devices.
- EasyPower: *Export data to CSV* (one CSV per equipment type).

**Mapping (in `opendss-designer-convert`).**
- Bus → busbar (kV, bracing kA if present).
- Cable → `Line` with impedance from the cable's size, material, conduit, and length. Facility models carry cable *descriptions*, not impedances, so the converter ships a static conductor table (NEC Chapter 9 Table 9 R and X per 1000 ft by size, material, and conduit type; plus a medium-voltage cable table). This is reference data, not a manufacturer library.
- Transformer → 2-winding transformer (kVA, %Z, X/R, connections, taps).
- Utility → `Vsource` with short-circuit MVA and X/R.
- Generator → generator (kW, kV, Xd'' if present).
- Motor / lumped load → Load (kW, PF, phases). Motors as constant-PQ loads with a note; motor contribution to fault is not modeled.
- Breaker / fuse / relay → the matching Designer element, with ratings into the 2.4 fields and curve into the nearest generic `TCC_Curve`.
- Anything unmapped → listed in an import log and skipped; never silently dropped.

**Layout.** Reuse the hierarchical auto-layout from `.dss` import.

**Acceptance.** A sample SKM XML and EasyPower CSV set (anonymized test fixtures) import without error, solve, and the source kW is within 5 % of the originating tool's load flow report. Import log lists every skipped item.

### 3.2 Bus coordinates and map view

**Data model (schema bump).** Busbars and junction buses gain optional `lat`, `lon`. Project gains `map: { underlay?: { dataUri, nw: [lat,lon], se: [lat,lon] }, mode: 'schematic' | 'geographic' }`.

**Import.** CSV of `bus,lat,lon` (or `name,x,y` in a stated projected CRS; convert with a small bundled pyproj-free formula for UTM, or require lat/lon). Shapefile import is out of scope for this milestone; CSV covers what bases can export from GIS.

**Layout.** *Geographic* mode positions nodes by coordinates (Web Mercator projection to canvas units) and draws lines straight between buses; *Schematic* mode is the existing canvas. Positions for both modes are stored so switching does not lose either.

**Underlay.** Optional user-supplied image (base map screenshot, site plan) with two corner coordinates, embedded as a data URI, size-capped (2 MB) with a clear message. No tiles, no network.

**Acceptance.** 13-bus sample with a coordinates CSV lays out geographically; toggling back to schematic restores the hand layout; project round-trips both.

### 3.3 Measured time-series import

**Approach.**
- Import CSV (timestamp, value[, value...]) as a `LoadShape` (OpenDSS `mult` array with `interval` inferred). Shapes are stored in the project JSON, size-capped per shape (e.g. 35,040 points = 1 year at 15 min) and in total.
- Assign a shape to a load, a load group (by tag), or a PV/storage element. Normalize to per-unit of the element's kW or use as absolute kW (user chooses at import).
- Measured-vs-modeled overlay: attach a measured series to a *bus* or *series element* (not just a load); after a time-series run, plot modeled kW/voltage against the measured series and report RMS and max error. This is the drift-check hook for the digital-twin work.

**Data model (schema bump).** `loadShapes: { id: { name, interval, unit, points } }`; element `loadShapeId`; `measurements: [{ elementId, quantity: 'kW'|'V', loadShapeId }]`.

**Frontend.** Shapes tab in the bottom panel; assignment in the properties panel; comparison chart in the time-series results.

**Report.** *Model basis* section lists shapes and their sources; *Validation* section shows measured-vs-modeled error per measurement.

**Acceptance.** Daily CSV at 15 min imports as 96 points; time-series run with the shape assigned reproduces the shape at the load; measurement comparison against the modeled series of the same load reports ~0 error.

### 3.4 Report templates

**Approach.** The study report becomes a composable document: the user selects sections and the order, and the project stores the selection. New sections from Milestones A and B are included. Add:
- Executive summary (auto-generated bullet list: peak load, worst voltage, worst loading, unserved critical load under loss-of-utility, top three contingencies, headroom at key transformers; each line editable).
- Assumptions (load basis from 1.4, modeling notes from 1.3 and 2.4, growth from 2.2).
- Scenario comparison (1.1).
- Abnormal-condition limits used (already exist per project; surface them).
- Appendix: element tables from the spreadsheet view.

**Formats.** PDF and Excel as today; add Markdown export of the same content for pasting into a memo.

**Acceptance.** Report with every section renders on the demo feeder under 10 s; section toggles persist in the project.

### 3.5 Project diff

**Approach.** Load a second project file (or a previous version from browser storage); diff by element ID: added, removed, changed properties, changed connections, changed scenarios. Render as a list and as a canvas overlay (green/red/amber halos). Read-only; no merge.

**Acceptance.** Change one transformer kVA and delete one load → diff lists exactly those two changes.

---

## 4. Sequencing and milestones

| Milestone | Contents | Exit criterion |
|---|---|---|
| **A — Resilience core** | 1.2 trace, 1.1 scenarios, 1.3 islanding, 1.4 allocation | Demo: open utility source on a base-like sample, see islands, unserved critical loads, and a scenario comparison in the PDF. |
| **B — Planning studies** | 2.1 contingency, 2.2 headroom/probe, 2.4 duty, 2.5 TCC, 2.3 sizing | Demo: rank contingencies, size a MILCON load with the probe, show a TCC with the fault tick. |
| **C — Data in, results out** | 3.1 SKM/EasyPower import, 3.4 reports, 3.2 map, 3.3 measured data, 3.5 diff | Demo: import a real (anonymized) SKM model, lay it out on a map, produce the full report. |

Within each milestone, cut a release per feature; keep the roadmap in `FUTURE_IMPROVEMENTS.md` pointing here.

**Schema changes, consolidated.** Milestone A bumps `version` to 2 (see 1.0). `scenarios`, `activeScenario` and `loadShapes` already exist. `map` and `loadShapeId` overlap the existing `geo`/`crs` and `loadshape` param; reconcile them with Tier 3.
- Project: `tagVocabulary`, `allocations` (A); `growth`, `measurements`, report section selection (B/C).
- Load: `priority`, `tags`, `building`, `fixed` (A); `probe` (B).
- Generator: `islandMode`, `xdpp`, `fuelHours` (A). Vsource: `kind` (A).
- Devices: `interruptingKA`, `withstandKA`; busbar: `bracingKA`, `lat`, `lon`.

---

## 5. Test strategy

- Backend: every feature adds `pytest` cases against the existing samples (demo substation, radial feeder with PV/storage, IEEE 13-bus, IEEE 123-bus). Reference values for power flow stay pinned to EPRI's published solutions.
- Topology features (1.2, 1.3, 2.1) are tested without the engine where possible.
- Import (3.1) gets anonymized fixture files checked into `tests/fixtures/`.
- Frontend: component tests for the scenario store (override application, undo across switches) and the trace functions; one end-to-end smoke test per milestone using the hosted demo build.
- Performance budget: snapshot solve on the 123-bus stays under 1 s; contingency sweep on the 123-bus under 10 s; report generation under 10 s.

---

## 6. Explicit non-goals

Not in this plan, and not planned:
- Arc flash / incident energy, NFPA 70E labels.
- ANSI C37 / IEC 60909 duty studies, motor contribution, AC decay.
- Manufacturer device libraries or drag-to-adjust TCC settings.
- Automatic equipment sizing, panel schedules, Revit/BIM.
- Harmonics, motor starting, dynamic stability (OpenDSS supports some of these; exposure can be revisited after Milestone C).
- Multi-user accounts, server-side project storage, job history.
- Online basemaps or any runtime network dependency.

---

## 7. Open questions to settle before Milestone A

1. **Isochronous model default.** *Still open.* Settle it with the 1.0 spike. `Xd'' = 0.15 pu` default and `Vsource` compilation — confirm against a measured island case if one is available from the sensor work.
2. **Priority enum vs. free tags.** *Decided 2026-11-20:* a separate `priority` enum (critical / essential / nonessential / unassigned) plus free tags, independent of `class`.
3. **Allocation storage.** *Decided 2026-11-20:* the factor is stored and applied at compile time. The export writes the scaled values with a comment, and *Bake* is explicit.
4. **SKM export format.** Confirm which SKM export (XML via Data Exchange, or CSV reports) the target bases can actually produce without an extra module license; build the importer for that one first.
5. **Shape size caps** for 3.3 against the 16 MB-class project files the browser save path can handle.
6. **Runtime network features.** `core/nrel.py` and the irradiance module download data at runtime, which conflicts with the no-network constraint. *Deferred 2026-11-20* to Iron Bank hardening, after Milestone A.
