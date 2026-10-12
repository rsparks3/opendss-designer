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
"""
from __future__ import annotations

import importlib
import logging
from typing import Any

from . import importer

logger = logging.getLogger(__name__)

PLUGIN = "opendss_designer_convert"
INSTALL_HINT = ("CYME and Synergi import need the converter plugin: "
                "pip install opendss-designer-convert (Python 3.11 or later), "
                "then restart OpenDSS Designer.")


class ConvertFailure(Exception):
    """Conversion could not proceed; the message is safe to show."""


def _plugin() -> Any | None:
    try:
        return importlib.import_module(PLUGIN)
    except ImportError:
        return None
    except Exception:  # a broken install must not take the app down
        logger.exception("converter plugin failed to import")
        return None


def formats() -> dict[str, Any]:
    """What the plugin converts, for the File menu; `available` is false
    (with how to install it) when it is not installed."""
    mod = _plugin()
    if mod is None:
        return {"available": False, "install": INSTALL_HINT, "formats": []}
    out = []
    for key, f in getattr(mod, "FORMATS", {}).items():
        out.append({"key": key, "label": str(f.label), "help": str(f.help),
                    "extensions": [str(e) for e in f.extensions],
                    "maxFiles": int(f.max_files)})
    return {"available": True, "version": str(getattr(mod, "__version__", "")),
            "formats": out}


def convert_and_import(fmt: str, files: list[tuple[str, bytes]]) -> dict[str, Any]:
    """Convert with the plugin, then import the OpenDSS it wrote."""
    mod = _plugin()
    if mod is None:
        raise ConvertFailure(INSTALL_HINT)
    if fmt not in getattr(mod, "FORMATS", {}):
        raise ConvertFailure(f"The converter does not read '{fmt}' models.")
    try:
        conversion = mod.convert(fmt, files)
    except mod.ConversionError as exc:
        raise ConvertFailure(str(exc)) from exc
    except Exception as exc:
        logger.exception("converter failed")
        raise ConvertFailure("The converter could not read those files.") from exc
    dss_files = [{"name": name, "text": text} for name, text in conversion.files]
    try:
        result = importer.import_dss_files(dss_files)
    except importer.ImportFailure as exc:
        raise ConvertFailure(f"The converted model did not import: {exc}") from exc
    label = mod.FORMATS[fmt].label
    result["warnings"] = [f"{label}: {w}" for w in conversion.warnings] + result["warnings"]
    result["converted"] = {"format": fmt, "files": [n for n, _ in conversion.files]}
    return result
