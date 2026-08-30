# Future Improvements

Roadmap of features intentionally deferred from v1, roughly in priority order.

## New components (palette)

- **Capacitor banks** (`Capacitor`) — shunt kvar, delta/wye, switched steps
- **Generators** (`Generator`) — kW/kvar or PV-mode, with the classic circle-G symbol
- **PV systems** (`PVSystem`) — irradiance/temperature curves, inverter kVA
- **Storage** (`Storage`) — kWh rating, charge/discharge dispatch
- **Voltage regulators** (`RegControl` on an autotransformer) — band, PT ratio, LDC settings
- **3-winding transformers** — third handle, per-winding editor already generalizes
- **Fuses, reclosers, relays** (`Fuse`, `Recloser`, `Relay`) — protection modeling
- **Line codes** (`LineCode`) — impedance libraries instead of per-line R/X entry, with a
  built-in library of common conductors
- **Explicit grounding elements** (`Reactor` to ground, grounding transformer symbols)

## Analysis

- **Fault study** (`solve mode=faultstudy`) — short-circuit MVA / fault currents displayed
  at each bus; single-phase and three-phase faults
- **Time series** (daily/yearly modes) — `LoadShape` editor, result plots over time,
  energy meters and monitors; likely needs a websocket for progress streaming
- **Voltage profile plot** — distance-vs-voltage chart along a feeder path
- **Losses breakdown** panel per element
- **Incremental solve** — reuse the compiled circuit when only parameter values changed
  (matters once circuits reach thousands of elements; v1 rebuilds every solve)

## Editor UX

- **Copy/paste** and duplicate (Ctrl+C/V/D), multi-select property editing
- **Split line**: drop a bus in the middle of an existing Line edge
- **Rotate symbols** (R key) for horizontal feeder layouts
- **Automatic wire routing**: obstacle avoidance (libavoid/elkjs edge routing) — manual
  waypoints exist today; auto-routing would keep runs tidy without them
- **Finer undo granularity**: the 300 ms history throttle groups rapid distinct actions
  (e.g. a toggle plus a placement) into one undo step; group per gesture instead
- **Right-click context menus** (open/close breaker without the properties panel)
- **Per-phase display**: phase labels on wires, per-phase voltage readouts (the backend
  already returns per-node arrays; the UI shows the min)
- **Phase pinning**: connect 1-phase elements to a chosen phase (`.2`, `.3` bus suffixes)
- **Result tooltips** on hover with full detail (per-phase V, angles, currents, powers)
- **Dark mode**, printable/exportable diagram (SVG/PNG export)
- **Keyboard palette shortcuts** (S=source, B=busbar, T=transformer…)

## Interop & platform

- **Smarter .dss import layout**: recognize feeder trees, keep 2-terminal pass-through
  buses as plain wires instead of busbars, elkjs layered layout
- **Import more elements** (everything listed under New components)
- **Round-trip preservation** of comments and unsupported elements on export
- **Project autosave** to browser storage + File System Access API for in-place saves
- **Playwright end-to-end tests** for the editor; vitest component tests
- **Multi-circuit tabs**; compare two scenarios side by side
