"""REST API for the designer frontend."""
from __future__ import annotations

import json
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
from ..core.validate import validate

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict:
    return {"version": __version__, "opendssVersion": engine.opendss_version()}


@router.get("/linecodes")
def line_codes() -> dict:
    """Conductor preset library from config/linecodes.csv (re-read each call
    so the user can edit the file without restarting the server)."""
    return linecodes.load_line_codes()


@router.post("/solve")
def solve(circuit: Circuit) -> dict:
    return engine.solve(circuit)


@router.post("/faultstudy")
def fault_study(circuit: Circuit) -> dict:
    return engine.fault_study(circuit)


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
    q: queue.Queue = queue.Queue()
    cancel = threading.Event()

    def worker() -> None:
        try:
            result = engine.solve_timeseries(
                req.circuit, req.mode, req.stepMin,
                progress_cb=lambda s, t: q.put(
                    {"type": "progress", "step": s, "total": t}),
                cancel=cancel)
            q.put({"type": "result", "result": result})
        except Exception as exc:  # surfaced to the client, not swallowed
            q.put({"type": "error", "message": str(exc)})
        finally:
            q.put(None)  # sentinel: stream complete

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
        return nrel.fetch_profile(req.product, req.climateZone, req.buildingType,
                                  step_min=req.stepMin, normalize=req.normalize)
    except nrel.NrelError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/irradiance/geocode")
def irradiance_geocode(q: str) -> dict:
    """Place-name search for the irradiance fetcher (Open-Meteo geocoder)."""
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
        return irradiance.fetch_ghi(req.lat, req.lon, req.apiKey, req.email,
                                    scaling=req.scaling, label=req.label)
    except irradiance.IrradianceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


@router.post("/import/dss")
def import_file(payload: dict = Body(...)) -> dict:
    try:
        if isinstance(payload.get("files"), list):
            return importer.import_dss_files(payload["files"])
        return importer.import_dss(str(payload.get("text", "")))
    except importer.ImportFailure as exc:
        # Bad input (the importer wraps OpenDSS compile errors in ImportFailure);
        # anything else propagates as a 500 so genuine bugs aren't masked as 400s.
        raise HTTPException(status_code=400, detail=str(exc))
