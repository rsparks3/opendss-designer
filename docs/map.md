---
description: The geographic view in OpenDSS Designer - a circuit on a map at its bus coordinates, with OpenStreetMap or your own tiles, coordinate systems from State Plane to UTM, and results coloured on the ground.
---

# The map

**Map** on the toolbar (or **View → Map**) shows the circuit where its
coordinates put it, the way a utility planning tool's map does: lines along
their routes, buses as dots, each kind of device as a small mark where it
connects, loads and DER fanned out around their bus, over an OpenStreetMap
background. **One-line** goes back to the diagram. Both are views of the same
circuit; an edit in one is there in the other.

The overlays work on the map too: **Voltages** colours buses and the lines
leaving them, **Loading** colours lines by how loaded they are, **Phases** by
the phases they carry. Hover over anything for its results.

## What you can do there

- **Select** an element by clicking it (Shift-click adds to the selection)
  and edit it in the properties panel.
- **Move** a bus: select it, then drag it. One undo step puts it back.
- **Pan** by dragging the map, **zoom** with the wheel, **Fit** to see it all.

Placing and wiring new elements stays on the one-line, where the terminals
are.

## Where the coordinates come from

- A `.dss` file's `BusCoords` or `LatLongCoords`, kept exactly as written.
- GIS layers imported with **File → Import from → GIS layers or CSV tables**,
  which also bring each line's route.
- A model converted from CYME or Synergi, when the source model has them.

Anything without a coordinate of its own is placed from what it connects to:
a transformer or switch midway between its buses, a bus the file gave no
coordinate between the buses around it. The status line says how many
elements are on the map.

## Coordinate systems

Feeder models rarely use latitude and longitude. State Plane feet and UTM
metres are more usual, and the numbers alone do not say which. **File →
Project properties → Coordinate system** does:

- pick from the list — every NAD83 State Plane zone in feet and metres
  (including the HARN and 2011 realisations), UTM on NAD83 and WGS 84, and
  more — or type its EPSG code (`EPSG:2223`, or just `2223`);
- or paste a proj4 string or a WKT definition (a shapefile's `.prj` is one).

A `LatLongCoords` import is WGS 84 (`EPSG:4326`) automatically, and so is
GeoJSON; a shapefile brings its `.prj`. Coordinates with no system are
drawn on a plain grid, north up, with no background, and the map offers to
set one.

## The background

The **Map** selector on the map's toolbar chooses the tiles:

- **OpenStreetMap** (the default), credited in the corner as its licence asks;
- **Custom tiles…** — any XYZ tile URL, such as a satellite layer or your
  own utility's tile server, written as `https://…/{z}/{x}/{y}.png`
  (`{s}` picks a subdomain a, b or c);
- **None**.

The choice is remembered in this browser. Tiles are fetched by your browser
straight from the tile server; OpenDSS Designer's own server never sees
them.
