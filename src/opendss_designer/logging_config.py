"""Logging setup.

A local install stays quiet (the console belongs to the user); a hosted one
logs to stdout, where a container platform collects it. Request bodies are
never logged: they carry the user's circuit and, for the irradiance fetch,
their NLR API key.
"""
from __future__ import annotations

import json
import logging
import os
import sys

from . import context
from .settings import Settings


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
        }
        request_id = context.current_request_id()
        if request_id:
            payload["requestId"] = request_id
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def configure_logging(cfg: Settings) -> None:
    level = logging.INFO if cfg.demo else logging.WARNING
    handler = logging.StreamHandler(sys.stdout)
    if os.environ.get("OPENDSS_DESIGNER_LOG_JSON", "").strip().lower() in ("1", "true", "yes"):
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    root = logging.getLogger("opendss_designer")
    root.handlers[:] = [handler]
    root.setLevel(level)
    root.propagate = False
