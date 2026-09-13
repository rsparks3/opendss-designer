---
description: Every element in OpenDSS Designer and the OpenDSS parameters behind it: sources, busbars, transformers, breakers, lines, loads, capacitors, generators, PV systems and storage.
---

# Components

Every element you can place from the palette, with its OpenDSS parameters.
Placement is sticky — click a palette item (or press its shortcut letter),
then click the canvas repeatedly to drop several; press ++esc++ to stop.
Symbols are ANSI one-line style, and every element can be rotated with ++r++.

Parameters are edited in the properties panel (select the element) or in bulk
on the [Elements spreadsheet](#spreadsheet-view). Anything not listed here is
left at its OpenDSS default.

## Source — ++s++

An OpenDSS `Vsource`; the first one placed defines the circuit. Every circuit
needs at least one.

| Parameter | Meaning |
|---|---|
| Base kV (LL) | Line-to-line source voltage |
| Voltage (pu) | Per-unit setpoint |
| Angle (°) | Reference angle |
| Phases | 1 / 2 / 3 |
| 3φ / 1φ short-circuit (MVA) | Thévenin strength (`mvasc3`, `mvasc1`) — drives fault-study results |

## Busbar — ++b++

A stretchable bus with connection handles along its top and bottom edges. Drag
horizontally while placing to set its width; drag the end grips later to
resize (connections re-home automatically if the bar shrinks). The declared
base kV is used for validation and voltage-base calculation.

Busbars are optional: wiring elements directly together creates an implicit
junction bus. Name a busbar and that name is used in solves and `.dss`
exports.

## Transformer — ++t++

Two-winding, with a per-winding editor:

| Parameter | Meaning |
|---|---|
| Phases | 1 or 3 |
| X(H-L) (%) | Leakage reactance between windings |
| Load loss (%) | Winding losses at rated load |
| Per winding: kV, kVA, wye/delta | Ratings and connection for each side |

## Regulator — ++v++

A step-voltage regulator: an equal-ratio transformer plus the `RegControl`
that moves its taps to hold the load-side voltage. Settings are the ones on a
real control cabinet, expressed on the 120 V control base.

| Parameter | Meaning |
|---|---|
| Phases | 1 or 3 |
| Rated kV, kVA | Same kV both sides — a regulator boosts, it does not transform |
| Voltage setpoint | Target voltage on the 120 V base (122 V is typical) |
| Bandwidth | Total deadband around the setpoint, so ±half this |
| PT ratio | Turns the line voltage into the 120 V base. Left blank, it is derived from the rated kV |
| CT primary | Current transformer primary rating, used by line drop compensation |
| Line drop comp R, X | Volts of compensation, to regulate a point out on the feeder rather than at the regulator |
| Max tap change / solution | Taps the control may move in one solution |

The tap position is chosen by OpenDSS during the solve; the diagram shows the
resulting voltages. Importing a `.dss` file turns any transformer with a
`RegControl` on it back into a regulator.

## Breaker / switch — ++k++

Emitted as a zero-impedance OpenDSS switch. Double-click (or right-click) to
open/close it; an open breaker de-energizes everything downstream.

| Parameter | Meaning |
|---|---|
| Closed | Switch state |
| Rating (A) | `normamps`, used for the loading overlay |
| Interrupting rating (kA) | What it can break; checked against the fault current available at its bus |
| Phases | 1 / 2 / 3 |

!!! note "A breaker has no protection of its own"

    It carries no time-current curve and never trips by itself — it is the
    switch someone operates: a tie point, a sectionalizing point, an isolation
    switch. That is why breakers have no curve in the
    [Protection plot](analysis.md#protection-time-current-curves); they appear
    in the table beneath it instead, where their interrupting rating is checked
    against the fault duty.

    For **a breaker that trips on overcurrent, use a relay** — that element is
    exactly this breaker plus the relay that watches it, which is how the two
    are drawn on a real one-line.

## Fuse — ++f++, Recloser — ++o++, Relay — ++y++

Protective devices. Each one is a switch on the diagram plus the control that
watches it, and the editor keeps the pair together as a single element — the
switch is what carries current, so loading and losses report against it.

Right-click (or double-click) blows a fuse or opens a recloser or relay, the
same way a breaker opens. Anything downstream goes dead, which is how you check
what a device protects.

**Fuse**

| Parameter | Meaning |
|---|---|
| Intact | Uncheck to blow it |
| Rated current | The link's rating, in amps |
| Fuse link | `tlink` or `klink` — the standard link curves |
| Added delay | Seconds added to the curve's time |
| Continuous rating | `normamps`, used for the loading overlay |

**Recloser**

| Parameter | Meaning |
|---|---|
| Phase / ground pickup | Trip current, in amps |
| Fast / delayed curve | `a` and `d` are the standard fast and delayed curves |
| Ground fast / delayed curve | Leave at `none` for no ground unit; the ground pickup alone does not create one |
| Fast operations | How many trips use the fast curve before switching to the delayed one |
| Shots to lockout | Trips before it stays open |

**Relay** (overcurrent, IEEE C37.2 device 51 — 51N once a ground curve is set)

Drawn the way a one-line draws it: the breaker sits in the line, the relay is
its own circled device number beside it, and the dashed link between them is
the trip signal. It is a breaker *with* protection — use it wherever a breaker
should trip on overcurrent rather than be opened by hand.

| Parameter | Meaning |
|---|---|
| Phase / ground pickup | Trip current, in amps |
| Phase / ground curve | `mod_inv`, `very_inv`, `ext_inv` (IEEE moderately, very and extremely inverse) or `definite` |
| Ground curve `none` | No ground unit at all, which is different from one set to a default |

The curve names are the ones built into the OpenDSS engine, so the dropdown
only offers those — naming a curve the engine does not hold stops the solve
outright.

Their curves are plotted in the **Graph tab → Protection** — see
[Analysis](analysis.md#protection-time-current-curves).

!!! note "What these do today"

    The controls describe how each device *would* operate, and the Protection
    plot shows when. OpenDSS itself runs protection in fault and time-domain
    studies, so in a snapshot or a time-series run these behave as closed
    switches with ratings — nothing trips mid-run. Automatic coordination
    checks between devices are the next step on the
    [roadmap](https://github.com/rsparks3/opendss-designer/blob/main/FUTURE_IMPROVEMENTS.md).

## Load — ++l++

| Parameter | Meaning |
|---|---|
| Rated kV | Line-to-line for 3φ/wye conventions per OpenDSS |
| Power (kW) | Rated demand at multiplier 1.0 |
| Power factor | Positive = lagging |
| Phases, Connection | 1/2/3, wye/delta |
| Load model | OpenDSS models 1–5 (1 = constant P/Q) |
| Loadshape | A [load shape](shapes.md) that scales the load over time-series runs |

In a snapshot solve, loads draw their full rated kW; the loadshape applies
only to [time-series runs](timeseries.md).

## Capacitor — ++c++

Shunt capacitor bank: rated kV, size (kvar), phases, wye/delta, and number of
switched steps.

## Generator — ++g++

| Parameter | Meaning |
|---|---|
| Rated kV, Output (kW), Power factor | Machine ratings |
| Mode | 1 = constant kW/pf; 3 = PV mode (holds a voltage setpoint) |
| V setpoint (pu) | Held voltage in mode 3 |

## PV system — ++p++

An OpenDSS `PVSystem`: panel + inverter, with built-in inverter efficiency
and power–temperature curves.

| Parameter | Meaning |
|---|---|
| Rated kV | Interconnection voltage |
| Inverter rating (kVA) | Caps output |
| Panel Pmpp (kW) | Array rating at 1 kW/m² and 25 °C |
| Power factor | Inverter pf |
| Irradiance (pu) | Base irradiance in kW/m²; output ≈ Pmpp × irradiance × efficiency |
| Irradiance shape | An [irradiance shape](shapes.md) that scales the base irradiance over time-series runs |

In a snapshot solve, the PV system produces at its base irradiance (the shape
is not applied). Fetch real regional irradiance from the NSRDB in the
[Shapes tab](shapes.md#nsrdb-irradiance).

## Storage — ++a++

An OpenDSS `Storage` element (battery).

| Parameter | Meaning |
|---|---|
| Power rating (kW), Energy rating (kWh) | Inverter and pack ratings |
| Initial charge (%) | State of charge at the start of a run |
| Reserve (%) | SOC floor the dispatch will not discharge below |
| Charge / discharge eff. (%) | One-way efficiencies |
| Dispatch mode | `follow` or `default` (below) |
| Dispatch shape | Shape driving `follow` mode |
| Charge / discharge trigger | Thresholds for `default` mode |

Dispatch modes:

- **follow** — the assigned shape drives the battery directly each step:
  positive multiplier = discharge (× kW rating), negative = charge. This is
  the primary mode; hand-craft a dispatch curve in the Shapes tab, or reuse
  a load shape.
- **default** — OpenDSS's built-in triggered dispatch, where the triggers
  compare against the circuit's default loadshape multiplier. Documented as
  advanced; prefer `follow`.

Storage only acts during [time-series runs](timeseries.md); in a snapshot it
idles. Storage elements are excluded from fault studies (a crash in the
underlying DSS engine — their fault contribution is negligible anyway).

## Wires vs. Lines

Dragging between two terminals creates a connection whose kind follows the
**Wire** / **Line** mode buttons (++w++ / ++e++):

- **Wire** — an ideal connection; the two terminals become the same OpenDSS
  bus (merged via union-find under the hood).
- **Line** — a real OpenDSS `Line` element: length + units, sequence
  impedances (R1/X1/R0/X0 per unit length), ampacity, phases. Conductor
  parameters can be stamped from an editable preset library
  (`config/linecodes.csv`) or entered directly.

Picking a connect mode exits placement mode, so the next connection is always
the kind you chose. While a placement mode *is* active, connections default
to plain wires (you're dropping components and hooking them up as you go).
Illegal connections — busbar-to-busbar wires, self-connections, duplicates —
are refused with an explanation. Double-click any wire or line to add a
draggable routing point; double-click a point to remove it. The new point
lands *on* the wire and the elbows the router had already drawn become
routing points too, so adding one never changes the shape you were looking
at — right-click and **Straighten** hands the edge back to the auto-router.

### Re-routing a connection

Dragging from a terminal that already holds exactly one wire picks that wire
up instead of drawing a second one: its end follows the cursor while the far
end stays put, so moving a line from one component to another is a single
gesture. Drop it on any terminal to re-home it — the same rules apply, and a
refused drop says why. Drop it on empty canvas, or press ++esc++ mid-drag, and
the wire snaps back untouched.

Terminals carrying two or more wires are left alone (there would be no telling
which one the drag meant), and holding ++alt++ always draws a new wire. A
terminal never stops being a valid *drop* target, so a second connection is
still made the usual way: start the drag at the other end.

Routing points survive a move between handles of the same component — walking
a wire along a busbar keeps its shape — and are cleared when the end lands on
a different component, where the old path no longer means anything.

## Spreadsheet view

The **Elements** tab lists every element type in an editable table — one
sub-tab per type, including PV systems and storage. Edit values in bulk with
an Excel-style fill-down handle; loadshape columns are dropdowns into the
shape library. Click ⌖ to locate any element on the diagram. After a solve, a
read-only bus-results table appears alongside.

## Editor quality of life

Undo/redo (++ctrl+z++ / ++ctrl+y++), copy/paste/duplicate
(++ctrl+c++ / ++ctrl+v++ / ++ctrl+d++), delete, rotation (++r++), grid
snapping, pan/zoom with minimap, box-select and group-move, drag-to-re-route
connections, right-click context menus, and result tooltips throughout. Your work autosaves to the
browser between sessions.
