# Shapes & profiles

Time-series behavior is driven by **shapes**: named multiplier curves stored
with the circuit and managed in the **Shapes** tab of the bottom panel. They
compile to OpenDSS `LoadShape` objects and are saved inside your
`.oneline.json` project (and exported inline in `.dss` files).

The library has two kinds, in two sub-tabs:

- **Load shapes** — demand multipliers. Assignable to loads (scales the rated
  kW each step) and to storage dispatch in `follow` mode (positive =
  discharge, negative = charge).
- **Irradiance shapes** — solar multipliers. Assignable to PV systems, where
  they scale the base irradiance parameter each step.

Element dropdowns are filtered accordingly — loads see load shapes, PV
systems see irradiance shapes, storage may follow either. Assigning the wrong
kind (possible via imports) raises a validation warning, and referencing a
shape that doesn't exist is an error.

A shape's points can be at 60- or 15-minute intervals. The same shape drives
both daily and yearly runs: a 24-point daily shape repeats across a year, and
a full-year shape is read from its start in a daily run. OpenDSS interpolates
between points when the run's step size is finer than the shape's interval.

## Creating and editing shapes

**New** creates a flat 24-point shape in the current tab; **Duplicate**,
**Delete**, and inline rename work as expected — deleting or renaming a shape
updates or clears every element that references it.

- **CSV paste** — paste values into the text area and load them: one value
  per line, or comma/semicolon/whitespace-separated, or two-column
  `time,value` rows (a monotonically increasing first column is treated as a
  time axis and dropped). A single header row and `#` comment lines are
  tolerated.
- **Curve editor** — shapes up to 96 points (a 15-minute day) get draggable
  point handles on the preview chart; each drag is one undo step. Larger
  shapes show a read-only preview and are edited via CSV.
- **Normalize** — scale the shape so its peak is 1.0, or its average is 1.0.
- **Interval** — 60 or 15 minutes per point.

## NREL/NLR building load profiles

**Import from NREL…** (under *Load shapes*) pulls real building-stock demand
curves from the [End-Use Load Profiles for the U.S. Building Stock](https://data.openei.org/submissions/4520)
dataset — simulated against actual 2018 weather:

- **Sector & building type** — 5 residential (ResStock) and 14 commercial
  (ComStock) types, from single-family detached to hospitals and warehouses.
- **Climate zone** — ASHRAE/IECC zones (1A–7B residential, through 8
  commercial); pick the one covering your service territory.
- **Resolution** — hourly (8,760 points, the default) or native 15-minute
  (35,040 points).
- **Normalize** — *peak = 1.0* means the load's kW rating is its peak demand;
  *average = 1.0* means the kW rating is its average demand (peaks will
  exceed the rating). Peak-normalized is the conventional choice.

The first fetch of a given zone/type downloads a 10–30 MB CSV from the public
dataset (no account needed); it's cached on disk after that, so subsequent
imports are instant.

## NSRDB irradiance

**Fetch NSRDB irradiance…** (under *Irradiance*) pulls hourly global
horizontal irradiance for any location in the Americas from the NLR National
Solar Radiation Database — deliberately for weather year **2018**, the same
year the building load profiles were simulated against, so PV output stays
physically correlated with demand in yearly runs (the same cold snap, the
same cloudy week).

- **Location** — type a place name and search, or enter latitude/longitude
  directly.
- **Scaling** — *kW/m² (÷1000)* keeps the shape in physical units: leave the
  PV system's irradiance parameter at 1.0 and the shape peaks around 0.7–1.0
  depending on climate (recommended). *peak = 1.0* normalizes the shape and
  the import message tells you what to set the irradiance parameter to
  instead.

!!! info "NLR API key"
    The NSRDB requires a free API key from the
    [NLR Developer Network](https://developer.nlr.gov/signup/) (takes a
    minute). The app prompts for the key and a contact email on the first
    fetch and remembers them in your browser only; they are sent to the NLR
    API per request and never stored server-side. Fetched data is cached on
    disk per location.

## Under the hood

Shapes are emitted before any element that references them, as
`new loadshape.<name> …` commands. Small shapes are inline; shapes over 288
points are passed to the engine as CSV side files (very long inline commands
destabilize the DSS parser), while `.dss` **exports always inline everything**
so an exported file stays a single portable script.
