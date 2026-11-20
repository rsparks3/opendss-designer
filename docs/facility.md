---
description: Installation-scale resilience planning in OpenDSS Designer — load priority and tracing, loss of utility with isochronous generators, operating scenarios, and allocating loads to metered values.
---

# Facility planning: priority, trace, loss of utility, allocation

A base, a campus or a large industrial site asks three questions of its
distribution model, in an Energy Resilience Readiness Exercise and every
time a large load is added:

1. **What feeds what?** Click a building and see everything between it and
   the source; click a breaker and see what it would drop.
2. **What happens when the utility goes away?** Which islands form, which
   generators carry them, whether they are overloaded, and which loads are dark.
3. **What does the system look like in each operating configuration?**
   Base case, utility out, feeders tied, a generator offline, side by side.

The **Installation campus** sample (*File → Samples*) has all of it: a
69 kV service, a split 13.2 kV main bus, three feeders with a normally-open
tie, two standby generators, and building loads at every priority, with two
outage scenarios already defined.

## Load priority, tags and building

Every load has a **Priority**: *critical*, *essential*, *non-essential* or
*unassigned* (the default). Priority is separate from the load's *Class*,
which stays the key for load levels and allocation from billing data. Loads also carry:

- **Tags**: any words, entered as chips. The project's tag vocabulary is
  offered as suggestions.
- **Building**: free text.
- **Fixed**: the load is metered separately, so an allocation never scales it.

All of these are columns in the **Elements** tab, where the fill handle copies a value down a column.

A `.dss` export writes these values as a comment line above the load, which the importer reads back:

```
! designer: priority=critical tags=medical building="Bldg 1200"
New Load.hospital bus1=... kw=900 ...
```

To any other tool the line is a comment.

Imported models carry a customer or load class rather than a priority. CYME
and Synergi models are converted to `.dss` first, so the same path applies.
The importer reads OpenDSS's `class=` into the load's *Class*. Where
`config/priority_by_class.csv` maps classes to priorities (one `class,priority`
row each; the shipped file is empty), each matching load gets that priority.
A priority already stated in a `! designer:` line is kept.

## Trace to source, show downstream

Right-click any element:

- **Trace to source** lights the path to every source that reaches it (the
  shortest, when there are several ways round) and lists the devices in
  order, with the first protective device upstream.
- **Show downstream** dims everything else and lists what the element would drop if it opened: loads grouped by priority, with kW and customers. A device on a loop drops nothing, because the other way round still feeds it.

Open switches and elements out of service break a path. The trace follows
the drawing as it is, including the scenario that is open. **Esc** clears it.

The **Priority** overlay colours each load by its priority, and each busbar
by the highest priority its loss would drop. The report's **Critical loads**
section lists every critical and essential load with:

- its source;
- its feeder: the last protective device leaving a switchgear bus on the way down;
- the transformer nearest it;
- the first protective device that would clear a fault at it.

`POST /api/trace` gives the same answers on the server.

## Loss of utility

A generator's **Island mode** is *grid* (the usual: a constant-power OpenDSS
Generator) or *isochronous*: it holds an island's voltage and frequency when
the utility is gone.

OpenDSS has no isochronous machine. One in this mode is compiled as a
**voltage source at its terminal**:

| Study | Source impedance | Why |
|---|---|---|
| Power flow | A twentieth of Xd'' (nearly stiff) | Its voltage regulator holds the terminal voltage while it carries load |
| Fault study, fault point, fault sweep | Xd'' on its rating (x = Xd'' · kV² / MVA, Xd'' 0.15 pu unless entered) | That reactance sets the current it feeds a fault |

!!! warning "Screening grade"
    The model does not limit a machine to its rating, share load between two
    machines by droop, or represent governor, fuel or transient behaviour. A
    loading over 100 % means the island cannot be carried as configured. It
    is not a dynamic or stability study. Two machines holding one island are
    flagged as indicative only.

**Analysis → Utility outage** (or ⚡ in the Scenarios tab) builds the
scenario in one step. Every source of *Kind* utility goes out of service,
and every generator goes in service and isochronous. The scenario opens with
the **Islands** overlay on, also under *Analysis → Overlay*:

- each island a source holds is drawn in its own colour, and whatever no source reaches is grey;
- after a solve, there is a card per island: what carries it, the load it serves, each machine's loading against its *Rating* and its *Fuel on hand*, and the voltage range;
- a further card lists what is dark, by priority;
- a card is red when a machine is past its rating or critical load is unserved.

Open breakers in the scenario to split the bus or shed load, then solve
again. Every solve returns the island summary, and `POST /api/islands`
gives the islands from topology alone. The report's **Loss of utility**
section covers every scenario a generator carries after *Run all*, or the
current solve without one. For each, it gives the island table and the
unserved loads, followed by the modelling note above.

## Scenarios and the comparison

Scenarios are described on [Planning](planning.md). For installation work:

- The open scenario's changes wear a **dashed halo** (amber for changed, green for added). Hovering an element shows each changed parameter, base → scenario.
- A banner over the drawing gives the way back to the base case.
- In the Scenarios tab you can rename (✎ or double-click), reorder, and **promote** a scenario to the base. Promoting rebases the other scenarios, so each still describes the same circuit.
- After **Run all**, the batch view compares scenarios element by element: unserved load by priority, every bus's lowest voltage, or every element's loading. Each scenario gets a column, and the worst value in each row is highlighted.
- *File → Export → OpenDSS (.dss) of…* exports the base case or any scenario, fully resolved.
- The report's **Scenarios** section states each scenario's changes in words, with the comparison when a batch has been run.

## Allocating loads to a metered value

Right-click the meter point and choose **Allocate to a metered value…**. The meter point can be the utility source, a feeder breaker, a transformer or a line. Enter:

- the measured kW;
- optionally, kvar or power factor;
- demand factors by priority or tag (`nonessential=0.8, hvac=0.9`);
- where the measurement came from.

Every load below the meter point, except those marked *Fixed*, is scaled
until the solve agrees within 0.5 % (at most five solves, since losses move
with the loads):

- **Apply** stores the factor with the project. It is applied at every solve and the entered values are kept. Scaled loads show a small ×factor tag.
- **Bake into loads** writes the scaled values into the loads (in the base case) and removes the allocation.
- **Clear** removes it.

The zone below a meter point is taken from the base case. It does not move
when a scenario opens a breaker or loses the utility, so the load basis is
the same in every configuration. Two zones may not share a load.

The `.dss` and CIM exports write the allocated values; the `.dss` export adds a comment with the factor. The report's **Load basis**
section lists each allocation with its measurement and source.

The older *Analysis → Allocate loads from meter data…* (billing kWh, kW or
AMI intervals matched to loads by name, bus or class) remains for building
the per-load values in the first place. Its scaling to a head measurement
now converges to 0.5 % the same way.
