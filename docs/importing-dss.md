---
description: Open an existing model in OpenDSS Designer - OpenDSS .dss files with redirects, GIS layers and CSV tables, or CYME and Synergi models - and see what is and is not carried across.
---

# Importing models

Nobody draws a utility feeder by hand. **File → Import .dss…** reads an
OpenDSS model; **File → Import from** reads GIS layers and CSV tables, and,
with the converter plugin, CYME and Synergi models.

## OpenDSS files

1. Choose **File → Import .dss…**.
2. Select your **main** `.dss` file *plus* any files it `redirect`s to
   (linecode libraries, load definitions, bus coordinate files — select them
   all together in the file dialog). Selecting a whole folder is fine: the
   importer follows the redirects from the file that defines the circuit,
   leaves out files that are not part of it, and says so if the folder holds
   two masters (a balanced and an unbalanced case, say).
3. The circuit appears laid out as a top-down tree: source at the top, loads
   in a row beneath their buses, buses sized to fit. It is the same layout
   **Arrange → Clean up layout** applies (in the direction set under
   **Arrange → Layout direction**), so you can always get back to it.
   From there it's a normal project — edit, solve, save as `.oneline.json`,
   or re-export. If the file has bus coordinates, **Map** on the toolbar
   shows it on the ground (see [The map](map.md)).

### How it works

Rather than re-implementing a DSS parser, the importer hands your files to
**OpenDSS's own parser** (via OpenDSSDirect.py), compiles the circuit, and
reads the resulting model back out element by element. That means anything
OpenDSS itself accepts — abbreviations, mixed case, line continuations — is
understood, and the parameters you see are the values OpenDSS actually used.

### Supported elements

Import maps `Vsource`, `Line` and `LineCode` (a line keeps its code, matrix
and all; a line built from a `LineGeometry` gets a code named after the
geometry, and one that wrote its own matrix, or named a code with a different
phase count, gets a code of its own name), `Transformer` (two or three
windings, with their taps, no-load loss, magnetising current and per-winding
resistance; an equal-ratio transformer with a `RegControl` becomes a
regulator, while a controlled transformer that changes voltage — a substation
LTC — stays a transformer and keeps its control), switches (a `Line` with
`switch=yes`; one operated by a `Fuse`, `Recloser` or overcurrent `Relay`
becomes that device), series `Reactor`s (drawn as a line, written back as a
reactor), `Load` (with its CVR or ZIP coefficients), `Capacitor`, `Generator`,
`PVSystem`, `Storage`, `LoadShape` and `TCC_Curve` onto diagram elements.

Three things about real feeders are carried across too:

- **Elements the file disabled** (`enabled=no` — open ties, spare
  connectors) are drawn dashed and out of service. Tick *In service* in the
  properties panel to put one back.
- **The file's voltage bases** (`set voltagebases=[...]`) are kept, under
  **File → Project properties**, so every bus reads in per unit against the
  base the file chose. Without them a 120/240 V service would read 1.73 pu.
- **Bus coordinates** (`BusCoords`, `LatLongCoords`) are kept exactly as the
  file gave them, and written back on export as `SetBusXY`.

The [validation page](validation.md) measures all of this: the IEEE 13, 34,
37 and 123-bus feeders and EPRI's ckt5, ckt7, ckt24 and the IEEE 8500-node
feeder import and solve to within 0.0002 pu of OpenDSS's own solution of
the original files.

### Large feeders

A circuit of more than about 1,500 elements is drawn more sparingly so that
it stays quick: zoomed out, it is an **overview** — every line and bus on one
canvas, coloured by the overlay that is on — and the symbols appear as you
zoom in, only those in view. **Clean up** lays such a circuit out as a tidy
tree, the trunk running straight down and laterals branching off either
side. A 10,000-element feeder imports, lays out and draws in about two
seconds and solves in about one.

### Everything else: passthrough elements and comments

Anything else in the file — monitors, energy meters, capacitor and inverter
controls, XY curves, a shunt reactor, a four-winding transformer — is **kept
as the file wrote it**, in the order it was defined, and listed in the
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

## GIS layers and CSV tables

**File → Import from → GIS layers or CSV tables…** reads Esri shapefiles
(select the `.shp`, `.dbf` and `.prj` together, or a `.zip` of them),
GeoJSON and CSV. For each layer:

1. **Say what it is**: a line (conductor) layer, switches, fuses, reclosers,
   transformers, loads, capacitors, generators, PV, storage, the source
   (substation), a table of line codes or a table of bus coordinates. The
   class is guessed from the layer's name.
2. **Say which column holds what.** Columns are matched to properties by
   name, including the names GIS exports commonly use (`FACILITYID`,
   `PHASE`, `KVA_RATING`, `NORMALSTATUS`…). Any property can instead be given
   one value for the whole layer — every load at 0.24 kV, say — and anything
   left blank takes the default shown. The mapping is remembered, so the
   next export of the same layer imports in one click.

Where the tables have **bus columns** (from/to bus, or a load's bus), they
decide the connections. Where they do not, as in most GIS exports, the
**geometry** does:

- line ends closer than the **snap tolerance** are one bus;
- a device drawn as a point attaches to the nearest bus within the **attach
  radius**, a customer preferring a transformer's secondary; a load layer can
  also name its transformer in a column;
- a switch, fuse, recloser or transformer drawn as a point is inserted where
  it stands, with everything downstream of it — away from the source — moved
  to its far side.

Single-phase transformers and loads recorded at the system's line-to-line
voltage are rated line-to-neutral; lines with no impedance and no line code
get typical overhead values. All of it is reported, along with anything
left out or not connected to the source (usually a snap tolerance too tight
for line ends that nearly meet). The layers' coordinate system comes with
them — a shapefile's `.prj`, or WGS 84 for GeoJSON — so the result appears
on the map.

What the import builds is an ordinary OpenDSS model, read by the same
importer as a `.dss` file; **File → Export → OpenDSS (.dss)** writes it out
for use anywhere else.

## CYME and Synergi

**File → Import from → CYME… / Synergi…** convert those tools' models with
**opendss-designer-convert**, an optional plugin (a revived fork of NREL's
DiTTo, BSD-licensed, kept in its own repository because of its GIS-sized
dependencies). Install it beside the app — Python 3.11 or later:

```
pip install opendss-designer-convert
```

then restart OpenDSS Designer. Without it the menu says how to get it. For
CYME, select the network, equipment and load exports together; for Synergi,
the model's `.mdb` and its warehouse `.mdb`. The converted model is imported
like a `.dss` file, with the converter's notes (what it could not carry
across) in the import message.

Verified so far against the converter's own samples: CYME 5.04 and 8.00
exports of the IEEE 13 and 123-bus feeders, and one Synergi Electric 6.4
model. WindMil is not yet supported.

!!! note
    Round-tripping is a design goal: export the imported circuit and you get a
    `.dss` file that solves to the same result. If you find a model that
    doesn't survive the round trip, please
    [open an issue](https://github.com/rsparks3/opendss-designer/issues) —
    ideally with the files attached.
