# Importing existing DSS files

If you already have OpenDSS models, you don't have to redraw them. **Import**
reads `.dss` files and turns them into an editable one-line diagram.

## How to import

1. Click **Import** in the toolbar.
2. Select your **main** `.dss` file *plus* any files it `redirect`s to
   (linecode libraries, load definitions, bus coordinate files — select them
   all together in the file dialog).
3. The circuit appears with a hierarchical auto-layout: source at the top,
   loads hanging beneath their buses. From there it's a normal project — edit,
   solve, save as `.oneline.json`, or re-export.

## How it works

Rather than re-implementing a DSS parser, the importer hands your files to
**OpenDSS's own parser** (via OpenDSSDirect.py), compiles the circuit, and
reads the resulting model back out element by element. That means anything
OpenDSS itself accepts — abbreviations, mixed case, line continuations — is
understood, and the parameters you see are the values OpenDSS actually used.

## Supported elements

Import currently maps `Vsource`, `Line` (with linecodes), `Transformer`,
switches, `Load`, `Capacitor`, and `Generator` onto diagram elements.

Anything else in the file (e.g. reactors, regulators, monitors) is **reported,
not silently dropped**: the import completes and lists the unsupported
elements so you know exactly what was left out.

!!! note
    Round-tripping is a design goal: export the imported circuit and you get a
    `.dss` file that solves to the same result. If you find a model that
    doesn't survive the round trip, please
    [open an issue](https://github.com/rsparks3/opendss-designer/issues) —
    ideally with the `.dss` files attached.
