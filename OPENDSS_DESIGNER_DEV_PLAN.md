# OpenDSS Designer — Facility Planning Development Plan

**Scope:** Tiers 1–3 of the facility-planning roadmap. Turns OpenDSS Designer from a power-flow viewer into a resilience and capacity planning tool for installation-scale distribution systems (military bases, campuses, large industrial sites).

**Baseline:** first drafted against v0.8.0. Tier 1 was reconciled with **v0.9.0** (2026-11-15) on 2026-11-20, and Tier 2 on 2026-11-21. 0.9.0 adds the following:
- load levels, scenarios and Compare;
- N-1 contingency, hosting capacity and the Studies tab;
- allocation from meter data;
- GIS coordinates and the map view;
- the TCC graph.

**Tier 3 has not yet been reconciled.** Several of its items partly exist (3.2 map view, 3.3 shapes). Reconcile each one, as Tiers 1 and 2 were, before starting it.

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

## 1. Milestone A — Resilience core (Tier 1) — ✅ DONE 2026-11-20 (merged to `main`)

Everything below was built as described, except where a *Done differently* or *As built* note says otherwise. The user's guide is `docs/facility.md`, and `frontend/e2e/facility.spec.ts` runs the milestone's exit demo end to end.

**CYME/Synergi class → priority (1.2), as built:** the convert plugin hands this repository `.dss`, so the mapping is applied in the importer. OpenDSS's load `class=` is now read on import. `config/priority_by_class.csv` (shipped empty, so no mapping is assumed), or a `priorityByClass` sent with `/api/import/dss` or `/api/import/convert`, sets the priority of each load whose class it names. A priority the file already states is kept.

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

**Reconciled with the code on 2026-11-21**, as Tier 1 was. Each item says what already exists (the design of record) and lists only the remaining work. Two decisions were made with the user:
- **The probe (2.2) is a right-click action, not an element.** *Find maximum load here* on a bus reuses the hosting-capacity load search for that bus. Nothing is saved in the drawing, so the `probe` flag and its exclusions are dropped. To keep a sized MILCON load, add it as an ordinary load in a scenario.
- **Backup generators are marked `standby`** (2.1, 2.3, and the 1.3 *Utility outage* action). A standby generator starts on loss of utility (an ideal ATS). It runs isochronous only in an island cut off from every utility source, and is off otherwise.

Names follow the code, not the original draft: ratings are lower-case element params (`interruptingka`, as today, so `withstandka` and `bracingka`), and project-wide settings go in `Limits` (`core/model.py`).

**Order:** 2.1 → 2.2 → 2.4 → 2.5 → 2.3. Standby (in 2.1) comes before 2.3, which uses it.

**Schema.** Bump `SCHEMA_VERSION` to 3 with a no-op migration (2→3), once, at the first item that adds a field. New element params need no migration. The new project-level keys (`Limits.dutyMargin`, `Limits.asymmetryFactor`, `tccSets`) touch the backend `Circuit` model.

### 2.1 N-1 contingency sweep — ✅ DONE 2026-11-21

**As built:** `studies/contingency.py` (`_Standby` adds a disabled isochronous `Vsource` per standby unit to the one build and toggles it per case; topology from `core/trace.py` decides which islands lost every source). The preview is the reserved scenario id `__preview` (`lib/scenarios.ts` `PREVIEW_ID`); `withoutPreview` strips it from files, autosave and batch runs, and `listed` hides it from every scenario list. *Return* from a preview goes to the base case, not to the scenario it was opened from. Tests: `tests/test_n1_facility.py`, `lib/contingency.test.ts`, `store/scenarios.store.test.ts`.


**Exists:**
- `studies/contingency.py` `n_minus_1`. It takes out every closed switch and protective device in turn (with `candidates: 'all'`, also every line, transformer and regulator). For each one it reports unserved kW, dark buses, worst voltage and loading, and violations, and finds the tie that restores the most load. Results are ranked by load that can't be restored.
- It runs on the scenario-resolved circuit at the active load level, on one build with `enabled`/`open` edits between solves. It goes through the job queue with progress and cancel (`/api/jobs/n-minus-1`), and `estimate_n1_solves` + `_study_cap` enforce the demo limits.
- Studies tab → Contingency: a ranked table with *locate*. The report's *Planning studies* section prints it.
- **Timing (measured 2026-11-21):** IEEE 123-bus, every element (134 candidates, no ties): **0.21 s**. The 10 s budget is not a concern.

**Remaining:**
- **Unserved kW by priority** for each case and the best tie (critical / essential / nonessential / unassigned). Reuse `islanding.unserved_by_priority`. Rank by remaining unserved *critical*, then by total. *Fix along the way:* `_Net.load_kw` applies `loadmult` but not `classMult`; use `islanding.demand_kw` so N-1 and islanding agree.
- **Losses** for each case, and **islands formed** (count, plus per-island served kW when backup is on).
- **Standby generators (new field).** Generator param `standby` (bool, default false), field "Standby (starts on loss of utility)". Option *Start standby generators*: in each case, a standby unit in an island with no utility source runs isochronous; elsewhere it is off. *Engine approach:* the compiler can't turn a `Generator` into a `Vsource` with an `edit`, so for this run it compiles each standby unit as an isochronous `Vsource`, disabled. Each case enables the ones whose island lost the utility (found with `core/trace.py` topology before the solve), so it stays one build. Per-case output adds generator loading against `kva`; over 100 % is a violation.
- **Same flag in 1.3's *Utility outage* action:** it starts standby generators and in-service generators. If no generator in the file is marked standby, it keeps today's rule (every generator) so older files behave as before. Mark G1 and G2 standby in `installation-campus`.
- **Options:** *transformers only* (a new `candidates: 'transformers'`), and *exclude elements with tag…* (tags on series elements: give series elements the same `tags` field loads have, with the tag-chip field kind from 1.2).
- **Estimate before running:** show `estimate_n1_solves` (and a time from it) next to *Run*. The estimate counts standby cases.
- **Row → canvas:** clicking a row shows that outage as a temporary, unsaved view. Use a transient scenario that isn't stored in `scenarios` and is dropped on the next edit or *Return*. The standard overlays and the Islands overlay apply. *Save as scenario* turns the row into a 1.1 scenario: the element `enabled:false`, plus the best tie closed and standby units started if the row used them.
- **Report:** *Contingency ranking*, top N (default 10, set in the report dialog), with the criteria and options used, unserved by priority, and the best tie.

**Acceptance:**
- IEEE 13-bus, every element: the sweep completes, and each row's unserved kW equals the load in `downstream_set` (1.2) for that element (there are no ties).
- `installation-campus`: opening 52-F1 with standby on: G1 carries its island, critical unserved is 0, and the row reports G1's loading. With standby off, the feeder's critical loads show as unserved.
- Save as scenario, then solve: the result matches the row.
- 123-bus, every element: under 10 s (kept as a regression test).

### 2.2 Capacity headroom report and probe load — ✅ DONE 2026-11-21

**As built:** `studies/headroom.py` (`POST /api/jobs/headroom`), Studies tab → *Headroom* (a study in the Studies tab, beside the others, rather than its own bottom-panel tab). The probe is `lib/headroom.ts` `findMaxLoad` on the hosting-capacity job; the hosting result gained `where` (the bus or element that bound). Vsource gained `kva` (*Service capacity*). The probe result shows as a message and in the session's probe list, not as a callout drawn on the canvas. **Found while building:** OpenDSS rates a transformer at 110 % of nameplate unless told otherwise, and the compiler never told it; it now writes `normhkva` = nameplate (or the element's own). Tests: `tests/test_headroom.py`, `lib/headroom.test.ts`.


**Exists:**
- **Feeder capacity** (`studies/capacity.py` `capacity_search`): bisection on the load multiplier until undervoltage or overload, giving capacity kW, headroom and what binds.
- **Load hosting capacity** (`studies/hosting_capacity.py`, `kind: 'load'`): a constant-power trial load grown at each bus until voltage or thermal limits bind (iterative or sensitivity method). It has a Hosting overlay and a report section. *This is the probe's search.*
- **Growth:** *Add growth levels* (Project → Load levels) turns a rate and years into load levels. Batch runs solve every scenario at every level.
- Element loading against the active level's rating (normal or emergency) is in every solve result.

**Dropped from the original plan:**
- **The `probe` load flag and *Probe* palette item** (decided 2026-11-21, see above).
- **Project `growth: {pct, years}`.** Growth levels already do this, and headroom per year is headroom per level.

**Remaining:**
- **Headroom table** (new `studies/headroom.py`, `POST /api/headroom` or a job if it uses a time series). For every transformer, regulator, line, switch with a rating, and source:
  - rating (kVA, or amps → kVA at the element's kV);
  - peak loading (the snapshot, or the max over the last time-series run when there is one, chosen in the tab);
  - spare kVA, and spare kW at the element's own PF;
  - the limiting constraint: *thermal* (the element) or *voltage* (the lowest bus downstream reaches `vminPu` first). For voltage, take the smaller of the thermal spare and a voltage estimate. Use the hosting-capacity sensitivity (one perturbation at the element's load-side bus) rather than a new search.
  - *Across levels:* one column per load level, so growth years show up directly.
- **Frontend:** a Headroom tab in the bottom panel, sortable, with *locate*, and worst first (least spare).
- **Find maximum load here:** right-click a bus → runs the iterative load hosting search for that one bus (`/api/hosting` with `candidates: [bus]`, `kind: 'load'`, the criteria voltage + thermal). It shows kW/kVA and the limiting element in a result callout on the bus, and in a *Probe results* list in the Headroom tab that is kept for the session, not saved. It runs on the open scenario at the active level, so a MILCON study is: make a scenario, then probe in it.
- **Report:** a *Capacity headroom* table. Session probe results print if there are any, labelled with their scenario and level.

**Acceptance:**
- A probe at a bus behind a 500 kVA transformer loaded to 300 kVA (60 %), with the transformer as the binding constraint, returns ≈ 200 kVA (within the search tolerance), limiting element = that transformer. *(The draft said "200 kVA less existing downstream loading", which counted the existing load twice.)*
- The headroom table's spare kVA for that transformer is also ≈ 200 kVA, *thermal*.
- On a long feeder where voltage binds first, the headroom row says *voltage* and its spare is below the thermal spare. Hold it to a probe at the same bus within 10 %.
- Two growth levels give two columns, and spare shrinks with the level.

### 2.3 Generator and BESS sizing against an island

**Exists:**
- 1.3 islands, `downstream_set` (1.2), and the per-island summary.
- Generator `kva`, `xdpp` and `fuelHours`.
- Time-series runs (daily and yearly) with load, PV and storage shapes, and Storage `dispatch: 'follow'` with a dispatch shape.

**Approach:**
- **Input:**
  - an island, from 1.3 or from any device's downstream set (1.2);
  - a shape: the loads' own shapes over a day or year, or one shape chosen for the whole island;
  - reserve margin %;
  - whether PV in the island counts.
- **Generator sizing:** required kW = max over the shape of island net load (load − PV if counted) × (1 + margin). Report the peak hour, the hours above 80 % of the chosen size, and fuel hours against `fuelHours` if set.
- **Storage sizing,** for a chosen generator kW (or none). The generator runs up to its kW, and storage covers what's left and charges from any surplus:
  - **kWh** = the largest drawdown of the running sum of (generator + PV − load) over the shape (largest peak-to-trough), divided by round-trip efficiency;
  - **kW** = the largest instantaneous deficit, or the largest surplus if that's bigger.
  - **The cycle must close.** If the shape's total energy is negative, the island can't be sustained, and the result says so ("storage empties after N days"). It doesn't report a size that only works once.
- **PV surplus with no load to absorb it:** in the engine, an isochronous generator is a `Vsource` and would absorb it silently. A real generator can't, so the sizing flags those hours as *reverse power at the generator: PV curtailment or storage needed*.
- **Verification run:** insert the sizes into a temporary scenario of the island (utility out, standby started), set storage to `follow` with the computed dispatch shape, and run the time series. Pass when SOC stays above the reserve and generator loading stays ≤ 100 % of `kva` with no reverse power at any step.
- No optimization; it is a sizing calculator with a verification run.

**Frontend:** a sizing dialog (right-click a device → *Size backup for downstream…*, or from an island card). The result inserts the generator (`standby: true`) and/or storage in a new scenario after the user confirms.

**Report:** a *Backup sizing* section with the profile chart (net load, generator, storage SOC), the sizes, the verification result and the modelling notes.

**Acceptance:**
- Flat 100 kW island, 20 % margin → 120 kW generator.
- Flat 100 kW load, 60 kW generator, PV 50 kW from hours 8–16 and 0 otherwise:
  - the running deficit is 40 kW for 16 hours, with a 10 kW surplus for 8 hours;
  - kWh ≈ 640 / η, kW = 40;
  - the day's energy is −560 kWh, so the result says the cycle doesn't close.
- Same case with a 100 kW generator: the cycle closes and the verification run passes.
- PV larger than the island load with no storage: the reverse-power hours are flagged.

### 2.4 Equipment duty screening — ✅ DONE 2026-11-21

**As built:** `studies/duty.py` (`POST /api/duty`, one `engine.fault_study` solve, the Fault overlay's). A device is judged on the larger fault at *either* terminal. The status is per element (fail if any check fails; unrated when the interrupting/bracing rating is missing). `Limits.asymmetryFactor` has no free-text note: the report states the factor and that it was entered, not computed. UI: the Duty overlay (badges, legend with counts and disclaimer), Studies → Equipment duty, the report section *Equipment duty screening* (which replaces Protection's interrupting-duty table when both are chosen). Tests: `tests/test_duty.py`, `lib/duty.test.ts`.


**Exists:**
- `interruptingka` on breaker, fuse, recloser and relay.
- The *interrupting-duty* warning in `core/protection.py` (`_read_switches` / `_coordination_issues`), checked against the **3φ** fault at the device's load-side bus.
- The Protection panel's "Switches with no curve" table, the report's interrupting-duty lines, and Model QA flagging a missing `interruptingka`.
- Hosting capacity's analytic *interrupting* criterion.

**Remaining:**
- **Fields:** `withstandka` (optional) on the same devices; `bracingka` (optional) on busbars, columns in the spreadsheet.
- **Fault current used:** the larger of the 3φ and 1φ bolted fault (1φ can be higher near a grounded-wye transformer). Today only 3φ is used; fix the existing warning to match.
- **Margin and asymmetry:** `Limits.dutyMargin` (default 1.0) and `Limits.asymmetryFactor` (default 1.0, with a note field), in Project → Limits. Pass when rating ≥ fault × asymmetry × margin. No X/R correction.
- **A study, not just a warning:** `studies/duty.py` (or an extension of `tcc_study`) returns a row per rated or unrated device and busbar: fault, rating, ratio and pass / fail / unrated. It reuses the same `mode=faultstudy` solve as the Fault overlay.
- **Duty overlay:** devices and busbars coloured pass / fail / unrated (grey); the tooltip shows fault, rating and margin.
- **Honest labeling:** the overlay legend, the table and the report say: *screening check, not an ANSI C37 or IEC 60909 duty study; no motor contribution, no AC/DC decay.*

**Report:** an *Equipment duty screening* table with the disclaimer. It replaces the interrupting-duty lines in *Protection* (keep one line there pointing to it).

**Acceptance:**
- A 10 kA device at a 12 kA bus fails; at 8 kA it passes; an unrated device is grey and listed.
- A device where 1φ > 3φ is judged on the 1φ value.
- `dutyMargin` 1.1 turns a 9.5 kA fault on a 10 kA device into a fail.
- The existing protection tests still pass.

### 2.5 Interactive TCC plot

**Exists:**
- `POST /api/tcc` (`tcc_study`) and Graph tab → Protection (`TccGraphPanel`): an in-house log-log SVG with every protective device. It draws a 3φ fault line per device, recloser fast/delayed curves, dashed ground curves and dotted extrapolation, and toggles devices from the legend.
- Coordination checks: a 0.25 s margin, the fuse-pair melt ratio, phase against 3φ and ground against 1φ.
- Curves: the ten engine built-ins (`a`, `d`, `tlink`, `klink`, `mod_inv`, `very_inv`, `ext_inv`, `definite`, …) plus user curves from the Curves tab. The report has one TCC plot of every device.
- Re-plotting is a button, because it costs a fault-study solve.

**Remaining:**
- **Device sets:** right-click a device → *Plot TCC* plots it and every protective device upstream of it (`_upstream_chain`). It replaces the all-devices view; *All devices* stays as an option. A set can be saved by name in the project's `tccSets: [{ id, name, deviceIds }]` (a project-level key).
- **Annotations:** a 1φ fault line (dashed) next to the 3φ one. At each fault line, show each pair's time margin and pass/fail from the coordination check, marked on the plot.
- **Re-render without a solve:** a change to curve, pickup, time dial or fuse rating re-plots straight away. The curves are scaled on the client (`lib/tcc.ts` already computes operating times), and the fault lines don't change. Only a change to topology or impedance marks the fault lines stale.
- **Generic curve families:** add IEC 60255 standard, very, extremely and long-time inverse, and IEEE C37.112 short-time inverse (the three IEEE moderately/very/extremely inverse curves are built in). Ship them as `TCC_Curve` points from the published formulas, in a read-only *Generic* group in the Curves tab. These are formula curves, not manufacturer data, so the roadmap's "no curve library" decision still holds.
- **Fault tick ↔ Fault overlay:** they already come from the same solve; add a test that keeps it that way.

**Report:** one TCC plot per saved set, titled with the set name. If there are no saved sets, the all-devices plot is printed as today.

**Acceptance:**
- `installation-campus`, after it gains a feeder-head **relay** on 52-F1 (none of the samples has a relay or recloser yet): *Plot TCC* on F-CLINIC shows the fuse and the relay. The 3φ fault line is annotated with their margin, and it is at least 0.25 s.
- Raising F-CLINIC from 65 A to a larger link re-plots without a solve, and the annotated margin changes.
- A saved set survives save → load and prints in the report.

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
| **B — Planning studies** | 2.1 contingency, 2.2 headroom/probe, 2.4 duty, 2.5 TCC, 2.3 sizing | Demo on `installation-campus`: rank contingencies with standby generators, probe a MILCON load in a scenario, show the duty overlay and a saved TCC set with its fault tick and margin, size backup for a critical feeder, and all of it in the PDF. Run it end to end as `frontend/e2e/planning.spec.ts`. |
| **C — Data in, results out** | 3.1 SKM/EasyPower import, 3.4 reports, 3.2 map, 3.3 measured data, 3.5 diff | Demo: import a real (anonymized) SKM model, lay it out on a map, produce the full report. |

Within each milestone, cut a release per feature; keep the roadmap in `FUTURE_IMPROVEMENTS.md` pointing here.

**Schema changes, consolidated.** Milestone A bumps `version` to 2 (see 1.0); Milestone B bumps it to 3 (see §2). `scenarios`, `activeScenario` and `loadShapes` already exist. `map` and `loadShapeId` overlap the existing `geo`/`crs` and `loadshape` param; reconcile them with Tier 3.
- Project: `tagVocabulary`, `allocations` (A); `Limits.dutyMargin`, `Limits.asymmetryFactor`, `tccSets` (B); `measurements`, report section selection (C). *(`growth` dropped: growth load levels exist.)*
- Load: `priority`, `tags`, `building`, `fixed` (A). *(`probe` dropped: the probe is a right-click action.)*
- Series elements (lines, transformers, regulators, switches, protective devices): `tags` (B, for N-1 exclusion).
- Generator: `islandMode`, `xdpp`, `fuelHours` (A); `standby` (B). Vsource: `kind` (A).
- Devices: `interruptingka` (exists), `withstandka` (B); busbar: `bracingka` (B); `lat`, `lon` (C).

---

## 5. Test strategy

- Backend: every feature adds `pytest` cases against the existing samples (demo substation, radial feeder with PV/storage, IEEE 13-bus, IEEE 123-bus). Reference values for power flow stay pinned to EPRI's published solutions.
- Topology features (1.2, 1.3, 2.1) are tested without the engine where possible.
- Import (3.1) gets anonymized fixture files checked into `tests/fixtures/`.
- Frontend: component tests for the scenario store (override application; undo within a scenario) and the trace functions; one end-to-end smoke test per milestone using the hosted demo build.
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

## 7. Open questions

1. **Isochronous model default.** *Still open.* Settle it with the 1.0 spike. `Xd'' = 0.15 pu` default and `Vsource` compilation — confirm against a measured island case if one is available from the sensor work.
2. **Priority enum vs. free tags.** *Decided 2026-11-20:* a separate `priority` enum (critical / essential / nonessential / unassigned) plus free tags, independent of `class`.
3. **Allocation storage.** *Decided 2026-11-20:* the factor is stored and applied at compile time. The export writes the scaled values with a comment, and *Bake* is explicit.
4. **SKM export format.** Confirm which SKM export (XML via Data Exchange, or CSV reports) the target bases can actually produce without an extra module license; build the importer for that one first.
5. **Shape size caps** for 3.3 against the 16 MB-class project files the browser save path can handle.
6. **Runtime network features.** `core/nrel.py` and the irradiance module download data at runtime, which conflicts with the no-network constraint. *Deferred 2026-11-20* to Iron Bank hardening, after Milestone A.
7. **Standby generators in N-1 and outages.** *Decided 2026-11-21:* a generator `standby` flag (an ideal ATS), used by N-1, *Utility outage* and sizing. Files with no standby unit keep the old outage rule.
8. **Probe load.** *Decided 2026-11-21:* a right-click *Find maximum load here* on a bus, reusing the hosting-capacity load search. It is not a saved element.
