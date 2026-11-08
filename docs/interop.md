---
description: Interoperability in OpenDSS Designer — CIM (IEC 61968-13) import and export, MultiSpeak network-model import, results to GIS as GeoJSON, CSV and KML, and the power-quality studies (harmonics, rapid voltage change).
---

# Interoperability and power quality

## CIM

**File → Import from → CIM (IEC 61968-13 RDF/XML)…** reads a CIM100 /
CDPSM document: buses from `ConnectivityNode` and `Terminal`,
`ACLineSegment` with its own impedance or a `PerLengthSequenceImpedance`
/ `PerLengthPhaseImpedance` (which becomes a line code), `EnergyConsumer`
and its phases, `EnergySource`, `PowerTransformer` in the end form or the
tank form with a `RatioTapChanger` as a regulator control, breakers,
disconnectors, load-break switches, fuses, reclosers and sectionalisers,
`LinearShuntCompensator`, `PowerElectronicsConnection` with photovoltaic
or battery units, `SynchronousMachine`, and `Location` / `PositionPoint`
coordinates with the `CoordinateSystem`. It is turned into OpenDSS text
and goes through the ordinary importer, so the notes it leaves are the
importer's. **File → Export → CIM** writes the same classes from the
drawing.

## MultiSpeak

**File → Import from → MultiSpeak network model…** reads the co-operative
utilities' exchange format (versions 3 and 4 as WindMil and most co-op
GIS products write it): overhead and underground line sections,
transformer banks, switches, fuses, reclosers, sectionalizers, capacitor
banks, substations and meters, joined by their section and parent-section
ids, with GPS coordinates. Field names are matched case-insensitively and
by common synonyms. Conductor types are kept as comments and the line
impedances are typical values until a line code is assigned. The reader
was written from the specification and checked against a synthetic
sample only; a real export is wanted to confirm it.

## Results to GIS

**File → Export → Results to GIS** writes every bus and line that has
coordinates with what the last studies said about it — voltage, loading,
power, losses, hosting capacity and its binding criterion, reliability
section, phases — as **GeoJSON** (points and line strings in the
project's coordinate system), **CSV** or **KML** (which expects WGS84 and
says so when the project is not). It is how a hosting-capacity map or a
voltage map gets into a utility's GIS or onto a public page.

## Power quality

**Studies → Power quality** runs the **harmonic** study: the circuit is
solved at each harmonic order in turn (`mode=harmonics`), every load,
generator and PV system injecting by its spectrum (the engine's defaults
unless a project spectrum is named through a passthrough `Spectrum`), and
the voltage THD at every bus with the worst single harmonic is held to
IEEE 519 (5 % THD and 3 % individual below 69 kV). And **rapid voltage
change**: the voltage step at every bus when a motor starts (a
locked-rotor load at a low power factor, switched on) or a DER unit trips,
against the IEEE 1453 / 1547-2018 limit (3 % by default).

## Python API and command line

Every study is a function of a `Circuit` and an options dict in
`opendss_designer.studies` (`run_study(name, circuit, options)`; `STUDIES`
lists them), the same code the REST routes call, so a script or the
desktop app runs them in-process. `opendss-designer run` runs them from
the shell on a saved project; see [the API page](api.md). The REST routes
are documented live at `/docs` on a running server.

## What has been checked

`tests/test_m17.py` holds: a hand-written CIM sample with every supported
class imports and solves with the expected elements, impedances and
coordinates; the schema fixture exported to CIM and imported back keeps
its loads, lines and transformers and draws the same power within 10 %; a
MultiSpeak sample imports with its devices, open switch, service
transformer and coordinates and solves; the harmonic study reports a THD
and a spectrum at every bus; a DER trip and a motor start give voltage
steps of the right sign; and the `run` command writes the studies' JSON.
