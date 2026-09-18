---
description: Snapshot power flow, voltage and loading overlays, fault-current study, losses breakdown and voltage-profile graphs in OpenDSS Designer.
---

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
  blue, overvoltage > 1.05 pu red). The badge reads the lowest phase; on a
  single-phase lateral or an unbalanced three-phase bus it also names that
  phase, so `0.962 pu B` is the B-phase voltage and a balanced bus stays
  unlabelled
- **Loading** — pie charts and percentages on lines, transformers, and
  breakers, colored by severity; overloads (≥ 100 %) in red
- **Power** — kW/kvar labels on series elements
- **Fault** — see below
- **Phases** — the one view that needs no solve: lines and symbols (loads,
  breakers, fuses, transformers and the rest) are coloured by the phases they
  are on (A red, B blue, C green, two-phase purple, three-phase plain), and
  wires and busbars by the phases that actually reach them,
  worked out by the same walk that powers the phase-mismatch checks. A bus
  nothing reaches is grey and badged *unfed*, so a lateral cut off by an open
  fuse looks dead rather than defaulting to A. Because an element and the
  wire feeding it are coloured from different facts, a load pinned to C on a
  B lateral shows as a green symbol on a blue wire. A legend sits in the corner of
  the canvas while the overlay is on. This is how the commercial distribution
  planning tools show phasing; the palette is fixed for now

Whatever overlay is on goes into the **Image** export (SVG or PNG) with its
colour key, so a voltage plot or a phasing map can be dropped into a report
as drawn — see [Getting started](getting-started.md).

Hovering any element shows a detail tooltip: voltage magnitude and angle for
each phase (A, B, C) at each connected bus, the current on each phase the
element actually connects to, power, and loading against the rating. Results dim when the circuit has changed since they were computed
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

### Protection: time-current curves

**Protection** mode plots every fuse, recloser and relay in the circuit on
log-log paper: current across, operating time down. It answers the question a
coordination study is for — *for a fault here, which device operates first?*

- Each device gets a colour; a relay's ground curve is dashed, and a
  recloser's fast and delayed curves share its colour.
- The dashed vertical line is the **prospective 3φ fault current at that
  device's own downstream bus** — the fault it exists to clear. It comes from
  the same `mode=faultstudy` solve the Fault overlay uses, so the plot and the
  overlay always agree.
- Where a curve's data ends, a faint dotted line carries it on flat. That is
  what the engine does when deciding whether a device trips, and the fault
  current is usually out past the end of the published curve, so the plot has
  to reach it.
- Hovering reads out the current and time under the cursor, plus what every
  visible curve would do at that current ("no trip" below its pickup).
- Clicking a device in the legend takes it off the plot.

The curves are `TCC_Curve` objects scaled by each device's pickup, so a plotted
curve is the one the solve would use — the ten the engine ships, plus any this
circuit defines in the **Curves** tab. Running the study
costs a fault-study solve, so it runs when you open the tab and then on
**Re-run**; editing the circuit marks it stale rather than re-running by
itself.

#### Switches with no curve

A breaker has no protection attached — no curve, no pickup, nothing to plot
(see [Breaker](components.md#breaker--switch--k)). It still has to break
whatever fault reaches it, so breakers appear in a table beneath the plot with
the fault current at their bus against their interrupting rating.

#### What the study checks

Running the study also writes findings into the **Problems** list, where they
sit with everything else that is wrong with the circuit and highlight the
element they belong to:

| Check | What it means |
|---|---|
| **Pickup above the fault** | The device starts operating above the current a fault at its own bus would draw, so it would never trip for the fault it protects |
| **Miscoordination** | The device above operates too close behind the one below — see the grading rules below |
| **Interrupting duty** | The fault current at a switch exceeds what it is rated to break |

Everything is checked **twice**: phase units against the 3φ fault current, and
ground units against the 1φ one. A pair can grade perfectly on phase and not on
ground, which is exactly the case worth catching. A fuse has no ground unit and
needs none — it carries whatever current flows through it, so its one curve
answers for both.

Pairs are graded two ways, because the industry does:

- **Fuse to fuse — the 75% rule.** The fuse below must melt inside 75% of the
  melting time of the fuse above it, which leaves margin for the upper fuse not
  to be damaged. (The tool has one curve per fuse, the melt; the full rule
  compares the lower fuse's *total clearing* time, which is stricter still.)
- **Everything else — a 0.25 s margin**, the usual working figure for relays
  and reclosers.

A pair is only graded while **both devices are still on their curve data**.
Past the last published point every curve runs flat, so two very different
devices appear to operate at the same instant — that is the extrapolation
talking, not the devices. A fault that far out is already reported by the
interrupting-duty check.

The upstream/downstream pairing comes from walking the circuit outward from
the source, so it follows the drawing rather than any naming convention; an
open switch breaks the path, as it does electrically.

These are warnings, not errors — they never block a solve.
