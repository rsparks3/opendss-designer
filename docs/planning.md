---
description: Load levels, scenarios, the compare view and batch runs in OpenDSS Designer — the foundation every planning study is run on.
---

# Planning: load levels, scenarios, compare and batch

A planning study is "this feeder, at this load condition, base against
alternative". These are the three nouns, and this page is how the app
spells them.

## Load levels

Every solve used to run every load at its rated kW. A **load level** is a
named load condition: a multiplier on every load (OpenDSS's `set loadmult`),
optional multipliers by load class on top, and which rating loading is
judged against.

Define them in **File → Project properties → Load levels**. *Use the usual
three* gives:

| Level | Multiplier | Rating | Used for |
|---|---|---|---|
| Peak | 1.0 | normal | Capacity and voltage drop, what every circuit solved before |
| Minimum daytime | 0.3 | normal | Overvoltage and reverse power with DER on the feeder; the case a hosting-capacity study binds on |
| Emergency peak | 1.0 | emergency | N-1 and transfer cases, where the emergency rating is what is allowed for a few hours |

Pick the level for the next solve in the toolbar (the *Rated* dropdown
appears once a project has levels) or under **Analysis → Load level**. The
status line, the hover tooltips and the study report's title block all name
it, and a comparison can tell two levels apart.

**Class multipliers** scale one class of load on top of the global
multiplier. Give loads a *Class* in the properties panel (any word:
`residential`, `commercial`, a rate code) and type `residential=1.5` in the
level's class column; that class's kW is multiplied by 1.5 before the global
factor applies. This is how an "EV evening" level or a "commercial peak"
level is written.

**Emergency ratings.** Lines, switches and protective devices carry an
*Emergency rating* in amps (`emergamps`) and transformers and regulators one
in kVA (`emerghkva`) beside their continuous rating; blank is OpenDSS's own
default of 1.5 × the continuous rating. A level on the *emergency* rating
judges loading, the loading overlay, the abnormal-condition report and the
pies against that figure instead. Imported files keep the ratings they gave.

## Scenarios

A **scenario** is an alternative to the base circuit: a regulator setting
changed, a tie opened, a bank added, a unit taken out of service, a new DER.
The project stores a scenario as *deltas* against the base — the parameters
that differ, the elements added, the elements removed — so a project with
ten alternatives is still one drawing, and the file always holds the base.

Work with them in the **Scenarios** tab (or **Analysis → Scenario**):

- **Add** a scenario and it opens at once: from then on, every edit on the
  drawing belongs to that scenario, until you pick *Base case* again. The
  toolbar shows which scenario is open. Elements can be changed, added,
  wired, removed, opened or taken out of service — anything the editor
  does.
- **Switch** between the base case and any scenario; the drawing swaps to
  that alternative. Positions are shared, so a symbol moved in one place is
  moved everywhere. Undo history does not cross a switch.
- **Duplicate** a scenario to branch from it; **delete** one you are done
  with. A description field holds what the alternative is for.
- A solve, fault study, time series or export runs on the open scenario;
  the result says which one.

On export to `.dss` the open scenario is what is written. A saved project
(`.json`) keeps the base, every scenario and which one was open.

!!! note "How the deltas are made"
    The app diffs the drawing against the base when you leave a scenario,
    element by element. The Python side (`core/scenarios.py`) applies the
    same deltas, so a batch run or a scripted study can rebuild any
    alternative from one saved document.

## Compare

**Pin solve as baseline** (Scenarios tab, or **Analysis**) keeps the current
solve as the "before". Then change the circuit, open another scenario or
pick another load level, solve, and:

- the **Compare** overlay draws the change at every bus (lowest phase
  voltage in pu, red lower, green higher) and on every series element
  (loading in points of per cent, red higher);
- the **Compare** tab lists every bus and element whose result changed,
  largest change first, with the before, after and difference, and headline
  numbers: the change in losses, in the lowest voltage, in the highest
  loading, and the number of violations before and after;
- the study report's **Comparison** section prints the same.

The baseline survives edits on purpose, since it is the "before"; unpin it
from the Compare tab.

## Batch

**Run all** in the Scenarios tab (or **Analysis → Run every scenario at
every load level**) solves the base case and every scenario at every load
level as a background job and tabulates each cell: source kW, lowest
voltage and where, highest voltage, highest loading and on what, losses,
and the counts of undervoltages, overvoltages, overloads and warnings. A
row is tinted when a cell has a violation, red when it did not converge.
The report's **Scenarios and load levels** section prints the matrix.

The run is a *job*: it reports progress, can be cancelled, and its result
stays on the server for a while (`GET /api/jobs`), so a tab that lost its
connection can read it back. On the hosted service a plan caps how many
solves one job may take; locally there is no cap.

## Controls that come with this

Two control classes a real feeder carries could only ride along as
passthrough text before. Both are now settings on the element they control,
written and read back on import and export.

**Capacitor controls** (`CapControl`): on the capacitor, *Control* picks
the type — **voltage** (switch on below, off above, in volts on the PT
secondary), **current** or **kvar** (on above, off below, through the
element it watches), **pf**, or **time** of day — and *Watches* names the
line, transformer or switch the control measures (or the capacitor's own
terminal). PT and CT ratios, on and off delays and the dead time are the
engine's properties under their own names.

**Smart inverter functions** (`InvControl`): on a PV system or storage
unit, *Inverter function* picks **volt-var**, **volt-watt**, both, watt-pf
or watt-var, each pointing at an **inverter curve** from the Curves tab
(per-unit voltage against per-unit power, negative var absorbing). The
Curves tab adds the **IEEE 1547-2018 Category A and B** defaults in one
click. Units sharing a function and curve are grouped into one control, as
the engine wants.

**Regulators** gain **reverse-power mode** (`reversible`, with its own
setpoint and bandwidth) and **cogeneration mode** (`cogen`), which decide
what the control does when a closed tie or exporting DER pushes power
backwards through it.

**Control operations.** Every time-series run now counts tap changes per
regulator and switching operations per capacitor bank, step to step. The
summary above the time graph lists them, and `totals.controlOps` in the
result is the per-step series. This is a hosting-capacity criterion and the
measure of a Volt/VAR scheme's wear on its equipment.
