---
description: How OpenDSS Designer computes DER and load hosting capacity — the criteria, the iterative and sensitivity methods, the outputs and what has been checked.
---

# Hosting capacity

How much DER a bus can take before a planning criterion binds — or, the
mirror case, how much new load (EV charging, electrification). The
**Hosting** tab runs it; the **Hosting** overlay colours every bus by the
answer; the result exports as GeoJSON or CSV for a GIS or a public
hosting-capacity map, and the study report prints it.

## What is evaluated

A trial unit — a generator at unity power factor for DER, a constant-power
load at 0.95 for the load case — is placed at each candidate bus and grown
until one of the criteria below fails. Candidates are every three-phase bus
above 1 kV by default; both choices are options.

| Criterion | Test | Default limit |
|---|---|---|
| **Voltage** | DER: any bus above the upper limit. Load: any bus below the lower limit | The project's abnormal-condition limits (1.05 / 0.95 pu), or a tighter value typed in the tab |
| **Thermal** | Any line, transformer or device above the active load level's rating (normal or emergency) | 100 % |
| **Voltage change on trip** | The unit is switched off and the circuit re-solved; any bus moves more than the limit (IEEE 1547-2018 §4.7 rapid voltage change) | 3 % |
| **Reverse power at a regulator** | Real power flows backwards through a regulator | more than 10 kW |
| **Reverse power at the substation** | The feeder exports at its head | more than 0 kW |
| **Fault-current increase** | The unit's fault contribution against the base fault current at its bus (the FERC SGIP screen) | 10 % |
| **Interrupting duty** | Base fault current at a protective device plus the unit's contribution, against the device's interrupting rating (the SGIP screen) | 87.5 % |
| **Islanding ratio** | DER against the rated load of its protection section (the branches below the nearest fuse, recloser or relay) at the active level's multiplier | 2/3 |

Each is a tick box. The fault criteria are analytic: a base fault study
(`mode=faultstudy`) gives the three-phase fault current at every bus once,
and the unit contributes 1.2 × its rated current (an inverter) or 5 × (a
synchronous machine, xd″ ≈ 0.2). That is how utilities compute the screens,
and it spares a fault solve per trial. **Protection reach** (the device's
view of a downstream fault shrinking as DER feeds it) is not evaluated yet;
it needs the sliding fault planned for the protection milestone.

**Pre-existing violations do not count.** A bus already over the voltage
limit, a line already over its rating, a regulator already carrying
reverse flow, a device already past its interrupting duty in the base case
is excluded from that criterion and listed under the result, so a
congested feeder still gets an answer about the rest.

## Methods

**Iterative.** At each bus the unit is grown by doubling until a criterion
fails, then bisected between the last feasible and the first infeasible
size to within the tolerance (10 kW). Every evaluation is one solve, two
when the trip criterion is on. Exact for the criteria it checks; the
reference the other method is held to.

**Sensitivity.** One probe solve per bus (the unit at 100 kW) gives
dV/dP at every bus and the change in loading of every branch; the capacity
each criterion allows follows by linear extrapolation — for a branch whose
loading first falls as the unit offsets the flow, the root on the far side
where the reversed flow reaches the rating — and the smallest of them is
the estimate. It is then confirmed by a solve at that size, and tightened
by a few bisection steps if the linear guess was optimistic (regulators
and voltage-dependent loads bend the line). Three or four solves per bus
instead of ten to twenty: the shape of EPRI's DRIVE method, and what makes
a feeder-wide or hourly study affordable. The per-criterion estimates are
shown in the table, which answers "what binds second".

**Time-granular.** With loadshapes assigned, a list of hours (`2, 12, 18`)
runs the study at each hour of the daily shapes; the capacity of a bus is
its worst hour, and the per-hour values are kept, which is the form a
published hosting-capacity map takes.

The run is at the active **load level** (minimum daytime load is where DER
hosting capacity usually binds) and on the open **scenario**, and says so.

## Outputs

- A table, bus by bus: capacity, the binding criterion, the per-criterion
  estimates (sensitivity method), the per-hour values, and the load of the
  bus's protection section.
- The **Hosting** overlay: every bus coloured red (nothing) through amber
  to green (the largest capacity in the run), with a legend; on the map too.
- **GeoJSON** (points at each bus's coordinates, with capacity, binding
  criterion and per-criterion values as properties, in the project's
  coordinate system) and **CSV**.
- The report's **Hosting capacity** section.

## Interconnection screening

**Analysis → Screen a DER interconnection…** (or *Screen a DER here…* on an
element's right-click menu) runs one application at a point of common
coupling through the tariff screens in one go and prints the standard
table, with the outcome *pass*, *supplemental review* or *fail*:

| Screen | Test | Default |
|---|---|---|
| Aggregate generation on the line section | DER already on the section plus this unit, against a share of the section's peak load (the fast-track screen) | 15 % |
| Minimum daytime load (supplemental) | When the aggregate screen fails and the unit exports: aggregate against the section's minimum load, taken from the project's level named *Minimum…* (else 30 % of peak) | 100 % |
| Fault-current contribution | The unit's contribution against the maximum fault current at the PCC | 10 % |
| Interrupting duty | Every protective device with the unit's contribution added, against its interrupting rating | 87.5 % |
| Rapid voltage change | The unit tripped, at every bus | 3 % |
| Steady-state voltage | With the unit running, inside the project's limits | 0.95–1.05 pu |
| Loading | With the unit running, nothing newly over its rating | 100 % |
| Effective grounding at the PCC | X0/X1 ≤ 3 and R0/X1 ≤ 1 (IEEE 142), from the Thevenin impedances | |
| Smart inverter settings | The IEEE 1547-2018 Category A or B characteristics the unit must run; reported, not judged | Category B |

The screens run at the active load level and on the open scenario, as
every study does. The report's **Interconnection screening** section prints
the table. `POST /api/screen` is the route; `POST /api/faultpoint` gives one
fault of any kind (three-phase, line-to-ground, line-to-line,
double-line-to-ground, through resistance) at one bus with the current in
every series element, and `POST /api/jobs/fault-sweep` the maximum and
minimum fault currents at every bus — the pieces the protection work of
M16 builds on.

## What has been checked

`tests/test_hosting_capacity.py` holds the method to a feeder built for
it: the iterative result is confirmed by placing a generator of that size
and re-solving (every criterion inside its limit; a third more and one is
outside), the sensitivity method agrees with the iterative one within 8 %
with a fifth of the solves, reverse power at the head binds at the feeder's
load, the islanding ratio at two thirds of the section's load, load
hosting capacity on undervoltage or thermal, the worst hour of a
time-granular run is taken, and pre-existing violations are excluded.

`tests/test_screening.py` holds the screens: a 100 kW unit passes, 500 kW
on a 2 MW section needs supplemental review (15 % fails, 100 % of minimum
load passes), 3 MW at the end of a weak feeder fails on voltage and rapid
voltage change, existing DER counts toward the aggregate, a non-exporting
unit gets no minimum-load screen, and the fault-element solves agree with
the fault study within 5 % for the bolted cases.

Not yet done: a comparison with a published reference (EPRI's DRIVE
results on the IEEE 123-bus feeder, NREL's hosting-capacity papers on the
same feeders). The numbers in those reports depend on criteria choices this
page documents, so the comparison is a matter of setting the same ones;
it will be added to this page when run.
