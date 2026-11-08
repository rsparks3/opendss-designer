# Distribution planning audit — 2026-11-08

What OpenDSS Designer would need to be the tool a distribution planning
group actually produces its studies with, measured against what those groups
are asked for and what Synergi, CYME and WindMil ship. The roadmap
(`FUTURE_IMPROVEMENTS.md`, M12 onward) was rewritten from this audit; this
file keeps the reasoning so the roadmap can stay terse.

Reviewed: the docs (`docs/`), the engine and compiler
(`src/opendss_designer/core/`), the element field definitions
(`frontend/src/lib/fields.tsx`), the API (`api/routes.py`), the hosted plan
limits, and the roadmap as of 0.8.0 plus the unreleased DSS-view work.

## 1. Where it stands

The honest summary: the **modelling and presentation layer is further along
than the study layer**. A planner can open a real feeder (10,000 elements in
seconds, CYME/Synergi via the converter, GIS layers, `.dss` with redirects),
see it on a one-line and a map, edit it in a spreadsheet, and hand a
colleague a PDF. The studies available are the ones that fall straight out of
a single OpenDSS solve:

| Have | Notes |
| --- | --- |
| Unbalanced snapshot power flow | Per-phase voltages, loading, losses, overlays, abnormal-condition report against project limits |
| Daily / yearly QSTS | Loads, PV, storage with shapes; everything recorded; envelope display over 2,000 steps |
| Fault study | Bolted 3φ and 1φ at every bus from `mode=faultstudy`; Z1/Z0; no other fault types, no fault along a line, no DER contribution |
| Protection | TCC plot, fuse/recloser/relay coordination (0.25 s, 75 % fuse rule), interrupting duty, user curves |
| Reliability | SAIFI/SAIDI/CAIDI from EnergyMeter sections |
| Regulators | `RegControl` with setpoint, band, PT, CT, LDC R/X |
| Report | PDF + Excel with the above; validation against the IEEE feeders and EPRI's large circuits |
| Data in | `.dss`, shapefile/GeoJSON/CSV, CYME, Synergi (plugin), NLR load and irradiance profiles |

What a planner will notice is missing on day one, before any "study"
feature:

- **No load level other than rated.** A snapshot solves every load at
  100 % of its kW. There is no `loadmult`, no named peak/minimum cases, and
  no seasonal or emergency ratings. Every planning criterion is stated
  against a load condition ("minimum daytime load", "summer peak with the
  emergency rating"), so this blocks hosting capacity, contingency and
  interconnection screening alike.
- **Capacitor and inverter controls are not modelled.** A `CapControl`
  or `InvControl` survives import as a passthrough and runs in the solve,
  but a user cannot draw one. Every US feeder with a switched bank, and
  every interconnection since IEEE 1547-2018, needs these.
- **No comparison.** There is one circuit and one result set at a time.
  Planning is the comparison of a base case with alternatives; without a
  diff the tool can display a study but cannot support a decision.
- **One fault type.** Line-to-line, double-line-to-ground, faults with
  impedance, faults part way along a line, and the fault contribution of
  inverters are all routine in protection and interconnection work.

## 2. The studies, one by one

Each entry: what the study is for, what it needs from the tool, what exists,
and the gap. Priority reflects how often a small or mid-size utility is
obliged to produce the study and how much of the gap is interface work over
engine capability the OpenDSS engine already has.

### 2.1 Hosting capacity / integration capacity analysis (DER) — priority 1

**For:** the kW of DER a bus, section or feeder can take before a criterion
is violated. Required or expected by regulators in California (Rule 21 ICA
maps, updated monthly), New York, Minnesota, Hawaii, Maryland, Illinois and
others; used by every utility to pre-screen interconnection requests.
Small utilities are priced out of it today, which is the opening named in
the Direction section.

**Criteria a credible implementation must evaluate, each switchable and each
reported as the binding constraint:**

| Criterion | Test | Engine support |
| --- | --- | --- |
| Overvoltage | Any bus above the project's upper limit (1.05 pu, or a tighter 1.03/1.04 that some utilities use for DER) | Power flow |
| Voltage deviation / rapid voltage change | ΔV at any bus when the DER trips, above 3 % (IEEE 1547-2018 §4.7; many utilities use 2–3 %) | Two solves, with and without |
| Thermal | Any line, transformer or regulator above its normal (or emergency) rating in either flow direction | Power flow + ratings |
| Reverse power at the regulator / LTC | Flow through a regulating device reverses (a regulator in bidirectional mode behaves differently; many utilities forbid it outright) | Power flow + `RegControl` reversible flag |
| Reverse power at the substation | Feeder-head export above a threshold (0 kW, or a % of minimum load) | Power flow |
| Fault current increase | Fault current at any bus rises above a percentage (10 % in the FERC SGIP screen) or an interrupting rating reaches 87.5 % | Fault study with DER as sources; see 2.9 |
| Protection reach / sympathetic trip | Minimum fault current at a device's end of zone falls below its pickup; a device sees fault current for an adjacent feeder's fault | Fault study |
| Unintentional islanding | DER-to-minimum-load ratio in a protection section above a limit (2/3 or 1:1 are common screens) | Topology + load |
| Control operations | Regulator tap operations or capacitor switches per day above a threshold, from a QSTS run | QSTS with control counters (see 2.4) |

**Load conditions:** minimum daytime load (the one that binds for PV) and
peak. Both come either from a `loadmult` on the rated loads or from an
8760 profile; a utility with AMI uses the measured feeder minimum. The
tool therefore needs **named load levels** (section 2.3) before this study.

**Methods**, in increasing cost and fidelity, and all should eventually be
offered because utilities argue about which is right:

1. **Iterative node-by-node** — place DER at one bus, increase in steps
   (or bisect) until a criterion binds, repeat at every bus. Cost is
   solves × buses × steps; a 3,000-element feeder with 1,000 candidate
   buses and 10 bisection steps is 10,000 solves ≈ 10–20 s on the current
   engine (1–2 ms a solve on ckt5-size, more with controls). Workable.
2. **Sensitivity-based** — one base solve plus one perturbed solve per bus
   gives dV/dP and dI/dP; the voltage- and thermal-limited capacities fall
   out of linear extrapolation and are refined with one or two confirming
   solves. This is the shape of EPRI's DRIVE method and is what makes
   feeder-wide, 8760 hosting capacity affordable.
3. **Time-granular** — run (1) or (2) at each of 24 representative hours
   (or every hour of a year) to give a hosting-capacity profile per bus,
   which is what the California ICA publishes.
4. **Stochastic / distributed** — DER spread across many buses in random
   portfolios (EPRI's original method). Lower priority; utilities report
   it mostly as a check on (1).
5. **Load hosting capacity** — the mirror case for EV charging and
   electrification: how much added load before undervoltage or thermal
   limits bind. California's load ICA and every electrification study
   need it; it is the same loop with the sign reversed and must be in the
   first release.

**Outputs:** a table of bus → kW by criterion with the binding one named; a
colour overlay on the one-line and the map (the map is the deliverable
regulators publish); export of the result as GeoJSON/shapefile/CSV so it
can go onto a utility's public ICA map; a report section with the method,
criteria, load condition and date; and the ability to compare two runs
(before/after a mitigation such as a regulator setting change).

**Validation:** publish the method in `docs/` the way `docs/validation.md`
publishes the power flow, and hold it against a public reference —
EPRI's DRIVE results on the IEEE 123-bus or ckt5 are published in their
reports, and NREL's PRECISE/hosting-capacity papers give numbers on the
same feeders. Without this a utility will not trust the result.

**Gap: entire study.** Engine support is complete; all work is loop design,
the sensitivity method, the UI, the exports, and the validation.

### 2.2 Interconnection screening (IEEE 1547 / FERC SGIP style) — priority 1

**For:** a planner receives a DER application at a point of common
coupling (PCC) and must answer in days. The screens are fixed by tariff:
aggregate DER below 15 % of the line section's annual peak (or 100 % of
minimum daytime load for exporting systems); fault-current contribution
under 10 %; protective devices under 87.5 % of interrupting rating; rapid
voltage change under 3 %; flicker; effective grounding (the X0/X1 and
R0/X1 ratios at the PCC); and, since 1547-2018, the smart-inverter
settings (Category A/B volt-var and volt-watt defaults) the DER must run.

**Needs:** a "place DER here" dialog that runs the whole screen list in one
go, reports pass/fail per screen with the number and the limit, and writes
the standard screening report. It reuses everything in 2.1 at one bus, plus
`InvControl` (2.4), DER fault contribution (2.9), grounding ratios (the
fault study already has Z0 and Z1), and line-section minimum load (2.3).
Utilities would adopt the tool for this alone: the incumbent tools do it
badly and the volume of applications is what overwhelms small utilities.

**Gap:** entire feature; most of its parts are shared with 2.1.

### 2.3 Load levels, scenarios and comparison — priority 1 (foundation)

**For:** every study above and below. A planner's "model" is a feeder plus
several load conditions plus several alternatives, and a study is a
comparison between them.

**Needs:**

- **Named load levels** stored with the project: a global multiplier
  (`set loadmult`), optional per-class or per-load factors, and the
  choice of which rating applies (normal or emergency). Defaults: Peak
  (1.0, normal), Minimum daytime (0.3, normal), Emergency peak (1.0,
  emergency). Snapshot, fault, protection and hosting-capacity runs pick a
  level; the report names it.
- **Seasonal and emergency ratings** on lines (`emergamps`), transformers
  (`emerghkva`) and regulators, imported from `.dss` where present, with
  the loading overlay and abnormal-condition report switchable between
  normal and emergency.
- **Scenario manager**: a project holds a base case and N alternatives as
  element-level deltas (a changed setting, an added bank, an opened tie,
  a new DER), each solvable at any load level. Storing deltas rather than
  copies keeps the autosave and library small and makes a diff view
  trivial. Supersedes the parked "multi-circuit tabs".
- **Compare view**: two results sets side by side or as a difference
  overlay (ΔV in pu, Δloading in %, Δlosses) with a table of what changed,
  sortable by magnitude; a report section "Base vs alternative".
- **Batch runs**: every scenario × every load level in one click with
  progress, reusing the time-series SSE channel; a summary matrix table
  (worst voltage, worst loading, losses, violations) per cell.

**Gap:** `loadmult` is a one-line engine change; everything else is
schema, store and UI, and it is the enabling work for M12.

### 2.4 Volt/VAR control, CVR and smart inverters — priority 2

**For:** setting regulators and capacitors (and now inverters) so the
feeder holds voltage with the fewest operations and losses, and
conservation voltage reduction (CVR) studies that regulators credit as
energy efficiency.

**Needs:**

- **`CapControl` as a parameter set on the capacitor element**: control
  type (voltage, current, kvar, PF, time), monitored element and terminal,
  on/off settings, PT/CT ratios, delay, dead time. Import turns a
  passthrough `CapControl` back into capacitor settings, the way a
  `RegControl` becomes a regulator today.
- **`InvControl` as a parameter set on PV and storage**: volt-var,
  volt-watt, watt-pf, and combined modes with editable XY curves (the
  Curves tab already holds TCC curves; XY curves are the same shape),
  with the IEEE 1547-2018 Category A and B defaults one click away. One
  `InvControl` per group of inverters, as the engine wants it.
- **Regulator additions**: reverse-power mode (`reversible`, `revvreg`,
  `revband`), `cogen` mode, first-house protection; the "reverse" state is
  itself a hosting-capacity criterion.
- **Control operation counters in QSTS**: tap changes per regulator and
  switching operations per bank per run (engine `RegControls.TapNumber`
  or a `Monitor mode=2`), reported as a summary and a time series. This is
  the third most common hosting-capacity criterion and the main measure of
  a Volt/VAR scheme's wear.
- **Setting sweeps**: run a grid of setpoint × bandwidth (or an LDC R/X
  grid) over a day or a year and tabulate losses, voltage range, operations
  and violations; the planner picks a row.
- **CVR evaluation**: a paired run at normal and reduced setpoint with
  loads on model 4/8 (CVR factors are already in the load panel), reporting
  energy saved, CVR factor, and the lowest customer voltage.
- **Capacitor placement** (later): rank candidate buses by loss reduction
  and voltage improvement for a given bank size; a greedy search over the
  sensitivity of 2.1 is enough for a first version.

**Gap:** controls are modelling + import/export; sweeps and CVR are batch
UI over existing solves; placement is a small optimisation.

### 2.5 Contingency, switching and restoration — priority 2

**For:** "if this feeder segment or substation transformer is lost, can the
load be picked up by the tie, and what is the worst voltage and loading
while it is?" Capacity planning criteria (N-1 at the substation, feeder
tie capacity) are stated this way, and the result decides whether a
utility builds.

**Needs:**

- **Tie switches** as first-class: a normally-open switch between feeders
  with the two feeders' names, drawn and listed; the circuit already
  imports `enabled=no` ties and has open breakers.
- **Switching operations** as a scripted sequence on a scenario (open X,
  close Y) solved at a chosen load level; the one-line shows the result and
  the energised/de-energised state (the phases walk already knows *unfed*).
- **N-1 enumeration**: for each sectionalising device (or each substation
  transformer or feeder breaker), take it out, close the best tie, solve,
  record worst voltage, worst loading, and unserved load; a ranked table
  and an overlay of which sections can be restored and which cannot.
- **Transfer capability**: for each tie, the kW it can carry at the
  emergency rating before a criterion binds — the same loop as load
  hosting capacity, which is why it follows 2.1.
- **Reconfiguration suggestions** (later): the open-point set that
  minimises losses or balances feeder loading, by branch exchange over
  the tie set.

**Gap:** small modelling (tie attributes), then batch and ranking UI over
existing solves; restoration ranking needs unserved-load accounting, which
the EnergyMeter's EEN/UE registers already compute.

### 2.6 Load forecasting, electrification and the secondary — priority 2

**For:** the capacity plan. A planner needs the feeder at year N under a
growth and adoption scenario, and increasingly the question is at the
service transformer rather than the feeder: EV chargers and heat pumps
cluster, and a 25 kVA transformer with four 11 kW chargers behind it fails
before anything on the primary does.

**Needs:**

- **Growth** per load or per class (`GrowthShape` exists in the engine;
  years as scenarios in 2.3) and a "study year" selector.
- **Adoption scenarios**: assign EV, heat pump or PV adoption rates by
  class or by zone, draw the adopters at random with a seed, attach the
  appropriate shapes (the NLR profile fetch covers buildings; EV charging
  shapes would need another source or user CSV), and run as QSTS. Report
  the distribution of outcomes over several draws.
- **Service transformers and secondaries**: a split-phase 120/240 V
  centre-tapped transformer symbol (the engine's three-winding
  single-phase form, which the three-winding work made possible), the
  secondary conductor as a line, loads at 120/240 V; a **transformer load
  management** table (every service transformer's peak loading, hours over
  rating, estimated loss of life per IEEE C57.91) and a secondary voltage
  check against 114 V (ANSI Range A) at the meter.
- **Distributed load along a section**: CYME and Synergi both model load
  spread along a line; OpenDSS does not. The converter and importer should
  split such a line (the split-line tool exists) or place the load at the
  one-third/two-thirds equivalent, and say which.

**Gap:** modelling (split-phase transformer, growth, class attributes),
shape data for EV, a stochastic draw, and the TLM report. All UI over
existing engine features.

### 2.7 Phase balancing — priority 3

**For:** feeder-head current unbalance (and neutral current) drives losses
and regulator problems; the study picks which single-phase laterals to move
to another phase. Phase pinning and the phases overlay already exist, so
this is: unbalance % at the head and at each device (NEMA/IEEE
definitions), a ranked list of candidate laterals with the predicted
unbalance after the swap (one solve per candidate), and a batch "apply"
that re-pins and re-solves.

**Gap:** a loop and a table.

### 2.8 Loss evaluation and capacity (EEN/UE) — priority 3

**For:** annual loss evaluation (technical losses by element class over the
year, with cost at an energy price) and the engine's **capacity** metric —
the energy exceeding normal (EEN) and unserved energy (UE) registers of the
EnergyMeter, and the `Capacity` command that finds the load multiplier at
which the circuit runs out. Losses per element exist for a snapshot; the
yearly loss breakdown by class, the dollar line, and the EEN/UE registers
do not.

**Gap:** small; mostly reading registers and a report section.

### 2.9 Protection depth — priority 2

**For:** the coordination and short-circuit work that the M6 plot started.
What a protection engineer asks for next:

- **Fault types and impedance**: LL, LLG, LG with fault resistance (the
  `Fault` element in a snapshot solve, in addition to `mode=faultstudy`),
  and the **minimum** fault current at each bus, since coordination is
  checked against the minimum and duty against the maximum.
- **Fault anywhere on a line**: a sliding fault at a chosen distance along
  a line (split the line in the compiled model only), and the current seen
  by every upstream device.
- **DER fault contribution**: `mode=faultstudy` is Thevenin only; inverter
  contribution (1.1–1.5× rated current per IEEE 1547/2800 and the
  engine's `PVSystem` fault model) and synchronous generator contribution
  appear only in a snapshot `Fault` solve. Needed by the interconnection
  screen (10 % and 87.5 % tests) and by the reach check.
- **Reach and fuse-saving**: minimum fault at the end of each device's
  zone versus its pickup (the DER case reduces reach); fuse-saving versus
  fuse-blowing scheme evaluation for recloser–fuse pairs (the fast curve
  must clear before the fuse's minimum melt at the maximum fault at the
  fuse, the delayed curve after the fuse's total clear at the minimum
  fault).
- **Sectionalizers** (`Sectionalizer`), recloser sequence and reclose
  intervals, and device **ratings** (continuous and interrupting on fuses
  and reclosers, not only breakers).
- **Settings export**: a settings table per device in the report in the
  form a relay technician reads (pickup in primary amps and in multiples,
  curve, time dial, instantaneous).

**Gap:** engine supports all of it; work is the compiled-model surgery
(sliding fault, `Fault` elements), two more study loops, and UI.

### 2.10 Reliability depth — priority 3

**For:** beyond SAIFI/SAIDI/CAIDI: **MAIFI** (momentary, from recloser
fast operations and the engine's `pctperm`), **ASAI**, **CEMI/CELID**
(customers experiencing N interruptions), load-weighted indices (ASIFI),
and the **what-if** that justifies spending: "place a recloser here, or
automate this switch, and SAIDI falls by X". The engine's reliability
calculation already gives the per-section numbers; the what-if is the
scenario manager (2.3) plus a loop over candidate device locations, ranked
by ΔSAIDI per device. Outage cost (customer interruption cost by class) is a
small table on top.

**Gap:** formulas on existing output plus a placement loop.

### 2.11 Power quality — priority 4

**For:** harmonic penetration with inverter-heavy feeders (`mode=harmonics`
with `Spectrum` objects, THD per bus against IEEE 519), **voltage
unbalance** % at every three-phase bus (a one-line formula on the existing
per-phase voltages; add it now, it is a column), and **flicker**/rapid
voltage change from motor starting or PV cloud transients (ΔV from a pair
of solves, against IEEE 1453 / 1547 §4.7). Harmonics is a real study
utilities buy CYME modules for, but it comes after the planning studies
and needs spectra data users rarely have.

**Gap:** unbalance is trivial; ΔV is covered by 2.1's trip test;
harmonics is a mode, a spectrum library and a report.

### 2.12 Model building, data quality and libraries — priority 2

**For:** a model a planner will sign. What professionals expect:

- **Equipment libraries**: conductors (`WireData`, `CNData`, `TSData`) and
  pole/trench configurations (`LineGeometry`) editable in the app and
  shared across projects, with a starter library of standard ACSR/AAC
  conductors and common cables; standard transformer and regulator
  catalogue entries (impedance, losses, ratings) so a unit is picked, not
  typed. Today only the computed matrix of a geometry survives import.
- **Imperial and metric**: lengths in ft/mi/m/km already; conductor and
  geometry entries need the same, and the report should print in the
  project's unit system throughout.
- **Model QA report**: a one-click check beyond the live validation —
  missing ratings and impedances, lengths outside plausible bounds for the
  voltage class, loads with no customers or no kV, voltage bases not
  matching any transformer winding, loops in a radial feeder, open points
  with no tie, phasing conflicts, orphan passthrough references — with a
  completeness score per element class and an export to CSV. Incumbents
  call this model validation; it is the first thing a utility runs on a
  converted model.
- **Load classes** (residential/commercial/industrial, or the utility's
  own) as an attribute used by allocation (2.13), adoption scenarios (2.6)
  and reports.
- **Audit trail**: who changed what and when, at element level, saved with
  the project and printable. Required where a study supports a regulatory
  filing. Pairs with the scenario deltas of 2.3.

**Gap:** libraries are schema + editors + import/export; the QA report is a
rule set over the model; classes and the audit trail are schema and UI.

### 2.13 Load allocation and model calibration (roadmap M15) — priority 2

**For:** a model that matches the feeder-head SCADA and the customers'
billing. Without it every voltage and loading number is an estimate on top
of nameplate.

**Needs:** import billing kWh (or AMI interval kW) per customer or per
service transformer by a key (transformer ID, meter ID, or coordinates);
convert kWh to kW by class load factor or by the class profile; run the
engine's `AllocateLoads` against feeder-head measurements (`Sensor` or
`EnergyMeter peakcurrent`) to scale to the metered peak; report the
allocation and the mismatch to SCADA; and for AMI, build the loadshapes
directly from the intervals. The engine side exists; the work is the data
pipeline, the key matching UI (the GIS mapping dialog is the pattern), and
the validation report.

### 2.14 Interoperability — priority 2

- **CIM** (IEC 61968-13 CDPSM / CIM100 RDF/XML): the exchange format large
  utilities and both Synergi and CYME support; import first, export after.
  NLR's grid-data-models fork already underlying the converter has a CIM
  reader to build on.
- **MultiSpeak**: the co-op standard WindMil and most co-op GIS/CIS speak;
  the route to the WindMil market without reverse-engineering WindMil
  files.
- **WindMil reader** (already noted in M11), **ETAP/SKM** (noted, blocked
  on samples).
- **Results export to GIS**: every study result as GeoJSON/shapefile/CSV
  keyed by element, so hosting-capacity maps, voltage and loading can be
  published in the utility's GIS; KML for Google Earth.
- **Python API and CLI** (roadmap M17): `opendss_designer.studies` with the loops
  above callable headless on a saved project, a `opendss-designer run
  <project> --study hosting-capacity` command, and OpenAPI docs for the
  REST surface. This is also how the desktop app and the browser app share
  one implementation (section 3).

### 2.15 Compute and job architecture — requirement, not a feature

The studies in 2.1, 2.4, 2.5 and 2.6 are thousands of solves, not one.
Today every API call is one synchronous solve or one SSE stream on a
single engine thread, with hosted plans capped at 90–600 s per run and a
monthly engine budget. Consequences:

- **Background jobs with persisted results** are needed on the server side
  (local and hosted): submit, poll or stream progress, cancel, fetch the
  result later, keep the last N. The time-series SSE path is the template.
- **Parallel engines**: DSS-Extensions supports independent engine
  instances in one process (`dss.NewContext()`), which lets a hosting
  capacity run fan out across cores while keeping the single-call-per-
  engine discipline the crash history taught. Measure first; the engine
  thread rule in `engine.on_engine_thread` becomes one thread per context.
- **Hosted plans**: a 3,000-element feeder's node-by-node hosting capacity
  at two load levels is about 20,000 solves, well inside a Pro run at
  1–2 ms each but far outside Free and Anonymous. The plan table needs a
  "study" cost unit alongside the time-series cost, and the sensitivity
  method (2.1 method 2) is what makes 8760 variants affordable at all.
- **Determinism**: a study report must record engine version, method,
  criteria, load level and scenario so that it can be reproduced; the
  report's title page already carries versions and criteria.

## 3. Two apps, one study library

The desktop rewrite (`opendss-designer-desktop`, PySide6) reached parity
with the browser 0.8.0 on 2026-11-07 by re-implementing the engine layer in
its own package. Every study above would then be written twice. Before M12
starts, the study loops (hosting capacity, screening, sweeps, N-1,
allocation) should live in **one Python package the two apps import** —
either `opendss_designer.core` published as a library the desktop depends
on, or a new `opendss-designer-studies` package both depend on — with the
compiled circuit as its input and plain dicts as output. The browser app
calls it through FastAPI, the desktop in-process. This is the single most
important architectural decision for the next year of work.

## 4. What a professional will also expect

Not studies, but the things that decide whether a tool is allowed into a
utility:

- **Methodology documents** per study in `docs/` (criteria, equations,
  engine modes, known limits), each with a validation page against a public
  reference, as `docs/validation.md` does for power flow.
- **Results tables everywhere** with filter, sort, CSV export and
  pin-to-report, not only in the PDF. Planners live in tables.
- **Multi-project and versioning**: open two projects, compare, keep
  history. The library is single-circuit today.
- **Printing at scale**: a 10,000-element one-line on an E-size sheet, in
  tiles, with a key map.
- **Accessibility of large results on the map**: hosting capacity and
  contingency results are consumed on the map, so the map needs result
  legends, click-to-table and layer export.
- **Support posture**: a published issue tracker response norm, a
  changelog that names breaking schema changes, a migration path for
  saved projects (schema versioning exists), and long-term support of the
  engine version the validation page was run with.

## 5. Recommended order

1. **Foundation (2.3 + the two control elements of 2.4 + `emergamps`)**:
   load levels, emergency ratings, scenario deltas, compare view, batch;
   `CapControl` and `InvControl` as element parameters. Nothing else is
   credible without them, and each is useful alone.
2. **Hosting capacity (2.1) with load hosting capacity**, iterative first,
   sensitivity second, map/GeoJSON export, methodology + validation page.
3. **Interconnection screening (2.2)**, which reuses 2.1 and needs the
   `Fault`-element solve and DER contribution from 2.9.
4. **Contingency and switching (2.5)**, then **Volt/VAR sweeps and CVR
   (2.4)**, both batch UI over existing solves once 2.3 exists.
5. **Model QA, libraries and classes (2.12)**, **secondaries and
   electrification (2.6)**, **load allocation (2.13)**: the model-quality
   track, which runs in parallel with the study track because it is
   mostly schema and import work.
6. **Protection and reliability depth (2.9, 2.10)**, **phase balancing
   (2.7)**, **EEN/UE and loss evaluation (2.8)**.
7. **CIM and MultiSpeak (2.14)**, **harmonics (2.11)**.

The shared study library (section 3) and background jobs (2.15) are
prerequisites of step 2 and should be settled during step 1.
