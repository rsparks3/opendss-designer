---
description: Install OpenDSS Designer with pip or use the hosted copy, draw your first one-line diagram, run a power flow, and read the results on the diagram. A five-minute walkthrough.
---

# Getting started

## Install

OpenDSS Designer is a Python package; it needs Python 3.10 or newer.

```bash
pip install opendss-designer
opendss-designer
```

This starts a local web server and opens the editor in your browser. Useful
flags: `--port 8721` (it picks the next free port if busy) and
`--no-browser`. There is also `--host` and `--demo` for
[hosting an instance](deployment.md) — neither affects a normal local run.

The app is local by default: the server binds to `127.0.0.1`, and your circuits
never leave your machine. The only outbound requests are the ones you ask for
explicitly — the NREL load-profile and NSRDB irradiance fetchers. If you are
using the [hosted instance](https://opendssdesigner.ryanmsparks.com) instead, see [Security](security.md) for
what that changes.

!!! tip "Start from a sample"
    Pick one from **File → Samples** — *Demo substation*
    for the basics, or *Radial feeder with DER* if you want something with PV,
    a battery and a daily load shape to run a time series on.
    from the repository, then press **Solve** to see the result overlays
    immediately.

## Draw your first circuit

1. **Place elements** — click an element in the palette (Source, Busbar,
   Transformer, Breaker, Load, Capacitor, Generator, PV system, Storage…),
   then click the canvas to drop it. Placement is *sticky*: keep clicking to
   drop several; press ++esc++ to stop. Each palette item has a keyboard
   shortcut letter — see [Components](components.md) for the full reference.
2. **Wire them up** — drag from one terminal to another. You'll be asked
   whether the connection is a **Wire** (an ideal connection that merges the
   two buses) or a **Line** (a real OpenDSS `Line` with impedance and length).
   Illegal connections are refused with an explanation.
3. **Set parameters** — select an element and edit its OpenDSS parameters in
   the properties panel: kV, kVA, impedances, phases (1/2/3), wye/delta
   connection, load model, and so on. Lines can start from conductor presets.
4. **Watch the validation** — unconnected terminals, a missing source,
   islands, duplicate names, and kV mismatches are flagged live; errors halo
   the offending element and disable Solve until fixed.

## Solve

Press **Solve** to run a snapshot power flow through the real OpenDSS engine.
The results overlay the diagram:

- bus voltages in per-unit at every busbar,
- element loading as pie charts with percentages,
- power flows, and total losses in the status bar,
- violations color-coded: undervoltage blue, overvoltage/overload red.

Toggle **Auto** to re-solve automatically after every change. The **Graph**
tab in the bottom panel plots solved results — pick your axes to get, for
example, a classic voltage-profile plot along the feeder. The **Fault**
overlay and **Losses** tab cover short-circuit currents and per-element
losses — see [Solving & analysis](analysis.md).

## Simulate over time

Snapshot solves are one operating point. To simulate a day or a year —
loads following demand curves, PV following the sun, storage dispatching —
assign shapes in the **Shapes** tab (draw them, paste CSV, or import real
NREL/NLR building profiles and NSRDB irradiance), switch the toolbar to
**Time series** mode, and press **▶ Run**. Then scrub or play through the
results directly on the diagram. See [Shapes & profiles](shapes.md) and
[Time-series analysis](timeseries.md).

## The menus

Commands live in a menu bar laid out like a desktop drawing tool's:
**File** (new, open, samples, import, save, export), **Edit** (undo, cut,
copy, paste, duplicate, delete, select all), **View** (zoom, fit, grid, snap,
which panels show), **Arrange** (clean up, rotate, straighten), **Analysis**
(snapshot or time series, solve, auto-solve, overlay) and **Help**. Every
item prints its shortcut beside it, and **Help → Keyboard shortcuts** (or
`?`) lists them all. The row under the menus keeps what gets pressed
all day: the circuit name, undo/redo, **Solve** (++f5++), **Auto**, the
analysis mode and the overlay buttons. *Unsaved changes* appears beside the
name while there is something to save; click it to save.

## Save, export, import

- **File → Save** (Ctrl+S) keeps the whole project (diagram, parameters, shapes)
  in your browser's storage under a name; the first save asks for one, later
  saves are silent. **Save as…** makes a copy, **Open…** (Ctrl+O) lists what
  is saved with rename, delete and export. Saved circuits live in that
  browser on that device only and are never uploaded.
- **File → Save to file** (Ctrl+Alt+S) keeps the project as a
  `.oneline.json` file on disk, and **File → Open file…** (Ctrl+Shift+O)
  opens one. In Chrome and Edge the file stays linked — its name shows next
  to the circuit name — and later saves write straight back over it, which
  suits a shared folder or a git repository; **Save to file as…** picks a
  different file. In Firefox and Safari, Save to file downloads a copy
  instead.
- **File → Export → OpenDSS (.dss)** writes a runnable `.dss` script — the exact commands the built-in
  solver uses — so anything you draw also runs in stock OpenDSS.
- **File → Import .dss…** loads existing `.dss` files; see
  [Importing DSS files](importing-dss.md).
- **File → Export → Image (SVG / PNG)** download the drawing as it is on screen, with the
  active overlay, a colour key and a caption (name, overlay, date). The SVG
  is a genuine vector file — real paths and text, no embedded screenshot —
  so it opens and edits in Inkscape, Visio and PowerPoint; the PNG is
  rendered from it at 2× for reports and slides. Selection is cleared first
  so nothing carries the editor's blue outline, and the view's zoom and pan
  do not affect the result.

## Editor essentials

|  |  |
|---|---|
| Undo / redo | ++ctrl+z++ / ++ctrl+y++ |
| Cut / copy / paste | ++ctrl+x++ / ++ctrl+c++ / ++ctrl+v++ |
| Delete selection | ++delete++ |
| Select all | ++ctrl+a++ |
| Solve | ++f5++ |
| Stop placing | ++esc++ |
| Find an element | ++ctrl+f++ |
| Flip left–right / upside down | ++shift+h++ / ++shift+v++ |
| Every shortcut | `?` |

**View → Theme** switches between light, dark and whatever the operating
system is set to; image exports always come out on white. **View →
Preferences…** also sets the colours the Phases overlay uses for A, B, C and
two-phase lines, if your utility's convention differs from the default red,
blue and green.

Plus: grid snapping (**View → Snap to grid**), pan/zoom with a minimap, box-select and group-move,
right-click context menu, rotation, and double-click actions — double-click a
breaker to open/close it, or a wire/line to add a draggable routing point.

To move a connection, drag the terminal it sits on: a terminal holding a
single wire hands that wire over rather than starting a second one, so you can
walk a line from one component to another in one gesture. Drop it on empty
canvas or press ++esc++ to leave it where it was; hold ++alt++ to draw a new
wire from an occupied terminal instead.

### Align, distribute, flip

With several symbols selected, **Arrange → Align** lines up their left
edges, centres, right edges, tops, middles or bottoms, and **Arrange →
Distribute** spaces three or more evenly, keeping the outermost two where
they are. **Flip horizontally** (++shift+h++) mirrors a symbol — a relay's
device bubble, a regulator's arrow or a three-winding transformer's tertiary
moves to the other side, and the numbers inside stay readable — and **Flip
vertically** (++shift+v++) turns it upside down. Each is one undo step.
**Edit → Find** (++ctrl+f++) jumps to an element by part of its name.

### Split a line

Right-click a line and choose **Split line here** to put a new bus in it at
that point — somewhere to hang a tap, a load or a recloser mid-feeder. The
line becomes two, with its length divided in proportion to where you clicked
along the drawn line and every other setting (conductor, phases, phasing)
kept on both halves. **Arrange → Split line** splits the selected line
halfway. Undo puts the line back whole.

### Clean up

**Arrange → Clean up layout** (++ctrl+shift+l++) redraws the whole circuit as a top-down tree:
the source at the top, power flowing downward, every load, capacitor and DER
unit in one evenly spaced row directly beneath its busbar, each bar widened
to fit everything leaving it, a bank of single-phase regulators fanned out
side by side instead of stacked, and lines bent below the load row so they
never run through a load. Rotations are reset and routing points redrawn.
It runs on every `.dss` import; on a drawing you arranged by hand it is one
undo step away (++ctrl+z++).

A bus that only joins two lines — most buses on an imported feeder — is
drawn **compact**: a short bar without its name, so a long feeder is not a
ladder of labels (hover it for the name, or untick *Compact* in its
properties). **Arrange → Layout direction → Left to right** lays the next
clean-up across the page instead, series devices on their side, which suits
a long rural feeder.

**Arrange → Layered layout with routed wires** is the alternative: the
Eclipse Layout Kernel's layered engine places the circuit by the same rules
and also routes every line around the symbols in right angles. It loads the
first time you use it. Clean up stays the default, and the one imports use.

### Editing many elements at once

Select more than one element — box-select on the canvas, ++ctrl++-click, or
one of the picks below — and the properties panel becomes **Edit N
elements**. It shows the settings every selected type shares; a value you
enter applies to all of them, and a setting that differs between them reads
*(mixed)* until you set it. A number also takes a relative edit: `×1.1` or
`/2` scales each element's own value, `+5` or `-5` shifts it, `=-5` sets a
negative number. One undo reverts the whole edit.

Ways to pick the elements:

- **Right-click** a bus, line or device → **Select everything downstream**
  picks the whole lateral it feeds. **Select all loads** (or whichever type
  you clicked) picks every one in the circuit, and **Select all loads on
  phase B** narrows that to a phase.
- A mixed selection shows a chip per type at the top of the panel; click one
  to keep only that type. The same choice is in the right-click menu.
- The **Elements** tab has a filter box: a bare word matches names, and
  `kw>100`, `kv=4.16`, `model!=1` or `loadshape:day` test a setting (several
  terms, all must hold). **Select matching** turns the rows into the canvas
  selection, and rows that are selected on the canvas are highlighted, so the
  table and the diagram always agree.

The table's fill handle (drag the corner of a cell down through other rows)
is still there for the case where the rows you want are neighbours.
