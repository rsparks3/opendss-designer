"""Runtime configuration, read from the environment.

The app ships as a localhost single-user tool and that is the default: in
``local`` mode every limit below is ``None``, so a pip-installed user gets
exactly the behavior they had before any of this existed. ``demo`` mode turns
on the caps needed to expose the app to the public internet.

Environment rather than CLI arguments is the primary channel because
``cli.py`` hands uvicorn an import string -- the app is built by importing the
module, so an argparse namespace cannot reach it. Env is also what containers
and PaaS platforms speak. The CLI flags are thin setters over the same vars.

Deliberately no ``pydantic-settings`` dependency: the package has four runtime
requirements and that leanness is worth keeping for a scientific tool.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, fields
from pathlib import Path

LOCAL = "local"
DEMO = "demo"

# Caps that apply in demo mode. Sized so the bundled samples and a realistically
# sized teaching feeder fit comfortably, while a single visitor cannot exhaust
# the container. Every one is individually overridable by env var.
_DEMO_LIMITS: dict[str, object] = {
    "max_body_bytes": 8 * 1024 * 1024,
    "max_nodes": 2_000,
    "max_edges": 4_000,
    "max_shapes": 32,
    "max_shape_points": 35_040,        # a 15-minute year, the largest NREL profile
    "max_total_shape_points": 350_000,
    "max_import_files": 20,
    "max_import_bytes": 2 * 1024 * 1024,
    "max_queued_engine_calls": 4,
    "engine_result_timeout_s": 120.0,
    "timeseries_timeout_s": 180.0,
    "max_timeseries_cost": 3_000_000,  # steps x (elements + buses)
    "max_concurrent_timeseries": 2,
    "nrel_cache_bytes": 4 * 1024**3,
    "nsrdb_cache_bytes": 1024**3,
    "shape_cache_bytes": 256 * 1024 * 1024,
    "max_outbound_bytes": 64 * 1024 * 1024,
    "geocode_per_minute": 30,
    "fetch_per_hour": 20,
    "idle_timeout_s": 1800.0,
}


def _env_bool(env: dict, key: str, default: bool) -> bool:
    raw = env.get(key)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_num(env: dict, key: str, default, cast):
    raw = env.get(key)
    if raw is None or not raw.strip():
        return default
    try:
        value = cast(raw.strip())
    except (TypeError, ValueError):
        return default
    # 0 disables a limit, which is how an operator opts out of one cap.
    return None if value <= 0 else value


@dataclass(frozen=True)
class Settings:
    mode: str = LOCAL
    host: str = "127.0.0.1"

    # None everywhere means "no limit"; that is the local default.
    max_body_bytes: int | None = None
    max_nodes: int | None = None
    max_edges: int | None = None
    max_shapes: int | None = None
    max_shape_points: int | None = None
    max_total_shape_points: int | None = None
    max_import_files: int | None = None
    max_import_bytes: int | None = None
    max_queued_engine_calls: int | None = None
    engine_result_timeout_s: float | None = None
    timeseries_timeout_s: float | None = None
    max_timeseries_cost: int | None = None
    max_concurrent_timeseries: int | None = None
    nrel_cache_bytes: int | None = None
    nsrdb_cache_bytes: int | None = None
    shape_cache_bytes: int | None = None
    max_outbound_bytes: int | None = None
    geocode_per_minute: int | None = None
    fetch_per_hour: int | None = None
    idle_timeout_s: float | None = None

    workdir: Path = Path(tempfile.gettempdir()) / "opendss_designer"
    cache_dir: Path | None = None  # defaults to workdir; share it across sessions

    @property
    def demo(self) -> bool:
        return self.mode == DEMO

    @property
    def effective_cache_dir(self) -> Path:
        return self.cache_dir or self.workdir

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        mode = (env.get("OPENDSS_DESIGNER_MODE") or LOCAL).strip().lower()
        if mode not in (LOCAL, DEMO):
            mode = LOCAL

        values: dict[str, object] = {"mode": mode}
        base = _DEMO_LIMITS if mode == DEMO else {}
        casts = {f.name: f.type for f in fields(cls)}

        for name, demo_default in _DEMO_LIMITS.items():
            default = base.get(name)
            cast = float if "float" in str(casts.get(name, "")) else int
            values[name] = _env_num(
                env, f"OPENDSS_DESIGNER_{name.upper()}", default, cast)

        values["host"] = (env.get("OPENDSS_DESIGNER_HOST") or "127.0.0.1").strip()

        workdir = env.get("OPENDSS_DESIGNER_WORKDIR", "").strip()
        if workdir:
            values["workdir"] = Path(workdir)
        elif mode == DEMO:
            # One process per session: never share a scratch dir, or two
            # containers collide on identically named loadshape side files.
            values["workdir"] = Path(tempfile.mkdtemp(prefix="opendss_designer_"))
        else:
            values["workdir"] = Path(tempfile.gettempdir()) / "opendss_designer"

        cache_dir = env.get("OPENDSS_DESIGNER_CACHE_DIR", "").strip()
        # Downloaded NREL/NSRDB data is public and keyed only by what was asked
        # for, so a deployment can point every session at one shared volume
        # instead of re-fetching 10-30 MB files per visitor.
        values["cache_dir"] = Path(cache_dir) if cache_dir else None

        return cls(**values)  # type: ignore[arg-type]


settings = Settings.from_env()


def reload_settings(env: dict[str, str] | None = None) -> Settings:
    """Re-read the environment, updating the shared object *in place*.

    Modules do `from ..settings import settings`, which binds the object, not
    the name -- rebinding this module's global would leave every one of them
    holding the old instance. Mutating the existing object keeps every holder
    correct. Values captured at import time from a field (engine.WORKDIR, the
    admission semaphore) are fixed for the process either way; in a real
    deployment the environment is set before the process starts.
    """
    fresh = Settings.from_env(env)
    for f in fields(Settings):
        object.__setattr__(settings, f.name, getattr(fresh, f.name))
    return settings
