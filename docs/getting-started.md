# Getting started

## Install

OpenDSS Designer is a Python package; it needs Python 3.10 or newer.

```bash
pip install opendss-designer
opendss-designer
```

This starts a local web server and opens the editor in your browser. Useful
flags: `--port 8721` (it picks the next free port if busy) and `--no-browser`.

The app is fully local: the server binds to `127.0.0.1`, and your circuits
never leave your machine.

!!! tip "Try the demo circuit"
    Click **Open** and load
    [`examples/demo-substation.oneline.json`](https://github.com/rsparks3/opendss-designer/tree/main/examples)
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

## Save, export, import

- **Save/Open** stores the whole project (diagram + parameters) as a
  `.oneline.json` file.
- **Export** writes a runnable `.dss` script — the exact commands the built-in
  solver uses — so anything you draw also runs in stock OpenDSS.
- **Import** loads existing `.dss` files; see
  [Importing DSS files](importing-dss.md).

## Editor essentials

|  |  |
|---|---|
| Undo / redo | ++ctrl+z++ / ++ctrl+y++ |
| Copy / paste | ++ctrl+c++ / ++ctrl+v++ |
| Delete selection | ++delete++ |
| Stop placing | ++esc++ |

Plus: grid snapping, pan/zoom with a minimap, box-select and group-move,
right-click context menu, rotation, and double-click actions — double-click a
breaker to open/close it, or a wire/line to add a draggable routing point.

To move a connection, drag the terminal it sits on: a terminal holding a
single wire hands that wire over rather than starting a second one, so you can
walk a line from one component to another in one gesture. Drop it on empty
canvas or press ++esc++ to leave it where it was; hold ++alt++ to draw a new
wire from an occupied terminal instead.
