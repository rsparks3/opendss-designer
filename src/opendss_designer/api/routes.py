"""REST API for the designer frontend."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import PlainTextResponse

import opendssdirect as dss

from .. import __version__
from ..core import engine, importer, linecodes
from ..core.compiler import export_dss
from ..core.model import Circuit
from ..core.validate import validate

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict:
    return {"version": __version__, "opendssVersion": dss.Basic.Version()}


@router.get("/linecodes")
def line_codes() -> dict:
    """Conductor preset library from config/linecodes.csv (re-read each call
    so the user can edit the file without restarting the server)."""
    return linecodes.load_line_codes()


@router.post("/solve")
def solve(circuit: Circuit) -> dict:
    return engine.solve(circuit)


@router.post("/validate")
def validate_circuit(circuit: Circuit) -> dict:
    return {"issues": [i.model_dump() for i in validate(circuit)]}


@router.post("/export/dss", response_class=PlainTextResponse)
def export(circuit: Circuit) -> str:
    text, _issues = export_dss(circuit)
    return text


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
