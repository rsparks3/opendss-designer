"""FastAPI app factory: API routes + built-frontend static serving."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api.routes import router
from .middleware import (
    ActivityMiddleware,
    BodySizeLimitMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
)
from .settings import Settings, settings

STATIC_DIR = Path(__file__).parent / "static"

# Only loopback names by default: `cli.py` binds 127.0.0.1, so nothing else can
# legitimately reach a local install. Validating Host defeats DNS rebinding,
# where a malicious page resolves its own domain to 127.0.0.1 and drives the
# local server from the browser. Deployments set the env var to their hostname.
DEFAULT_ALLOWED_HOSTS = ("localhost", "127.0.0.1", "::1")


def allowed_hosts() -> list[str]:
    env = os.environ.get("OPENDSS_DESIGNER_ALLOWED_HOSTS", "").strip()
    if not env:
        return list(DEFAULT_ALLOWED_HOSTS)
    return [h.strip() for h in env.split(",") if h.strip()]


logger = logging.getLogger(__name__)


def _track_activity(app, app_state):
    app_state.activity = ActivityMiddleware(app, app_state)
    return app_state.activity


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):
    """Exit once nothing has happened for `idle_timeout_s`.

    Under one-process-per-session this is what lets a container release the
    OpenDSS singleton and scale to zero without an external reaper. It is a
    courtesy, not a guarantee: a client polling a non-health endpoint keeps it
    alive forever, so the wrapper still owns an absolute session TTL.
    """
    cfg: Settings = app.state.settings
    reachable = cfg.demo or cfg.host not in ("127.0.0.1", "localhost", "::1")
    if reachable and set(allowed_hosts()) == set(DEFAULT_ALLOWED_HOSTS):
        # Easy to miss and it fails closed: a proxy forwards the public Host,
        # which is not in the loopback default, so every request 400s.
        logger.warning(
            "reachable from outside this machine but the Host allowlist is "
            "still loopback-only - set OPENDSS_DESIGNER_ALLOWED_HOSTS to the "
            "hostname or IP you will use, or those requests are rejected "
            "with 400")
    task = None
    if cfg.idle_timeout_s:
        task = asyncio.create_task(_idle_watch(app, cfg.idle_timeout_s))
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def _idle_watch(app: FastAPI, timeout: float) -> None:
    while True:
        await asyncio.sleep(min(30.0, timeout))
        activity = getattr(app.state, "activity", None)
        if activity is None:
            continue
        idle = activity.idle_seconds()
        if idle >= timeout:
            logger.info("idle for %.0fs (limit %.0fs) - shutting down", idle, timeout)
            server = getattr(app.state, "server", None)
            if server is not None:
                server.should_exit = True
            return


def create_app(config: Settings | None = None) -> FastAPI:
    cfg = config or settings
    # The interactive API docs are a local convenience, not something a public
    # demo needs to advertise.
    docs = {} if not cfg.demo else {"docs_url": None, "redoc_url": None,
                                    "openapi_url": None}
    app = FastAPI(title="OpenDSS Designer", lifespan=_lifespan, **docs)
    app.state.settings = cfg
    app.state.activity = None

    if cfg.idle_timeout_s:
        # Held on app.state so the idle task can read the counter.
        app.add_middleware(_track_activity, app_state=app.state)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
    app.add_middleware(SecurityHeadersMiddleware)
    # Always on: in a local install it only echoes X-Request-ID if a client
    # sends one; the limits header is ignored unless the env var names it.
    app.add_middleware(RequestContextMiddleware)
    if cfg.max_body_bytes:
        app.add_middleware(BodySizeLimitMiddleware, max_bytes=cfg.max_body_bytes)
    app.include_router(router)

    if (STATIC_DIR / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            # An unknown /api/* path is a bug, not a deep link; returning the
            # SPA with a 200 silently masks typos and bad client calls.
            if path.startswith("api/"):
                raise HTTPException(status_code=404, detail="Unknown API route")
            # `STATIC_DIR / path` alone is not safe: pathlib discards the left
            # operand when `path` is absolute ("C:/Windows/win.ini"), and ".."
            # segments escape upward. Resolve, then require containment.
            root = STATIC_DIR.resolve()
            index = root / "index.html"
            if not path:
                return FileResponse(index)
            candidate = (root / path).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index)

    return app


app = create_app()
