"""ASGI middleware for hosted deployments.

Written as plain ASGI callables rather than Starlette's ``BaseHTTPMiddleware``
on purpose: that class interposes an anyio memory stream, which breaks
streaming backpressure for the ``/api/timeseries`` SSE response and, worse,
breaks the client-disconnect -> generator ``finally`` -> ``cancel.set()`` path
that is the only thing stopping a runaway yearly run.
"""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict]]
Send = Callable[[dict], Awaitable[None]]


class _TooLarge(Exception):
    """Raised out of the receive channel once the body budget is gone."""


async def _reject(send: Send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class BodySizeLimitMiddleware:
    """Reject oversized request bodies before they are buffered into memory.

    Pydantic only ever sees a fully-read payload, so a size check at the schema
    layer is too late -- the allocation has already happened.
    """

    def __init__(self, app, max_bytes: int | None):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.max_bytes is None or scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.max_bytes
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > limit:
                    await _reject(send, 413, _too_big(limit))
                    return
            except ValueError:
                pass

        # Chunked, or a lying Content-Length: count what actually arrives and
        # abort the moment the budget is gone, rather than after buffering it.
        seen = 0
        started = False

        async def counting_receive() -> dict:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise _TooLarge
            return message

        async def guarded_send(message: dict) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except _TooLarge:
            if not started:
                await _reject(send, 413, _too_big(limit))


def _too_big(limit: int) -> str:
    return (f"Request too large for the public demo (limit "
            f"{limit // (1024 * 1024)} MB). Run OpenDSS Designer locally "
            "(pip install opendss-designer) for unlimited circuits.")


class SecurityHeadersMiddleware:
    """Baseline response headers. No HSTS: that belongs to whatever terminates
    TLS, and emitting it from a plaintext localhost server would poison
    http://localhost for every other tool on the machine."""

    #: 'unsafe-inline' for styles only -- React Flow sets inline style
    #: attributes on nodes and edges. Scripts stay strict: Vite emits external
    #: modules, so no inline script is needed. blob:/data: images cover the
    #: canvas export and object-URL download paths.
    CSP = ("default-src 'self'; "
           "script-src 'self'; "
           "style-src 'self' 'unsafe-inline'; "
           "img-src 'self' data: blob:; "
           "connect-src 'self'; "
           "font-src 'self'; "
           "frame-ancestors 'none'; "
           "base-uri 'none'; "
           "form-action 'none'; "
           "object-src 'none'")

    HEADERS = {
        b"content-security-policy": CSP.encode(),
        b"x-content-type-options": b"nosniff",
        b"referrer-policy": b"no-referrer",
        b"x-frame-options": b"DENY",
        b"cross-origin-opener-policy": b"same-origin",
        b"permissions-policy": b"geolocation=(), camera=(), microphone=()",
    }

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                message.setdefault("headers", [])
                for key, value in self.HEADERS.items():
                    if key not in existing:
                        message["headers"].append((key, value))
            await send(message)

        await self.app(scope, receive, send_with_headers)
