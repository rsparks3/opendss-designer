# Solving & analysis

Every solve runs through [OpenDSSDirect.py](https://github.com/dss-extensions/OpenDSSDirect.py)
— the actual OpenDSS engine, not a reimplementation — and the model is rebuilt
from the diagram on every run, so results can never drift from what you drew.

## Live validation

The model is checked continuously as you draw: unconnected terminals, missing
source, islanded sections, duplicate names, kV mismatches across connections,
and loadshape problems (a reference to a shape that doesn't exist is an
error; a load following an irradiance shape — or a PV system following a load
shape — is a warning). Problems halo the offending element with a tooltip,
and errors disable solving — if Solve is clickable, the circuit is
well-formed.

## Analysis modes

The toolbar has two analysis modes:

- **Snapshot** — solve the circuit at a single operating point, on demand
  (**Solve**) or automatically after every edit (**Auto**).
- **Time series** — simulate a day or a year and scrub through the results;
  see [Time-series analysis](timeseries.md). In this mode the Solve/Auto
  buttons are disabled — the transport bar owns solving.

!!! note "What a snapshot solves"
    A snapshot is the unscaled **base case**: loads at their full rated kW,
    PV systems at their base irradiance parameter, storage idle. Loadshapes
    are *not* applied — they only take effect in time-series runs. The status
    bar says so whenever shapes are assigned.

## Result overlays

After a solve, results land directly on the diagram. The **Overlay** buttons
choose what's shown:

- **Voltages** — per-unit voltage badges at every bus (undervoltage < 0.95 pu
  blue, overvoltage > 1.05 pu red)
- **Loading** — pie charts and percentages on lines, transformers, and
  breakers, colored by severity; overloads (≥ 100 %) in red
- **Power** — kW/kvar labels on series elements
- **Fault** — see below

Hovering any element shows a detail tooltip: per-phase voltage magnitude and
angle at each connected bus, per-phase currents, power, and loading against
the rating. Results dim when the circuit has changed since they were computed
(and note *stale — re-solve* in the status bar).

## Fault study

Selecting the **Fault** overlay runs a short-circuit study
(`mode=faultstudy`) the first time it's needed; any circuit edit invalidates
it. Busbars get prospective 3φ fault-current badges (kA), and the hover
tooltip adds the 1φ fault current, short-circuit MVA, and the Thévenin
impedances Z₁ / Z₀ at that bus. Source short-circuit strength (`mvasc3` /
`mvasc1`) is what anchors these numbers. Storage elements are disabled for
the study (engine limitation; their inverter fault contribution is
negligible).

## Losses

The **Losses** tab breaks total losses down per series element (lines and
transformers) with each element's share of the total, sortable. Shunt
elements deliberately report none — OpenDSS attributes their power exchange
as injection, not network loss.

## Graphs

The **Graph** tab plots solved quantities in the classic OpenDSS plot style —
per-phase traces in black/red/blue, bold red 0.95/1.05 pu limit lines, a
framed white plot area — with zoom buttons, drag-pan, ++shift++-drag zoom
box, and wheel zoom. In **Snapshot** mode, pick any Y quantity (per-phase or
min/max bus voltage, element P/Q/current/loading/losses) against distance
from the source or bus voltage; the default is a feeder voltage profile.
**Time** mode plots the last time-series run — see
[Time-series analysis](timeseries.md#the-time-graph).

The plot panel is resizable by its corner grip, and the whole bottom panel by
its top edge.
