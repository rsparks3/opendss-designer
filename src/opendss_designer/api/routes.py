"""REST API for the designer frontend."""

from __future__ import annotations

import base64
import binascii
import contextvars
import json
import logging
import queue
import threading
from typing import Annotated, Literal

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import __version__, context
from ..core import (
    catalog,
    cim,
    convert,
    engine,
    importer,
    irradiance,
    linecodes,
    multispeak,
    nrel,
    priority_map,
    protection,
    qa,
    reliability,
    samples,
    trace,
)
from ..core.compiler import export_dss
from ..core.jobs import jobs
from ..core.model import Allocation, Circuit
from ..core.ratelimit import RateLimited, TokenBucket
from ..core.validate import phase_map, validate
from ..settings import settings
from ..studies import allocation as allocation_study
from ..studies import balancing as balancing_study
from ..studies import batch as batch_study
from ..studies import capacity as capacity_study
from ..studies import contingency as contingency_study
from ..studies import duty as duty_study
from ..studies import faults as fault_study_mod
from ..studies import harmonics as harmonics_study
from ..studies import headroom as headroom_study
from ..studies import hosting_capacity as hc_study
from ..studies import islanding as islanding_study
from ..studies import protection_depth as protection_depth_study
from ..studies import screening as screening_study
from ..studies import secondary as secondary_study
from ..studies import voltvar as voltvar_study

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

_geocode_bucket = TokenBucket(settings.geocode_per_minute, 60.0, "place searches")
_fetch_bucket = TokenBucket(settings.fetch_per_hour, 3600.0, "data downloads")
# Long runs hold the engine for minutes; only so many may be in flight.
_timeseries_slots = threading.BoundedSemaphore(settings.max_concurrent_timeseries or 10_000)


@router.get("/health")
def health(request: Request) -> dict:
    """Liveness plus what the client needs to explain the demo's limits.

    Deliberately does not touch the engine (engine.opendss_version is cached),
    so it still answers while a long solve is running.
    """
    cfg = context.current_settings()
    out: dict = {
        "version": __version__,
        "opendssVersion": engine.opendss_version(),
        "mode": cfg.mode,
    }
    if cfg.demo or cfg.plan is not None:
        # The effective limits for *this caller*: behind a gateway that is
        # the per-request overlay, so the banner describes the right plan.
        out["limits"] = {
            "maxNodes": cfg.max_nodes,
            "maxEdges": cfg.max_edges,
            "maxShapes": cfg.max_shapes,
            "maxShapePoints": cfg.max_shape_points,
            "maxBodyBytes": cfg.max_body_bytes,
            "maxTimeseriesCost": cfg.max_timeseries_cost,
            "maxStudySolves": cfg.max_study_solves,
        }
        # Features a proxy withholds from this caller, with its reason, so
        # the panels can say so before a click gets a 403.
        features: dict = {}
        for key, locked in (
            ("convert", convert.locked_reason()),
            ("studies", studies_locked_reason()),
        ):
            if locked:
                features[key] = {"locked": True, "reason": locked}
        if features:
            out["features"] = features
    if cfg.plan is not None:
        out["plan"] = cfg.plan.as_dict()
    if cfg.demo:
        activity = getattr(request.app.state, "activity", None)
        if activity is not None:
            # So an external reaper can make the same call the in-process
            # idle timer makes, without trusting it.
            out["idleSeconds"] = round(activity.idle_seconds(), 1)
    return out


@router.get("/linecodes")
def line_codes() -> dict:
    """Conductor preset library from config/linecodes.csv (re-read each call
    so the user can edit the file without restarting the server)."""
    return linecodes.load_line_codes()


def _busy(exc: engine.EngineBusy) -> HTTPException:
    return HTTPException(status_code=503, detail=str(exc), headers={"Retry-After": "5"})


@router.get("/samples")
def list_samples() -> dict:
    """Curated example circuits, in the native project format."""
    return {"samples": samples.list_samples()}


@router.get("/samples/{sample_id}")
def get_sample(sample_id: str) -> dict:
    # Looked up in a preloaded dict, never joined onto a path: turning a
    # request value into a filesystem path is exactly the bug the static-file
    # handler used to have.
    circuit = samples.get_sample(sample_id)
    if circuit is None:
        raise HTTPException(status_code=404, detail="No such sample.")
    return circuit


@router.post("/solve")
def solve(circuit: Circuit) -> dict:
    try:
        return islanding_study.solve_with_islands(circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.post("/faultstudy")
def fault_study(circuit: Circuit) -> dict:
    try:
        return engine.fault_study(circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.get("/tcccurves")
def tcc_curves() -> dict:
    """The time-current curves the engine ships. A circuit's own curves come
    with the circuit, so this is only the built-in half."""
    try:
        return protection.builtin_curves()
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.post("/tcc")
def tcc(circuit: Circuit) -> dict:
    try:
        return protection.tcc_study(circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.post("/reliability")
def reliability_study(circuit: Circuit) -> dict:
    """SAIFI, SAIDI and CAIDI from the engine's EnergyMeter reliability
    calculation, with the protection sections behind them."""
    try:
        return reliability.reliability_study(circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.post("/validate")
def validate_circuit(circuit: Circuit) -> dict:
    """Issues, plus which phases reach each element so the one-line can
    colour by phase before anything has been solved."""
    return {"issues": [i.model_dump() for i in validate(circuit)], "phases": phase_map(circuit)}


@router.post("/islands")
def islands(circuit: Circuit) -> dict:
    """The islands the drawing forms (open scenario applied), their sources
    and their loads by priority -- topology only, no solve."""
    return islanding_study.topology_islands(circuit)


class TraceRequest(BaseModel):
    circuit: Circuit
    elementId: Annotated[str, Field(min_length=1, max_length=200)]


@router.post("/trace")
def trace_element(req: TraceRequest) -> dict:
    """Upstream paths to every source and the downstream set of one element,
    from the drawn topology (no solve), with the open scenario applied."""
    return trace.trace(req.circuit, req.elementId)


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
    cfg = context.current_settings()
    cost = engine.estimate_timeseries_cost(req.circuit, req.mode, req.stepMin)
    if cfg.max_timeseries_cost and cost > cfg.max_timeseries_cost:
        raise HTTPException(
            status_code=413,
            detail=f"This run is too large for {cfg.plan_label} "
            f"({req.mode} at {req.stepMin} min on a circuit this size). "
            "Try a daily run, an hourly step, or a smaller circuit — "
            "or run OpenDSS Designer locally for the full model.",
        )
    if not _timeseries_slots.acquire(blocking=False):
        raise HTTPException(
            status_code=503,
            headers={"Retry-After": "10"},
            detail="Another time-series run is already using the solver. Try again in a moment.",
        )

    # Bounded: a backgrounded or throttled browser tab stops reading, and an
    # unbounded queue would buffer every progress event for the whole run.
    q: queue.Queue = queue.Queue(maxsize=256)
    cancel = threading.Event()
    watchdog: threading.Timer | None = None
    if cfg.timeseries_timeout_s:
        # The step loop already checks `cancel` every step, so a wall-clock
        # budget is just a timer pointed at the same flag.
        watchdog = threading.Timer(cfg.timeseries_timeout_s, cancel.set)
        watchdog.daemon = True
        watchdog.start()

    def put(event: dict) -> None:
        try:
            q.put(event, timeout=5)
        except queue.Full:
            cancel.set()

    req_ctx = context.current_context()

    def used() -> dict:
        # The response headers left before the run started, so the engine
        # time a metering proxy needs rides on the final event instead.
        return {"engineSeconds": round(req_ctx.engine_seconds, 3)} if req_ctx is not None else {}

    def worker() -> None:
        try:
            result = engine.solve_timeseries(
                req.circuit,
                req.mode,
                req.stepMin,
                progress_cb=lambda s, t: put({"type": "progress", "step": s, "total": t}),
                cancel=cancel,
            )
            put({"type": "result", "result": result, **used()})
        except engine.EngineBusy as exc:
            put({"type": "error", "message": str(exc), **used()})
        except (ValueError, importer.ImportFailure) as exc:
            # Known bad input: the message is written for the user.
            put({"type": "error", "message": str(exc), **used()})
        except Exception:
            # A bug, not bad input. `str(exc)` here can carry filesystem paths
            # and library internals, so it stays server-side; the traceback
            # still reaches stderr via the logging added for deployment.
            logger.exception("Time-series run failed")
            put(
                {
                    "type": "error",
                    "message": "The time-series run failed unexpectedly. "
                    "Check the server log for details.",
                    **used(),
                }
            )
        finally:
            # Released here, not in the response generator: the worker always
            # runs to completion, but a client that disconnects before reading
            # a byte means the generator never starts and its `finally` never
            # fires -- which leaked one slot per run until the demo refused
            # every further time series.
            _timeseries_slots.release()
            if watchdog is not None:
                watchdog.cancel()
            try:
                q.put(None, timeout=5)  # sentinel: stream complete
            except queue.Full:
                pass

    # A copy of the request context, so the limits overlay and request id
    # follow the run onto its own thread (and from there onto the engine
    # thread, which copies again).
    threading.Thread(target=contextvars.copy_context().run, args=(worker,), daemon=True).start()

    def gen():
        # Flush a comment immediately, then keep the stream warm. Nothing else
        # is sent until the first progress event, which lands only after the
        # circuit compiles -- and `solve_timeseries` runs on the single engine
        # thread, so another visitor's solve can delay that indefinitely. A
        # proxy or CDN that sees no bytes treats the request as a hung origin
        # and kills it (Cloudflare does at 100s). SSE comment lines are ignored
        # by the client: lib/timeseries.ts skips any block not starting
        # with "data: ".
        yield ": open\n\n"
        try:
            while True:
                try:
                    ev = q.get(timeout=15)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue
                if ev is None:
                    break
                yield f"data: {json.dumps(ev)}\n\n"
        finally:
            cancel.set()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
        return nrel.fetch_profile(
            req.product,
            req.climateZone,
            req.buildingType,
            step_min=req.stepMin,
            normalize=req.normalize,
        )
    except nrel.NrelError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


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
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


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
        return irradiance.fetch_ghi(
            req.lat, req.lon, req.apiKey, req.email, scaling=req.scaling, label=req.label
        )
    except irradiance.IrradianceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


class DssFile(BaseModel):
    name: str = "file.dss"
    text: str = ""


class ImportRequest(BaseModel):
    """Typed so file count and size are bounded before anything is written."""

    files: list[DssFile] | None = None
    text: str | None = None
    # Customer or load class -> priority for this import (overrides the
    # configured config/priority_by_class.csv).
    priorityByClass: Annotated[dict[str, str], Field(max_length=200)] | None = None


def _check_import_size(files: list[DssFile]) -> None:
    cfg = context.current_settings()
    if cfg.max_import_files and len(files) > cfg.max_import_files:
        raise HTTPException(
            status_code=413,
            detail=f"Select at most {cfg.max_import_files} files ({len(files)} given).",
        )
    if cfg.max_import_bytes:
        for f in files:
            if len(f.text.encode("utf-8", "ignore")) > cfg.max_import_bytes:
                mb = cfg.max_import_bytes // (1024 * 1024)
                raise HTTPException(
                    status_code=413,
                    detail=f"'{f.name}' is larger than the {mb} MB per-file "
                    f"limit for {cfg.plan_label}. Run OpenDSS Designer "
                    "locally for full-size feeders.",
                )


@router.post("/import/dss")
def import_file(payload: ImportRequest = Body(...)) -> dict:
    files = payload.files
    if files is None:
        files = [DssFile(name="main.dss", text=payload.text or "")]
    _check_import_size(files)
    try:
        result = importer.import_dss_files([f.model_dump() for f in files])
        if payload.priorityByClass:
            priority_map.apply(result["circuit"], payload.priorityByClass)
        return result
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc
    except importer.ImportFailure as exc:
        # Bad input (the importer wraps OpenDSS compile errors in ImportFailure);
        # anything else propagates as a 500 so genuine bugs aren't masked as 400s.
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/convert/formats")
def convert_formats() -> dict:
    """Formats the optional converter plugin reads (core/convert.py)."""
    return convert.formats()


class BinaryFile(BaseModel):
    name: str = "file"
    # Base64: CYME exports are text, but a Synergi model is an Access database.
    data: str = ""


class ConvertRequest(BaseModel):
    format: str
    files: list[BinaryFile]
    # Customer or load class -> priority for this import (overrides the
    # configured config/priority_by_class.csv).
    priorityByClass: Annotated[dict[str, str], Field(max_length=200)] | None = None


@router.post("/import/convert")
def import_converted(req: ConvertRequest) -> dict:
    """A CYME or Synergi model, converted to OpenDSS by the plugin and
    imported like a .dss file."""
    cfg = context.current_settings()
    locked = convert.locked_reason()
    if locked:
        # Decided before any decoding: a withheld feature costs nothing.
        raise HTTPException(status_code=403, detail=locked)
    if cfg.max_import_files and len(req.files) > cfg.max_import_files:
        raise HTTPException(status_code=413, detail=f"Select at most {cfg.max_import_files} files.")
    decoded: list[tuple[str, bytes]] = []
    for f in req.files:
        try:
            data = base64.b64decode(f.data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail=f"'{f.name}' did not arrive intact."
            ) from exc
        if cfg.max_import_bytes and len(data) > cfg.max_import_bytes:
            mb = cfg.max_import_bytes // (1024 * 1024)
            raise HTTPException(
                status_code=413,
                detail=f"'{f.name}' is larger than the {mb} MB per-file "
                f"limit for {cfg.plan_label}.",
            )
        decoded.append((f.name, data))
    try:
        result = convert.convert_and_import(req.format, decoded)
        if req.priorityByClass:
            priority_map.apply(result["circuit"], req.priorityByClass)
        return result
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc
    except convert.ConvertFailure as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- background studies -------------------------------------------------------


def _study_cap(solves: int) -> None:
    """Refuse a study larger than the plan allows before it starts."""
    cfg = context.current_settings()
    if cfg.max_study_solves and solves > cfg.max_study_solves:
        raise HTTPException(
            status_code=413,
            detail=f"This study needs about {solves:,} solves, more than {cfg.plan_label} "
            f"allows ({cfg.max_study_solves:,}). Fewer scenarios, levels or "
            "candidate buses, or run OpenDSS Designer locally.",
        )


STUDIES_LABEL = "Planning studies"


def studies_locked_reason() -> str | None:
    """Why this caller may not run a study, or None when they may. A proxy
    withholds the studies per plan through the limits header (`features`);
    a local install never does."""
    cfg = context.current_settings()
    if cfg.allow_studies:
        return None
    return cfg.feature_reason("studies", STUDIES_LABEL)


def _refuse_locked_study() -> None:
    locked = studies_locked_reason()
    if locked:
        # Decided before the circuit is looked at: a withheld study costs nothing.
        raise HTTPException(status_code=403, detail=locked)


def _submit_study(kind: str, fn):
    """Start a job with the plan's wall-clock budget as a watchdog."""
    _refuse_locked_study()
    cfg = context.current_settings()
    job = jobs.submit(kind, fn)
    if cfg.timeseries_timeout_s:
        timer = threading.Timer(cfg.timeseries_timeout_s, job.cancel.set)
        timer.daemon = True
        timer.start()
    return {"job": job.snapshot()}


class BatchRequest(BaseModel):
    circuit: Circuit
    # Scenario ids (None = base case) and level names (None = rated); either
    # left out means everything the circuit has.
    scenarios: list[str | None] | None = None
    levels: list[str | None] | None = None


@router.post("/jobs/batch")
def start_batch(req: BatchRequest) -> dict:
    """Every scenario at every load level, as a background job."""
    n_sc = len(req.scenarios) if req.scenarios is not None else 1 + len(req.circuit.scenarios or [])
    n_lv = len(req.levels) if req.levels is not None else max(1, len(req.circuit.loadLevels or []))
    _study_cap(n_sc * n_lv)
    return _submit_study(
        "batch",
        lambda progress, cancel: batch_study.run_batch(
            req.circuit, req.scenarios, req.levels, progress, cancel
        ),
    )


@router.get("/jobs")
def list_jobs() -> dict:
    return {"jobs": jobs.list()}


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such job.")
    return job.snapshot(with_result=True)


@router.delete("/jobs/{job_id}")
def cancel_job(job_id: str) -> dict:
    if not jobs.cancel(job_id):
        raise HTTPException(status_code=404, detail="No such job.")
    return {"cancelled": True}


@router.get("/jobs/{job_id}/events")
def job_events(job_id: str) -> StreamingResponse:
    """SSE: {"type":"progress",...} as the job advances, then one
    {"type":"result", ..., "result": {...}} (or status failed/cancelled with
    `error`). Comment lines keep the stream warm through proxies."""
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail="No such job.")

    def gen():
        yield ": open\n\n"
        for ev in jobs.events(job_id):
            if ev.get("type") == "ping":
                yield ": ping\n\n"
                continue
            yield f"data: {json.dumps(ev)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class HostingCapacityRequest(BaseModel):
    circuit: Circuit
    # See studies.hosting_capacity.DEFAULT_OPTIONS; anything left out takes
    # the default.
    options: dict | None = None


@router.post("/jobs/hosting-capacity")
def start_hosting_capacity(req: HostingCapacityRequest) -> dict:
    """DER (or load) hosting capacity at every candidate bus, as a job."""
    _study_cap(hc_study.estimate_solves(req.circuit, req.options))
    return _submit_study(
        "hosting-capacity",
        lambda progress, cancel: hc_study.hosting_capacity(
            req.circuit, req.options, progress, cancel
        ),
    )


class DutyRequest(BaseModel):
    circuit: Circuit


@router.post("/duty")
def duty(req: DutyRequest) -> dict:
    """Equipment duty screening: every device and busbar against the fault
    current at its terminals (one fault-study solve)."""
    _refuse_locked_study()
    try:
        return duty_study.duty_screening(req.circuit)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class HeadroomRequest(BaseModel):
    circuit: Circuit
    # {"levels": [names] | None (every level), "voltage": bool}
    options: dict | None = None


@router.post("/jobs/headroom")
def start_headroom(req: HeadroomRequest) -> dict:
    """Spare capacity of every rated element at each load level, as a job."""
    _study_cap(headroom_study.estimate_solves(req.circuit, req.options))
    return _submit_study(
        "headroom",
        lambda progress, cancel: headroom_study.headroom(
            req.circuit, req.options, progress, cancel
        ),
    )


class FaultPointRequest(BaseModel):
    circuit: Circuit
    bus: str
    kind: Literal["3ph", "lg", "ll", "llg"] = "3ph"
    rOhm: float = 0.0
    phase: int | None = None


@router.post("/faultpoint")
def fault_point(req: FaultPointRequest) -> dict:
    """One fault of a chosen kind and resistance at one bus: the current in
    the fault, what every series element carries, the voltages meanwhile."""
    _refuse_locked_study()
    try:
        return fault_study_mod.fault_point(req.circuit, req.bus, req.kind, req.rOhm, req.phase)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class FaultSweepRequest(BaseModel):
    circuit: Circuit
    rOhm: float = 0.0


@router.post("/jobs/fault-sweep")
def start_fault_sweep(req: FaultSweepRequest) -> dict:
    """Maximum and minimum fault currents at every bus, as a job."""
    _study_cap(2 * len(req.circuit.nodes) + 1)
    return _submit_study(
        "fault-sweep",
        lambda progress, cancel: fault_study_mod.fault_sweep(
            req.circuit, req.rOhm, progress, cancel
        ),
    )


class ScreenRequest(BaseModel):
    circuit: Circuit
    bus: str
    options: dict | None = None


@router.post("/screen")
def screen_der(req: ScreenRequest) -> dict:
    """The interconnection screens for one DER at a point of common coupling."""
    _refuse_locked_study()
    try:
        return screening_study.screen(req.circuit, req.bus, req.options)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


# --- M14: contingency, Volt/VAR, balancing, capacity ---------------------------


class SwitchingRequest(BaseModel):
    circuit: Circuit
    steps: list[dict]


@router.post("/switching")
def switching(req: SwitchingRequest) -> dict:
    """Open/close steps applied in order, each solved."""
    _refuse_locked_study()
    try:
        return contingency_study.switching_sequence(req.circuit, req.steps[:200])
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class N1Request(BaseModel):
    circuit: Circuit
    options: dict | None = None


@router.post("/jobs/n-minus-1")
def start_n_minus_1(req: N1Request) -> dict:
    _study_cap(contingency_study.estimate_n1_solves(req.circuit, req.options))
    return _submit_study(
        "n-minus-1",
        lambda progress, cancel: contingency_study.n_minus_1(
            req.circuit, req.options, progress, cancel
        ),
    )


class TransferRequest(BaseModel):
    circuit: Circuit
    tie: str
    toleranceKw: float = 10.0


@router.post("/transfer")
def transfer(req: TransferRequest) -> dict:
    _refuse_locked_study()
    try:
        return contingency_study.transfer_capability(req.circuit, req.tie, req.toleranceKw)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class SweepRequest(BaseModel):
    circuit: Circuit
    sweeps: list[dict]
    stepMin: Literal[60, 15] = 60


@router.post("/jobs/sweep")
def start_sweep(req: SweepRequest) -> dict:
    _study_cap(voltvar_study.estimate_sweep_solves(req.sweeps, req.stepMin))
    return _submit_study(
        "sweep",
        lambda progress, cancel: voltvar_study.setting_sweep(
            req.circuit, req.sweeps, req.stepMin, progress, cancel
        ),
    )


class CvrRequest(BaseModel):
    circuit: Circuit
    reductionV: float = 2.0
    stepMin: Literal[60, 15] = 60


@router.post("/cvr")
def cvr(req: CvrRequest) -> dict:
    _refuse_locked_study()
    try:
        return voltvar_study.cvr(req.circuit, req.reductionV, req.stepMin)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class PlacementRequest(BaseModel):
    circuit: Circuit
    kvar: float = 600.0
    banks: int = 1
    buses: list[str] | None = None
    minKv: float = 1.0


@router.post("/jobs/capacitor-placement")
def start_placement(req: PlacementRequest) -> dict:
    _study_cap(max(1, req.banks) * (len(req.buses) if req.buses else len(req.circuit.nodes)))
    return _submit_study(
        "capacitor-placement",
        lambda progress, cancel: voltvar_study.capacitor_placement(
            req.circuit, req.kvar, req.banks, req.buses, req.minKv, progress, cancel
        ),
    )


class BalanceRequest(BaseModel):
    circuit: Circuit
    maxCandidates: int = 40


@router.post("/jobs/phase-balance")
def start_phase_balance(req: BalanceRequest) -> dict:
    _study_cap(1 + 2 * max(1, req.maxCandidates))
    return _submit_study(
        "phase-balance",
        lambda progress, cancel: balancing_study.phase_balance(
            req.circuit, req.maxCandidates, progress, cancel
        ),
    )


class LossRequest(BaseModel):
    circuit: Circuit
    mode: Literal["daily", "yearly"] = "daily"
    stepMin: Literal[60, 15] = 60
    pricePerKwh: float = 0.0


@router.post("/jobs/loss-evaluation")
def start_loss_evaluation(req: LossRequest) -> dict:
    _study_cap((24 if req.mode == "daily" else 8760) * 60 // req.stepMin)
    return _submit_study(
        "loss-evaluation",
        lambda progress, cancel: capacity_study.loss_evaluation(
            req.circuit, req.mode, req.stepMin, req.pricePerKwh, progress, cancel
        ),
    )


class CapacityRequest(BaseModel):
    circuit: Circuit
    maxMult: float = 10.0


@router.post("/capacity")
def capacity_route(req: CapacityRequest) -> dict:
    _refuse_locked_study()
    try:
        return capacity_study.capacity_search(req.circuit, req.maxMult)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


# --- M15: model quality, catalogues, the secondary, allocation ------------------


class QaRequest(BaseModel):
    circuit: Circuit


@router.post("/qa")
def model_qa(req: QaRequest) -> dict:
    """The one-click model check: findings and a completeness table."""
    return qa.qa_report(req.circuit)


@router.get("/catalog/wires")
def catalog_wires() -> dict:
    return catalog.load_wires()


@router.get("/catalog/transformers")
def catalog_transformers() -> dict:
    return catalog.load_transformers()


class TlmRequest(BaseModel):
    circuit: Circuit
    mode: Literal["daily", "yearly"] = "daily"
    stepMin: Literal[60, 15] = 60
    ambientC: float = 30.0


@router.post("/jobs/transformer-loading")
def start_transformer_loading(req: TlmRequest) -> dict:
    _study_cap((24 if req.mode == "daily" else 8760) * 60 // req.stepMin)
    return _submit_study(
        "transformer-loading",
        lambda progress, cancel: secondary_study.transformer_loading(
            req.circuit, req.mode, req.stepMin, req.ambientC, progress, cancel
        ),
    )


class AllocateRequest(BaseModel):
    circuit: Circuit
    rows: list[dict]
    options: dict | None = None


@router.post("/allocate")
def allocate_loads(req: AllocateRequest) -> dict:
    _refuse_locked_study()
    try:
        return allocation_study.allocate(req.circuit, req.rows[:20000], req.options)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class AllocateZoneRequest(BaseModel):
    circuit: Circuit
    allocation: Allocation


@router.post("/allocate/zone")
def allocate_zone(req: AllocateZoneRequest) -> dict:
    """Scale the loads below a meter point until the solve agrees with the
    measured kW (and kvar or PF): the factor found, not written into loads."""
    _refuse_locked_study()
    try:
        return allocation_study.allocate_zone(req.circuit, req.allocation)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class BakeRequest(BaseModel):
    circuit: Circuit
    allocationId: Annotated[str, Field(min_length=1, max_length=64)]


@router.post("/allocate/bake")
def bake_allocation(req: BakeRequest) -> dict:
    """The load values an allocation's factor stands for, as overrides."""
    return allocation_study.bake(req.circuit, req.allocationId)


# --- M16: protection and reliability depth ----------------------------------------


class FaultLineRequest(BaseModel):
    circuit: Circuit
    line: str
    fraction: float = 0.5
    kind: Literal["3ph", "lg", "ll", "llg"] = "3ph"
    rOhm: float = 0.0


@router.post("/faultline")
def fault_on_line(req: FaultLineRequest) -> dict:
    """A fault part way along a line: the line is split at the fraction."""
    _refuse_locked_study()
    try:
        return protection_depth_study.fault_on_line(
            req.circuit, req.line, req.fraction, req.kind, req.rOhm
        )
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class ReachRequest(BaseModel):
    circuit: Circuit
    rOhm: float = 20.0
    derType: Literal["inverter", "synchronous"] = "inverter"


@router.post("/jobs/reach")
def start_reach(req: ReachRequest) -> dict:
    _study_cap(2 * len(req.circuit.nodes) + 1)
    return _submit_study(
        "reach",
        lambda progress, cancel: protection_depth_study.reach_study(
            req.circuit, req.rOhm, req.derType, progress, cancel
        ),
    )


class FuseSavingRequest(BaseModel):
    circuit: Circuit
    rOhm: float = 20.0


@router.post("/fusesaving")
def fuse_saving(req: FuseSavingRequest) -> dict:
    _refuse_locked_study()
    try:
        return protection_depth_study.fuse_saving(req.circuit, req.rOhm)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


class RecloserPlacementRequest(BaseModel):
    circuit: Circuit
    maxCandidates: int = 40


@router.post("/jobs/recloser-placement")
def start_recloser_placement(req: RecloserPlacementRequest) -> dict:
    _study_cap(1 + max(1, req.maxCandidates))
    return _submit_study(
        "recloser-placement",
        lambda progress, cancel: protection_depth_study.recloser_placement(
            req.circuit, req.maxCandidates, progress, cancel
        ),
    )


# --- M17: interoperability and power quality ------------------------------------


class TextImportRequest(BaseModel):
    files: list[DssFile]


@router.post("/import/cim")
def import_cim(req: TextImportRequest) -> dict:
    """A CIM RDF/XML document (IEC 61968-13 / CIM100) onto the drawing."""
    _check_import_size(req.files)
    text = "\n".join(f.text for f in req.files)
    try:
        return cim.import_cim_text(text)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc
    except (importer.ImportFailure, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not read the CIM file: {exc}") from exc
    except Exception as exc:  # a malformed XML document is bad input, not a bug
        if exc.__class__.__name__ == "ParseError":
            raise HTTPException(status_code=400, detail=f"Not well-formed XML: {exc}") from exc
        raise


@router.post("/import/multispeak")
def import_multispeak(req: TextImportRequest) -> dict:
    """A MultiSpeak network model (XML) onto the drawing."""
    _check_import_size(req.files)
    text = "\n".join(f.text for f in req.files)
    try:
        return multispeak.import_multispeak_text(text)
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc
    except (importer.ImportFailure, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not read the MultiSpeak file: {exc}"
        ) from exc
    except Exception as exc:
        if exc.__class__.__name__ == "ParseError":
            raise HTTPException(status_code=400, detail=f"Not well-formed XML: {exc}") from exc
        raise


@router.post("/export/cim", response_class=PlainTextResponse)
def export_cim(circuit: Circuit) -> str:
    return cim.circuit_to_cim(circuit)


class HarmonicsRequest(BaseModel):
    circuit: Circuit
    orders: list[int] | None = None
    thdLimit: float = 5.0
    individualLimit: float = 3.0


@router.post("/jobs/harmonics")
def start_harmonics(req: HarmonicsRequest) -> dict:
    _study_cap(1 + len(req.orders or harmonics_study.DEFAULT_ORDERS))
    return _submit_study(
        "harmonics",
        lambda progress, cancel: harmonics_study.harmonics(
            req.circuit, req.orders, req.thdLimit, req.individualLimit, progress, cancel
        ),
    )


class RvcRequest(BaseModel):
    circuit: Circuit
    bus: str = ""
    kind: Literal["motorStart", "derTrip"] = "motorStart"
    kva: float = 500.0
    pf: float = 0.3
    lrcMultiple: float = 6.0
    limitPct: float = 3.0
    derId: str | None = None


@router.post("/rvc")
def rvc(req: RvcRequest) -> dict:
    _refuse_locked_study()
    try:
        return harmonics_study.rapid_voltage_change(
            req.circuit,
            req.bus,
            req.kind,
            req.kva,
            req.pf,
            req.lrcMultiple,
            req.limitPct,
            req.derId,
        )
    except engine.EngineBusy as exc:
        raise _busy(exc) from exc


@router.get("/studies")
def list_studies() -> dict:
    """Every study by name, as `opendss-designer run` and scripts see them."""
    from ..studies.registry import STUDIES

    return {"studies": [{"name": k, "help": v[0]} for k, v in STUDIES.items()]}
