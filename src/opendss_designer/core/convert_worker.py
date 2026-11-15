"""The child process `core/convert.py` runs a conversion in.

Reads one JSON request on stdin, ``{"format": str, "files": [{"name", "data"
(base64)}]}``, calls the plugin, and writes one JSON reply on stdout:
``{"ok": true, "files": [[name, text], ...], "main": str, "warnings": [...]}``
or ``{"ok": false, "error": str, "user": bool}`` where `user` says the
message is the plugin's own and safe to show. Everything the plugin logs
goes to stderr, which the parent keeps out of the reply.

Run as ``python -m opendss_designer.core.convert_worker``. Exit status is 0
for any well-formed reply, including a refusal; anything else means the
reply could not be produced.
"""
from __future__ import annotations

import base64
import importlib
import json
import logging
import sys

PLUGIN = "opendss_designer_convert"


def run(request: dict) -> dict:
    try:
        mod = importlib.import_module(PLUGIN)
    except Exception as exc:  # noqa: BLE001 - reported to the parent, not raised
        return {"ok": False, "user": False, "error": f"plugin import failed: {exc!r}"}
    fmt = str(request.get("format") or "")
    if fmt not in getattr(mod, "FORMATS", {}):
        return {"ok": False, "user": True,
                "error": f"The converter does not read '{fmt}' models."}
    try:
        files = [(str(f["name"]), base64.b64decode(f["data"], validate=True))
                 for f in request.get("files", [])]
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "user": False, "error": f"bad request: {exc!r}"}
    try:
        conversion = mod.convert(fmt, files)
    except mod.ConversionError as exc:
        return {"ok": False, "user": True, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).exception("converter failed")
        return {"ok": False, "user": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"ok": True,
            "files": [[str(name), str(text)] for name, text in conversion.files],
            "main": str(getattr(conversion, "main", "") or ""),
            "warnings": [str(w) for w in getattr(conversion, "warnings", [])]}


def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    try:
        request = json.load(sys.stdin)
    except ValueError as exc:
        reply = {"ok": False, "user": False, "error": f"bad request: {exc}"}
    else:
        reply = run(request if isinstance(request, dict) else {})
    # Binary-safe and one write: the parent reads stdout as the whole reply.
    out = json.dumps(reply, ensure_ascii=True).encode("ascii")
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
