"""FastAPI app factory: API routes + built-frontend static serving."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api.routes import router
from .middleware import BodySizeLimitMiddleware, SecurityHeadersMiddleware
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


def create_app(config: Settings | None = None) -> FastAPI:
    cfg = config or settings
    # The interactive API docs are a local convenience, not something a public
    # demo needs to advertise.
    docs = {} if not cfg.demo else {"docs_url": None, "redoc_url": None,
                                    "openapi_url": None}
    app = FastAPI(title="OpenDSS Designer", **docs)
    app.state.settings = cfg

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
    app.add_middleware(SecurityHeadersMiddleware)
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
