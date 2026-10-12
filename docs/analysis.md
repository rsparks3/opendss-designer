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

The toolbar (and the **Analysis** menu) has two analysis modes:

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
  breakers, colored by severity; overloads (≥ 100 %) in red. Shunt
  elements are judged too: a generator, PV system or storage unit by its
  apparent power against its kVA rating, a capacitor by its current
  against the 135 % of rated that IEEE 18 lets it carry continuously (so a
  capacitor at rated voltage reads 74 %)
- **Power** — kW/kvar labels on series elements
- **Fault** — see below
- **Reliability** — see below: every line and device coloured by the
  protection section it is in, loads badged with their customers, and a
  legend with SAIFI, SAIDI and CAIDI
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

## Reliability

Selecting the **Reliability** overlay (or the **Reliability** tab's *Run*
button) runs OpenDSS's own EnergyMeter reliability calculation and reports
**SAIFI** (interruptions per customer per year), **SAIDI** (hours out per
customer per year) and **CAIDI** (hours per interruption). Any circuit
edit clears it, like the fault study. The report's *Reliability* section
tabulates the same numbers.

What goes in:

- Every line, transformer, regulator and switch has a **fault rate**
  (faults per year; for a line, per unit of its length per year), the share
  of faults that are **permanent**, and a **repair time** in hours. Left
  blank they are OpenDSS's defaults: 0.1, 20 % and 3 h.
- Every load has a number of **customers** (default 1).

How it is counted, which is OpenDSS's convention, not this app's: a
**protection section** is a fuse, recloser or relay together with every
branch downstream of it up to the next such device. A permanent fault
anywhere in a section interrupts every customer downstream of the
section's head device, for the faulted branch's repair time. So SAIFI is
the sum over sections of (permanent faults a year in the section ×
customers downstream of its head), divided by all customers. Branches
between the meter and the first protective device belong to **no
section**, and faults on them count for nothing — the overlay draws them
grey, the tab and the report say how much fault rate is going uncounted,
and the fix is a relay (a breaker with protection) or a recloser at the
feeder head, which is how a real feeder is built anyway. A breaker on its
own is a switch, not protection.

Where the meter goes: on every line, switch or transformer leaving the
source bus, so each feeder out of a substation bus is a zone of its own
and the overall indices combine the zones by customers. To meter a part
of the circuit instead, tick **Reliability meter here** on the element
where the zone should begin; the study then meters only the flagged
elements. Hovering an element in the overlay shows its own permanent fault
rate, the rate of everything downstream of it, the customers downstream
and its section.

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
