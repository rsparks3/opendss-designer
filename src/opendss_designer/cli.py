"""Console entry point: start the server and (locally) open the browser."""
from __future__ import annotations

import argparse
import os
import socket
import threading
import time
import urllib.request
import webbrowser

DEFAULT_PORT = 8721
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _find_free_port(host: str, start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port found")


def _open_when_ready(url: str) -> None:
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=1):
                break
        except Exception:
            time.sleep(0.2)
    webbrowser.open(url)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opendss-designer",
        description="One-line diagram designer for OpenDSS")
    parser.add_argument("--port", type=int, default=None,
                        help=f"port to bind (default {DEFAULT_PORT}, or $PORT)")
    parser.add_argument("--host", default=None,
                        help="address to bind (default 127.0.0.1; use 0.0.0.0 "
                             "in a container)")
    parser.add_argument("--no-browser", action="store_true",
                        help="don't open a browser window")
    parser.add_argument("--demo", action="store_true",
                        help="run with public-demo limits (see docs/deployment.md)")
    parser.add_argument("--idle-timeout", type=float, default=None,
                        metavar="SECONDS",
                        help="exit after this long with no activity (0 = never)")
    return parser


def main() -> None:
    args = build_parser().parse_args()

    # Flags are setters over the environment: uvicorn is given an import
    # string, so the app is constructed by importing the module and only the
    # environment can reach it. Set before importing anything that reads it.
    if args.demo:
        os.environ["OPENDSS_DESIGNER_MODE"] = "demo"
    if args.host:
        os.environ["OPENDSS_DESIGNER_HOST"] = args.host
    if args.idle_timeout is not None:
        os.environ["OPENDSS_DESIGNER_IDLE_TIMEOUT_S"] = str(args.idle_timeout)

    from .logging_config import configure_logging
    from .settings import reload_settings

    cfg = reload_settings()
    host = args.host or cfg.host

    env_port = os.environ.get("PORT", "").strip()
    explicit = args.port if args.port is not None else (
        int(env_port) if env_port.isdigit() else None)
    if explicit is not None:
        # A platform routes to the port it assigned and nothing else, so
        # quietly moving to the next free one would look like a dead service.
        port = explicit
    else:
        port = _find_free_port(host if host not in ("0.0.0.0", "::") else "127.0.0.1",
                               DEFAULT_PORT)

    configure_logging(cfg)

    import uvicorn

    from .server import app

    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    print(f"OpenDSS Designer running at {url}  (Ctrl+C to stop)")

    # A server install has no browser to open, and opening one is a hang risk.
    headless = args.no_browser or cfg.demo or host not in LOOPBACK or explicit is not None
    if not headless:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()

    # Config/Server rather than uvicorn.run so the idle watcher can ask for a
    # clean shutdown (server.should_exit), which is portable in a way that
    # signalling the process is not.
    # Single worker: the OpenDSS engine is a process-wide singleton.
    config = uvicorn.Config(app, host=host, port=port, workers=1,
                            log_level="info" if cfg.demo else "warning",
                            access_log=cfg.demo)
    server = uvicorn.Server(config)
    app.state.server = server
    server.run()


if __name__ == "__main__":
    main()
