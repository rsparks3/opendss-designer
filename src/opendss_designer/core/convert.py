"""Models from other planning tools, through an optional converter plugin.

CYME and Synergi models are converted to OpenDSS by `opendss-designer-convert`
(a separate, BSD-licensed package: a revived fork of NREL's DiTTo), which this
app does not depend on -- it brings a GIS-sized dependency tree. When it is
installed alongside, File -> Import offers its formats; the converted .dss
then goes through the ordinary importer, so a converted model is exactly as
faithful as the .dss the converter wrote.

The plugin's contract (see its README):

    FORMATS: dict[str, Format]          # key, label, extensions, help, max_files
    convert(fmt, [(name, bytes), ...]) -> Conversion(files, main, warnings)
    ConversionError                     # message safe to show

Listing FORMATS is cheap (the plugin imports its readers lazily), so that is
done in process. A conversion is not: the readers pull in pandas, geopandas,
pyarrow and friends, a few hundred megabytes that Python never gives back.
So the conversion itself runs in a child process (`convert_worker.py`) that
exits when it is done. That also bounds a conversion that hangs on a bad
file (`convert_timeout_s`) and keeps a crash in the plugin from taking the
app down. The child is this same interpreter with this same environment, so
whatever `pip install` put the plugin where the app finds it works unchanged.

A trusted proxy may withhold the feature per request (the `features` block
of the limits header, see `settings.REQUEST_FEATURES`); then the formats are
still listed, marked locked with the reason, and a conversion is refused.
"""
from __future__ import annotations

import base64
import importlib
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .. import context
from . import importer

logger = logging.getLogger(__name__)

PLUGIN = "opendss_designer_convert"
WORKER_MODULE = "opendss_designer.core.convert_worker"
FEATURE = "convert"
FEATURE_LABEL = "CYME and Synergi import"
INSTALL_HINT = ("CYME and Synergi import need the converter plugin: "
                "pip install opendss-designer-convert (Python 3.11 or later), "
                "then restart OpenDSS Designer.")
#: A reply from the child larger than this is not a model, it is a bug.
_MAX_REPLY_BYTES = 256 * 1024 * 1024


class ConvertFailure(Exception):
    """Conversion could not proceed; the message is safe to show."""


class ConvertLocked(ConvertFailure):
    """The feature is withheld from this caller by the proxy in front."""


def _plugin() -> Any | None:
    try:
        return importlib.import_module(PLUGIN)
    except ImportError:
        return None
    except Exception:  # a broken install must not take the app down
        logger.exception("converter plugin failed to import")
        return None


def locked_reason() -> str | None:
    """Why this caller may not convert, or None when they may."""
    cfg = context.current_settings()
    if cfg.allow_convert:
        return None
    return cfg.feature_reason(FEATURE, FEATURE_LABEL)


def formats() -> dict[str, Any]:
    """What the plugin converts, for the File menu. `available` is false
    (with how to install it) when it is not installed; `locked` is true (with
    the reason) when it is installed but withheld from this caller, so the
    menu can still show what the feature is."""
    mod = _plugin()
    if mod is None:
        return {"available": False, "install": INSTALL_HINT, "formats": []}
    out = []
    for key, f in getattr(mod, "FORMATS", {}).items():
        out.append({"key": key, "label": str(f.label), "help": str(f.help),
                    "extensions": [str(e) for e in f.extensions],
                    "maxFiles": int(f.max_files)})
    body: dict[str, Any] = {"available": True,
                            "version": str(getattr(mod, "__version__", "")),
                            "formats": out}
    reason = locked_reason()
    if reason:
        body["locked"] = True
        body["reason"] = reason
    return body


def convert_and_import(fmt: str, files: list[tuple[str, bytes]]) -> dict[str, Any]:
    """Convert with the plugin (in a child process), then import the OpenDSS
    it wrote."""
    reason = locked_reason()
    if reason:
        raise ConvertLocked(reason)
    mod = _plugin()
    if mod is None:
        raise ConvertFailure(INSTALL_HINT)
    if fmt not in getattr(mod, "FORMATS", {}):
        raise ConvertFailure(f"The converter does not read '{fmt}' models.")
    conversion = _run_worker(fmt, files)
    dss_files = [{"name": name, "text": text} for name, text in conversion["files"]]
    try:
        result = importer.import_dss_files(dss_files)
    except importer.ImportFailure as exc:
        raise ConvertFailure(f"The converted model did not import: {exc}") from exc
    label = mod.FORMATS[fmt].label
    result["warnings"] = [f"{label}: {w}" for w in conversion["warnings"]] + result["warnings"]
    result["converted"] = {"format": fmt, "files": [n for n, _ in conversion["files"]]}
    return result


def _run_worker(fmt: str, files: list[tuple[str, bytes]]) -> dict[str, Any]:
    """Run `convert_worker` in a child interpreter and return its reply."""
    request = json.dumps({"format": fmt, "files": [
        {"name": name, "data": base64.b64encode(data).decode("ascii")} for name, data in files]})
    timeout = context.current_settings().convert_timeout_s
    env = dict(os.environ)
    # Make sure the child can import this package the same way we were
    # imported (a checkout run with PYTHONPATH=src, or an installed wheel).
    here = str(Path(__file__).resolve().parents[2])
    env["PYTHONPATH"] = os.pathsep.join(p for p in (env.get("PYTHONPATH"), here) if p)
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [sys.executable, "-m", WORKER_MODULE], input=request.encode("utf-8"),
            capture_output=True, timeout=timeout, env=env, check=False)
    except subprocess.TimeoutExpired as exc:
        raise ConvertFailure(
            f"The conversion took longer than {timeout:.0f} s and was stopped. "
            "Run OpenDSS Designer locally for large models.") from exc
    except OSError as exc:
        logger.exception("could not start the converter process")
        raise ConvertFailure("The converter could not be started.") from exc
    finally:
        # Worker CPU is worker CPU: a hosted deployment meters it like a solve.
        context.record_engine_seconds(time.monotonic() - started)
    if len(proc.stdout) > _MAX_REPLY_BYTES:
        raise ConvertFailure("The converted model is too large to import.")
    try:
        reply = json.loads(proc.stdout.decode("utf-8"))
        ok = reply["ok"]
    except (ValueError, KeyError, TypeError):
        logger.error("converter process exited %s with no usable reply; stderr: %s",
                     proc.returncode, proc.stderr.decode("utf-8", "replace")[-2000:])
        raise ConvertFailure("The converter could not read those files.") from None
    if not ok:
        if reply.get("user"):
            raise ConvertFailure(str(reply.get("error") or "The converter refused the files."))
        logger.error("converter failed: %s", reply.get("error"))
        raise ConvertFailure("The converter could not read those files.")
    return {"files": [(str(n), str(t)) for n, t in reply["files"]],
            "main": str(reply.get("main") or ""),
            "warnings": [str(w) for w in reply.get("warnings", [])]}
