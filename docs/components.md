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

## Breaker / switch — ++k++

Emitted as a zero-impedance OpenDSS switch. Double-click (or right-click) to
open/close it; an open breaker de-energizes everything downstream.

| Parameter | Meaning |
|---|---|
| Closed | Switch state |
| Rating (A) | `normamps`, used for the loading overlay |
| Phases | 1 / 2 / 3 |

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
draggable routing point; double-click a point to remove it.

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
