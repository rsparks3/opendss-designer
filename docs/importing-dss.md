---
description: Open an existing OpenDSS model in OpenDSS Designer: import .dss files with redirects, get an automatic one-line layout, and see what is and is not supported.
---

# Importing existing DSS files

If you already have OpenDSS models, you don't have to redraw them. **Import**
reads `.dss` files and turns them into an editable one-line diagram.

## How to import

1. Click **Import** in the toolbar.
2. Select your **main** `.dss` file *plus* any files it `redirect`s to
   (linecode libraries, load definitions, bus coordinate files — select them
   all together in the file dialog).
3. The circuit appears laid out as a top-down tree: source at the top, loads
   in a row beneath their buses, buses sized to fit. It is the same layout
   **✦ Clean up** in the toolbar applies, so you can always get back to it.
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

Anything else in the file (e.g. reactors, monitors, line geometries) is
**reported, not silently dropped**: the import completes and lists the
unsupported elements so you know exactly what was left out.

!!! note
    Round-tripping is a design goal: export the imported circuit and you get a
    `.dss` file that solves to the same result. The [validation page](validation.md)
    measures it on the IEEE test feeders, which come back within 0.00002 pu at
    every bus. If you find a model that doesn't survive the round trip, please
    [open an issue](https://github.com/rsparks3/opendss-designer/issues) —
    ideally with the `.dss` files attached.
