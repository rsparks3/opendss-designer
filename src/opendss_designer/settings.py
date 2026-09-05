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

import dataclasses
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
class PlanInfo:
    """What a trusted proxy says about the caller's plan, for display only.

    The app never decides who is on which plan; it renders whatever strings it
    is handed and names the plan in its limit messages.
    """
    name: str
    message: str | None = None
    links: tuple[tuple[str, str], ...] = ()  # (label, url)

    @classmethod
    def from_payload(cls, raw: object) -> PlanInfo:
        if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
            raise BadLimitsHeader("plan must be an object with a string name")
        name = raw["name"].strip()[:40]
        if not name:
            raise BadLimitsHeader("plan.name is empty")
        message = raw.get("message")
        if message is not None:
            if not isinstance(message, str):
                raise BadLimitsHeader("plan.message must be a string")
            message = message.strip()[:200] or None
        links: list[tuple[str, str]] = []
        for link in raw.get("links") or ():
            if (not isinstance(link, dict) or not isinstance(link.get("label"), str)
                    or not isinstance(link.get("url"), str)):
                raise BadLimitsHeader("plan.links entries need label and url")
            url = link["url"].strip()
            # Rendered as an <a href>; only navigable web links are allowed.
            if not (url.startswith("https://") or url.startswith("/")):
                raise BadLimitsHeader("plan link urls must be https:// or a path")
            links.append((link["label"].strip()[:40], url[:500]))
        return cls(name=name, message=message, links=tuple(links[:4]))

    def as_dict(self) -> dict:
        return {"name": self.name, "message": self.message,
                "links": [{"label": l, "url": u} for l, u in self.links]}


class BadLimitsHeader(ValueError):
    """The trusted limits header was present but malformed. That is a bug in
    the proxy, so it is reported loudly rather than ignored."""


# The limits a trusted proxy may *tighten* per request (header key -> field).
# Everything not listed is either a process-wide pool (queue depth, the
# time-series slots, the fetch buckets, the caches) or fixed at startup
# (workdir, body size, which is enforced before routing).
REQUEST_LIMITS: dict[str, str] = {
    "maxNodes": "max_nodes",
    "maxEdges": "max_edges",
    "maxShapes": "max_shapes",
    "maxShapePoints": "max_shape_points",
    "maxTotalShapePoints": "max_total_shape_points",
    "maxImportFiles": "max_import_files",
    "maxImportBytes": "max_import_bytes",
    "maxTimeseriesCost": "max_timeseries_cost",
    "engineResultTimeoutS": "engine_result_timeout_s",
    "timeseriesTimeoutS": "timeseries_timeout_s",
}


@dataclass(frozen=True)
class Settings:
    mode: str = LOCAL
    host: str = "127.0.0.1"

    # Name of a request header carrying per-request limit overrides from a
    # trusted reverse proxy. Unset (the default) means no header is trusted,
    # so a local install cannot be talked into anything by a browser.
    trusted_limits_header: str | None = None
    # Present only on a per-request overlay built from that header.
    plan: PlanInfo | None = None

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
    def plan_label(self) -> str:
        """How limit messages refer to this configuration."""
        return f"the {self.plan.name} plan" if self.plan else "the public demo"

    def tightened(self, payload: dict) -> Settings:
        """A copy with the limits in `payload` applied, never loosening any.

        The process environment is the ceiling: it is what the operator sized
        the box for. A proxy may only ask for less, so a bug in the proxy
        cannot grant more than the worker was configured to allow. Values of
        zero or below mean "no opinion" (the env-var convention of 0 meaning
        "disable this cap" is deliberately *not* honoured here, because that
        would be loosening).
        """
        if not isinstance(payload, dict):
            raise BadLimitsHeader("limits header must be a JSON object")
        values: dict[str, object] = {}
        for key, field in REQUEST_LIMITS.items():
            raw = payload.get(key)
            if raw is None:
                continue
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise BadLimitsHeader(f"{key} must be a number")
            cast = float if field.endswith("_s") else int
            value = cast(raw)
            if value <= 0:
                continue
            current = getattr(self, field)
            values[field] = value if current is None else min(current, value)
        if payload.get("plan") is not None:
            values["plan"] = PlanInfo.from_payload(payload["plan"])
        return dataclasses.replace(self, **values)

    @property
    def effective_cache_dir(self) -> Path:
        return self.cache_dir or self.workdir

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        env = dict(os.environ if env is None else env)
        mode = (env.get("OPENDSS_DESIGNER_MODE") or LOCAL).strip().lower()
        if mode not in (LOCAL, DEMO):
            mode = LOCAL

        values: dict[str, object] = {"mode": mode}
        base = _DEMO_LIMITS if mode == DEMO else {}
        casts = {f.name: f.type for f in fields(cls)}

        for name in _DEMO_LIMITS:
            default = base.get(name)
            cast = float if "float" in str(casts.get(name, "")) else int
            values[name] = _env_num(
                env, f"OPENDSS_DESIGNER_{name.upper()}", default, cast)

        values["host"] = (env.get("OPENDSS_DESIGNER_HOST") or "127.0.0.1").strip()

        header = env.get("OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER", "").strip()
        values["trusted_limits_header"] = header.lower() or None

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
