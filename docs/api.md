---
description: Running OpenDSS Designer's studies from Python or the command line — the studies package, run_study, the opendss-designer run command and the REST routes.
---

# Python API and command line

The studies are plain functions over the circuit document, and the
browser is only one way to call them.

## From the shell

```bash
opendss-designer run --list
opendss-designer run feeder.oneline.json --study solve --study qa --out results.json
opendss-designer run feeder.oneline.json --study hosting-capacity \
    --options '{"method": "sensitivity", "criteria": {"deviation": false}}'
opendss-designer run feeder.dss --study reliability --level "Minimum daytime" --scenario sc1
```

`run` takes a saved project (`.oneline.json`) or a `.dss` file, runs the
named studies and writes one JSON object keyed by study name (to `--out`,
or stdout). `--scenario` and `--level` pick the scenario id and load
level; `--options` is JSON, keyed by study name when several studies run.
`--list` names every study with its options.

## From Python

```python
import json
from opendss_designer.core.model import Circuit
from opendss_designer.studies import STUDIES, run_study

circuit = Circuit.model_validate(json.load(open("feeder.oneline.json")))
hc = run_study("hosting-capacity", circuit, {"method": "sensitivity"})
for bus, r in sorted(hc["buses"].items(), key=lambda kv: kv[1]["kw"]):
    print(bus, r["kw"], r["binding"])
```

`STUDIES` maps each name to `(help, function)`. The functions and their
options are the modules of `opendss_designer.studies`: `hosting_capacity`,
`screening`, `faults`, `contingency`, `voltvar`, `balancing`, `capacity`,
`secondary`, `allocation`, `protection_depth`, `harmonics`, `batch`, and
the core studies `engine.solve`, `engine.fault_study`,
`engine.solve_timeseries`, `protection.tcc_study`,
`reliability.reliability_study`, `qa.qa_report`. Scenarios and load levels
are applied by `studies.effective_circuit`, or by setting `activeScenario`
and `activeLevel` on the circuit, as `run` does.

The engine is a process-wide singleton: every study runs on one engine
thread, so call them from one thread at a time. A long study accepts a
`progress(done, total, message)` callback and a `threading.Event` to
cancel.

## REST

A running server documents its routes at `/docs` (OpenAPI). The long
studies are jobs: `POST /api/jobs/<study>` answers with a job id,
`GET /api/jobs/<id>/events` streams progress and the result as
server-sent events, `GET /api/jobs/<id>` reads it back, `DELETE` cancels.
`GET /api/studies` lists the study names.
