# Adding a new element type

Checklist for adding a component to the palette (as done for `capacitor` and
`generator` in M3 — diff those commits for a worked example). Items marked ⚡
break loudly if forgotten (schema-drift tests); the rest fail quietly, so walk
the whole list.

## Backend (`src/opendss_designer/`)

1. ⚡ `core/model.py` — add the type to the `NodeType` literal and its handles
   to `NODE_TERMINALS` (skip `NODE_TERMINALS` only for dynamic-handle nodes
   like busbar).
2. `core/compiler.py` — emission block in `compile_circuit`: filter nodes by
   type, build the `new <class>.<name> ...` command via `element_name()` (which
   registers the element_map entry for results/issue mapping), use
   `conn.node_buses[n.id]` + `_bus_suffix` for bus connections, and
   `kv_bases.add()` any rated kV.
3. `core/importer.py` — add the OpenDSS class prefix to `SUPPORTED_PREFIXES`
   and a read-back block in `_read_model_back` (iterate `dss.<Class>.First()/
   Next()`, preserve `busNodes` suffixes, `wire()` terminals to `busbar_for()`).
4. `core/validate.py` — extend the kV-consistency check if the element declares
   a voltage; add any element-specific structural checks.

## Frontend (`frontend/src/`)

5. ⚡ `types/circuit.ts` — add to the `NodeType` union (mirror of model.py).
6. `lib/defaults.ts` — `defaultParams()` case (name prefix + sensible params)
   and `NODE_SIZE` entry.
7. `lib/fields.tsx` — `FIELDS` entry; drives both the properties panel and the
   spreadsheet tab.
8. `components/nodes/<X>Node.tsx` — symbol component: use `useSymbolRotation`,
   `rotatedBox`, `SymbolSvg`, `rotatePosition` from `nodes/common.tsx` so
   rotation works; add `VoltageBadge` (bus-connected) or `ElementBadge`
   (series/shunt with element results).
9. `components/EditorCanvas.tsx` — register in `nodeTypes` and add a letter to
   `PLACE_KEYS`.
10. `components/Palette.tsx` — palette item with icon + the same `kbd` letter.
11. `lib/layout.ts` — if it's a 1-terminal shunt device, add it to
    `SHUNT_TYPES` so imports hang it under its busbar; 2-terminal series
    devices need `orientedEdges` / `alignDevicesBetweenBuses` handling.
12. `store/circuitStore.ts` — add the name prefix to `NAME_PREFIX`
    (copy/paste renaming).

## Tests

13. ⚡ `tests/fixtures/full-circuit.oneline.json` — add a wired, solvable
    instance of the element. `test_schema_fixture.py::
    test_fixture_covers_every_type` fails until you do; the same fixture
    drives the frontend round-trip test and the e2e solve test.
14. `tests/test_schema_fixture.py` — add the expected `new <class>.<name>`
    fragment to `test_fixture_compiles_cleanly`.
15. `tests/test_import_roundtrip.py` — extend the round-trip coverage.

Then: `pytest`, `npm test`, `npm run e2e`, and update `FUTURE_IMPROVEMENTS.md`.
