# OpenDSS Designer

**OpenDSS Designer is a free, open-source graphical user interface (GUI) for
[OpenDSS](https://www.epri.com/pages/sa/opendss)**, EPRI's distribution system
simulator. Draw a substation-style one-line diagram in your browser — the
drawing *is* the circuit model — then run a power flow and see bus voltages,
element loading, and violations directly on the diagram.

![OpenDSS Designer: a solved one-line diagram with voltage and loading overlays](screenshot.png)

## Why

OpenDSS is a superb solver with a famously austere front end. If you have ever
wished you could *draw* a feeder instead of scripting it — or hand OpenDSS to a
colleague who doesn't want to learn the DSS command language — this tool is for
you. It is built on [OpenDSSDirect.py](https://github.com/dss-extensions/OpenDSSDirect.py),
so every solve is the real OpenDSS engine, and everything you draw exports to a
plain `.dss` file you can run anywhere.

## Quick start

Requires Python 3.10+.

```bash
pip install opendss-designer
opendss-designer          # starts a local server and opens your browser
```

Everything runs locally on your machine — nothing is uploaded anywhere.

Head to [Getting started](getting-started.md) for a walkthrough, or the
[Feature tour](features.md) for everything the editor can do.

## Highlights

- **Draw the circuit**: click-and-place sources, busbars, transformers,
  breakers, loads, capacitors, and generators; drag between terminals to wire
- **Solve on the diagram**: snapshot power flow with per-bus voltage (pu),
  loading pie charts, power flows, color-coded violations, and total losses —
  or auto-solve on every edit
- **Import existing models**: open your current `.dss` files (with
  `redirect`s) and get an automatically laid-out diagram
- **Spreadsheet view**: bulk-edit every element in an Excel-style table with
  fill-down
- **Graphs**: plot solved results, e.g. voltage profiles along the feeder
- **Export**: a runnable `.dss` script, byte-for-byte the same commands the
  built-in solver uses

## Open source

MIT-licensed, developed on
[GitHub](https://github.com/rsparks3/opendss-designer) — issues and pull
requests welcome. See [Development](development.md) to hack on it.
