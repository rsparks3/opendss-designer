"""Per-request context: effective settings, request id, engine time.

Everything here is a ``contextvars`` variable so it follows a request without
being threaded through every signature. Two hops need care and both are
handled at the hop, not here: the engine thread (``engine.on_engine_thread``
runs each call inside a copy of the caller's context) and the time-series
worker thread (``routes.timeseries`` starts it the same way). Starlette
already copies context into the threadpool that runs sync endpoints.

In a plain local install nothing sets an overlay, so ``current_settings()``
is simply the process settings and the engine-time counter is never read.
"""
from __future__ import annotations

import re
import threading
from contextvars import ContextVar, Token

from .settings import Settings, settings

_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


class RequestContext:
    """Mutable per-request record. Shared by reference across the threads a
    request touches, hence the lock on the only field that is accumulated."""

    __slots__ = ("request_id", "engine_seconds", "_lock")

    def __init__(self, request_id: str | None = None):
        self.request_id = request_id
        self.engine_seconds = 0.0
        self._lock = threading.Lock()

    def add_engine_seconds(self, seconds: float) -> None:
        with self._lock:
            self.engine_seconds += seconds


_request_settings: ContextVar[Settings | None] = ContextVar(
    "opendss_request_settings", default=None)
_request_context: ContextVar[RequestContext | None] = ContextVar(
    "opendss_request_context", default=None)


def current_settings() -> Settings:
    """The settings in force for this request: the trusted-header overlay if
    one was bound, otherwise the process settings."""
    return _request_settings.get() or settings


def current_context() -> RequestContext | None:
    return _request_context.get()


def current_request_id() -> str | None:
    ctx = _request_context.get()
    return ctx.request_id if ctx else None


def bind(cfg: Settings | None, ctx: RequestContext) -> tuple[Token, Token]:
    return _request_settings.set(cfg), _request_context.set(ctx)


def unbind(tokens: tuple[Token, Token]) -> None:
    _request_settings.reset(tokens[0])
    _request_context.reset(tokens[1])


def clean_request_id(raw: str | None) -> str | None:
    """Accept only ids that are safe to echo in a header and a log line."""
    if raw and _SAFE_REQUEST_ID.match(raw):
        return raw
    return None


def record_engine_seconds(seconds: float) -> None:
    ctx = _request_context.get()
    if ctx is not None:
        ctx.add_engine_seconds(seconds)
