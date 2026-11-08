"""Planning studies over the OpenDSS engine.

Everything in this package takes a `Circuit` (the document the frontend
holds) and returns plain dicts, so the same code answers the browser app's
REST routes and runs in-process in the desktop app. Nothing here touches
HTTP, and nothing here calls the engine except through `core.engine`'s
entry points, which keep the one-engine-thread discipline.

Modules:

* `scenarios` -- the effective circuit of a scenario (base plus deltas) and
  the load level a solve runs at
* `batch` -- every scenario at every load level, summarised as a matrix
"""
from __future__ import annotations

from .registry import STUDIES, run_study
from .scenarios import apply_scenario, effective_circuit, level_named

__all__ = ["STUDIES", "apply_scenario", "effective_circuit", "level_named", "run_study"]
