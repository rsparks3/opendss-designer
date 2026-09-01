"""REST API for the designer frontend."""
from __future__ import annotations

import json
import logging
import queue
import threading
from typing import Literal

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from .. import __version__
from ..core import engine, importer, irradiance, linecodes, nrel
from ..core.compiler import export_dss
from ..core.model import Circuit
from ..core.ratelimit import RateLimited, TokenBucket
from ..core.validate import validate
from ..settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

_geocode_bucket = TokenBucket(settings.geocode_per_minute, 60.0, "place searches")
_fetch_bucket = TokenBucket(settings.fetch_per_hour, 3600.0, "data downloads")
# Long runs hold the engine for minutes; only so many may be in flight.
_timeseries_slots = threading.BoundedSemaphore(
    settings.max_concurrent_timeseries or 10_000)


@router.get("/health")
def health() -> dict:
    """Liveness plus what the client needs to explain the demo's limits.

    Deliberately does not touch the engine (engine.opendss_version is cached),
    so it still answers while a long solve is running.
    """
    out: dict = {"version": __version__,
                 "opendssVersion": engine.opendss_version(),
                 "mode": settings.mode}
    if settings.demo:
        out["limits"] = {
            "maxNodes": settings.max_nodes,
            "maxEdges": settings.max_edges,
            "maxShapes": settings.max_shapes,
            "maxShapePoints": settings.max_shape_points,
            "maxBodyBytes": settings.max_body_bytes,
        }
    return out


@router.get("/linecodes")
def line_codes() -> dict:
    """Conductor preset library from config/linecodes.csv (re-read each call
    so the user can edit the file without restarting the server)."""
    return linecodes.load_line_codes()


def _busy(exc: engine.EngineBusy) -> HTTPException:
    return HTTPException(status_code=503, detail=str(exc),
                         headers={"Retry-After": "5"})


@router.post("/solve")
def solve(circuit: Circuit) -> dict:
    try:
        return engine.solve(circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.post("/faultstudy")
def fault_study(circuit: Circuit) -> dict:
    try:
        return engine.fault_study(circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.post("/validate")
def validate_circuit(circuit: Circuit) -> dict:
    return {"issues": [i.model_dump() for i in validate(circuit)]}


@router.post("/export/dss", response_class=PlainTextResponse)
def export(circuit: Circuit) -> str:
    text, _issues = export_dss(circuit)
    return text


class TimeSeriesRequest(BaseModel):
    circuit: Circuit
    mode: Literal["daily", "yearly"] = "daily"
    stepMin: Literal[60, 15] = 60


@router.post("/timeseries")
def timeseries(req: TimeSeriesRequest) -> StreamingResponse:
    """Daily/yearly simulation with SSE progress. Events (JSON on `data:`
    lines): {"type":"progress",step,total} then one {"type":"result",result}
    or {"type":"error",message}. The engine runs in a worker thread (it holds
    the global engine lock for the whole run) and a queue decouples it from
    the response generator; a client disconnect closes the generator, whose
    `finally` sets the cancel event so the step loop exits within one step."""
    cost = engine.estimate_timeseries_cost(req.circuit, req.mode, req.stepMin)
    if settings.max_timeseries_cost and cost > settings.max_timeseries_cost:
        raise HTTPException(
            status_code=413,
            detail=f"This run is too large for the public demo "
                   f"({req.mode} at {req.stepMin} min on a circuit this size). "
                   "Try a daily run, an hourly step, or a smaller circuit — "
                   "or run OpenDSS Designer locally for the full model.")
    if not _timeseries_slots.acquire(blocking=False):
        raise HTTPException(
            status_code=503, headers={"Retry-After": "10"},
            detail="Another time-series run is already using the demo solver. "
                   "Try again in a moment.")

    # Bounded: a backgrounded or throttled browser tab stops reading, and an
    # unbounded queue would buffer every progress event for the whole run.
    q: queue.Queue = queue.Queue(maxsize=256)
    cancel = threading.Event()
    watchdog: threading.Timer | None = None
    if settings.timeseries_timeout_s:
        # The step loop already checks `cancel` every step, so a wall-clock
        # budget is just a timer pointed at the same flag.
        watchdog = threading.Timer(settings.timeseries_timeout_s, cancel.set)
        watchdog.daemon = True
        watchdog.start()

    def put(event: dict) -> None:
        try:
            q.put(event, timeout=5)
        except queue.Full:
            cancel.set()

    def worker() -> None:
        try:
            result = engine.solve_timeseries(
                req.circuit, req.mode, req.stepMin,
                progress_cb=lambda s, t: put(
                    {"type": "progress", "step": s, "total": t}),
                cancel=cancel)
            put({"type": "result", "result": result})
        except engine.EngineBusy as exc:
            put({"type": "error", "message": str(exc)})
        except (ValueError, importer.ImportFailure) as exc:
            # Known bad input: the message is written for the user.
            put({"type": "error", "message": str(exc)})
        except Exception:
            # A bug, not bad input. `str(exc)` here can carry filesystem paths
            # and library internals, so it stays server-side; the traceback
            # still reaches stderr via the logging added for deployment.
            logger.exception("Time-series run failed")
            put({"type": "error",
                 "message": "The time-series run failed unexpectedly. "
                            "Check the server log for details."})
        finally:
            try:
                q.put(None, timeout=5)  # sentinel: stream complete
            except queue.Full:
                pass

    threading.Thread(target=worker, daemon=True).start()

    def gen():
        try:
            while (ev := q.get()) is not None:
                yield f"data: {json.dumps(ev)}\n\n"
        finally:
            cancel.set()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.get("/nrel/meta")
def nrel_meta() -> dict:
    """Available NREL EULP products, climate zones, and building types."""
    return {"products": nrel.PRODUCTS}


class NrelFetchRequest(BaseModel):
    product: Literal["resstock", "comstock"]
    climateZone: str
    buildingType: str
    stepMin: Literal[60, 15] = 60
    normalize: Literal["peak", "average"] = "peak"


@router.post("/nrel/fetch")
def nrel_fetch(req: NrelFetchRequest) -> dict:
    """Fetch one aggregate profile (cached on disk) as a ready loadshape."""
    try:
        _fetch_bucket.take()
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    try:
        return nrel.fetch_profile(req.product, req.climateZone, req.buildingType,
                                  step_min=req.stepMin, normalize=req.normalize)
    except nrel.NrelError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/irradiance/geocode")
def irradiance_geocode(q: str) -> dict:
    """Place-name search for the irradiance fetcher (Open-Meteo geocoder)."""
    if len(q) > 200:
        raise HTTPException(status_code=400, detail="Search text is too long.")
    try:
        _geocode_bucket.take()
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    try:
        return {"results": irradiance.geocode(q)}
    except irradiance.IrradianceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


class IrradianceFetchRequest(BaseModel):
    lat: float
    lon: float
    apiKey: str
    email: str
    scaling: Literal["kwm2", "peak"] = "kwm2"
    label: str | None = None


@router.post("/irradiance/fetch")
def irradiance_fetch(req: IrradianceFetchRequest) -> dict:
    """Hourly 2018 GHI from the NLR NSRDB as a ready irradiance shape."""
    try:
        _fetch_bucket.take()
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    try:
        return irradiance.fetch_ghi(req.lat, req.lon, req.apiKey, req.email,
                                    scaling=req.scaling, label=req.label)
    except irradiance.IrradianceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


class DssFile(BaseModel):
    name: str = "file.dss"
    text: str = ""


class ImportRequest(BaseModel):
    """Typed so file count and size are bounded before anything is written."""
    files: list[DssFile] | None = None
    text: str | None = None


def _check_import_size(files: list[DssFile]) -> None:
    if settings.max_import_files and len(files) > settings.max_import_files:
        raise HTTPException(
            status_code=413,
            detail=f"Select at most {settings.max_import_files} files "
                   f"({len(files)} given).")
    if settings.max_import_bytes:
        for f in files:
            if len(f.text.encode("utf-8", "ignore")) > settings.max_import_bytes:
                mb = settings.max_import_bytes // (1024 * 1024)
                raise HTTPException(
                    status_code=413,
                    detail=f"'{f.name}' is larger than the {mb} MB per-file "
                           "limit for the public demo. Run OpenDSS Designer "
                           "locally for full-size feeders.")


@router.post("/import/dss")
def import_file(payload: ImportRequest = Body(...)) -> dict:
    files = payload.files
    if files is None:
        files = [DssFile(name="main.dss", text=payload.text or "")]
    _check_import_size(files)
    try:
        return importer.import_dss_files([f.model_dump() for f in files])
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc
    except importer.ImportFailure as exc:
        # Bad input (the importer wraps OpenDSS compile errors in ImportFailure);
        # anything else propagates as a 500 so genuine bugs aren't masked as 400s.
        raise HTTPException(status_code=400, detail=str(exc))
