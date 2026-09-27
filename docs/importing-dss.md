---
description: Open an existing OpenDSS model in OpenDSS Designer: import .dss files with redirects, get an automatic one-line layout, and see what is and is not supported.
---

# Importing existing DSS files

If you already have OpenDSS models, you don't have to redraw them. **Import**
reads `.dss` files and turns them into an editable one-line diagram.

## How to import

1. Choose **File → Import .dss…**.
2. Select your **main** `.dss` file *plus* any files it `redirect`s to
   (linecode libraries, load definitions, bus coordinate files — select them
   all together in the file dialog).
3. The circuit appears laid out as a top-down tree: source at the top, loads
   in a row beneath their buses, buses sized to fit. It is the same layout
   **Arrange → Clean up layout** applies (in the direction set under
   **Arrange → Layout direction**), so you can always get back to it.
   From there it's a normal project — edit, solve, save as `.oneline.json`,
   or re-export.

## How it works

Rather than re-implementing a DSS parser, the importer hands your files to
**OpenDSS's own parser** (via OpenDSSDirect.py), compiles the circuit, and
reads the resulting model back out element by element. That means anything
OpenDSS itself accepts — abbreviations, mixed case, line continuations — is
understood, and the parameters you see are the values OpenDSS actually used.

## Supported elements

Import maps `Vsource`, `Line` and `LineCode` (a line keeps its code, matrix
and all; a line built from a `LineGeometry` gets a code named after the
geometry, and one that wrote its own matrix gets a code of its own name),
`Transformer` (two or three
windings; a transformer with a `RegControl` becomes a regulator), switches
(a `Line` with `switch=yes`; one operated by a `Fuse`, `Recloser` or
overcurrent `Relay` becomes that device), `Load`, `Capacitor`, `Generator`,
`PVSystem`, `Storage`, `LoadShape` and `TCC_Curve` onto diagram elements.

## Everything else: passthrough elements and comments

Anything else in the file — monitors, energy meters, capacitor and inverter
controls, XY curves, reactors, a four-winding transformer — is **kept as the
file wrote it**, in the order it was defined, and listed in the
**Passthrough** tab. It is written back on export, and it runs in every solve
after the elements on the drawing, so a `CapControl` still switches its
capacitor and a `Reactor` still grounds its bus. The tab lets you read, edit
or delete each one, or type in one of your own.

A few things keep a passthrough element out of the solve (it is still
exported, and the Problems list says why):

- it refers to something that is no longer in the circuit — a monitor on a
  line you deleted. Renaming an element in the editor rewrites the
  references to it, so a rename never causes this. On export the element is
  written commented out, so the file still compiles;
- it reads a file (`mult=(file=...)`, `csvfile=`), which the server does not
  have;
- it is of a class outside a short list of measurement, control, curve and
  simple circuit objects, or it is anything other than `New` and `Edit`
  lines naming itself — a passthrough element is data, never a script;
- the engine rejects it when the solve runs.

**Comments** come through too: the comment lines directly above an element,
and a comment at the end of its line, are written back above it on export,
and the comments at the top of the main file stay at the top.

!!! note
    Round-tripping is a design goal: export the imported circuit and you get a
    `.dss` file that solves to the same result. The [validation page](validation.md)
    measures it on the IEEE test feeders, which come back within 0.00002 pu at
    every bus. If you find a model that doesn't survive the round trip, please
    [open an issue](https://github.com/rsparks3/opendss-designer/issues) —
    ideally with the `.dss` files attached.
