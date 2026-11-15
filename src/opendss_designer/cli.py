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
        description="One-line diagram designer for OpenDSS (also: opendss-designer run --list)",
    )
    parser.add_argument(
        "--port", type=int, default=None, help=f"port to bind (default {DEFAULT_PORT}, or $PORT)"
    )
    parser.add_argument(
        "--host",
        default=None,
        help="address to bind (default 127.0.0.1; use 0.0.0.0 in a container)",
    )
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    parser.add_argument(
        "--demo", action="store_true", help="run with public-demo limits (see docs/deployment.md)"
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=None,
        metavar="SECONDS",
        help="exit after this long with no activity (0 = never)",
    )
    return parser


def _report_frontend_build() -> None:
    """Say which frontend build is being served, and when it was made.

    An editable install serves Python straight from the working tree but the
    browser bundle only changes when someone runs scripts/build_frontend.py --
    so a stale bundle looks exactly like a change that did not work. Naming it
    here makes that answerable from the terminal.
    """
    from .server import STATIC_DIR

    index = STATIC_DIR / "index.html"
    if not index.exists():
        print("  frontend: not built (run python scripts/build_frontend.py)")
        return
    built = time.strftime("%Y-%m-%d %H:%M", time.localtime(index.stat().st_mtime))
    bundles = sorted((STATIC_DIR / "assets").glob("index-*.js"))
    name = bundles[0].name if bundles else "?"
    print(f"  frontend build {name}  ({built})")


def run_main(argv: list[str]) -> int:
    """`opendss-designer run <project> --study <name> [--study ...] [--out file]`:
    the studies headless, on a saved project (.oneline.json) or a .dss
    file, writing one JSON object keyed by study name. `--list` names the
    studies. Options for a study go in `--options '{"hosting-capacity":
    {"method": "sensitivity"}}'`, or without the outer key when there is
    one study."""
    import json
    import sys
    from pathlib import Path

    parser = argparse.ArgumentParser(
        prog="opendss-designer run",
        description="Run planning studies on a saved project without the browser",
    )
    parser.add_argument("project", nargs="?", help="a .oneline.json project, or a .dss file")
    parser.add_argument(
        "--study",
        action="append",
        default=[],
        metavar="NAME",
        help="a study to run (repeatable); see --list",
    )
    parser.add_argument(
        "--options",
        default=None,
        metavar="JSON",
        help="options as JSON, keyed by study name (or flat for one study)",
    )
    parser.add_argument(
        "--scenario", default=None, help="run the named scenario id instead of the open one"
    )
    parser.add_argument("--level", default=None, help="run at the named load level")
    parser.add_argument(
        "--out", default=None, metavar="FILE", help="write the JSON here (default: stdout)"
    )
    parser.add_argument("--list", action="store_true", help="list the studies and exit")
    args = parser.parse_args(argv)

    from .studies.registry import STUDIES, run_study

    if args.list:
        width = max(len(k) for k in STUDIES)
        for name, (help_text, _fn) in STUDIES.items():
            print(f"  {name.ljust(width)}  {help_text}")
        return 0
    if not args.project or not args.study:
        parser.error("a project and at least one --study are needed (or --list)")
    from .core.model import Circuit

    path = Path(args.project)
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".dss":
        from .core.importer import import_dss_files

        circuit = Circuit.model_validate(
            import_dss_files([{"name": path.name, "text": text}])["circuit"]
        )
    else:
        circuit = Circuit.model_validate(json.loads(text))
    if args.scenario is not None:
        circuit = circuit.model_copy(update={"activeScenario": args.scenario or None})
    if args.level is not None:
        circuit = circuit.model_copy(update={"activeLevel": args.level or None})
    options = json.loads(args.options) if args.options else {}
    results: dict[str, object] = {}
    for name in args.study:
        if name not in STUDIES:
            print(f"unknown study {name!r}; see --list", file=sys.stderr)
            return 2
        opts = options.get(
            name, options if len(args.study) == 1 and not any(k in STUDIES for k in options) else {}
        )
        results[name] = run_study(name, circuit, opts if isinstance(opts, dict) else {})
    out = json.dumps(results, indent=1, default=str)
    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(out)
    return 0


def main() -> None:
    import sys

    if sys.argv[1:2] == ["run"]:
        raise SystemExit(run_main(sys.argv[2:]))
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

    # A platform routes to the port it assigned and nothing else, so quietly
    # moving to the next free one would look like a dead service. On a desktop
    # the opposite is true: --port is a starting point and finding a free one
    # is the friendly behavior. So an exact bind applies exactly when this
    # looks like a deployment -- and $PORT, which a user may well have set for
    # something else entirely, is only consulted there.
    deployment = cfg.demo or host not in LOOPBACK
    env_port = os.environ.get("PORT", "").strip() if deployment else ""
    requested = (
        args.port if args.port is not None else (int(env_port) if env_port.isdigit() else None)
    )
    if deployment:
        port = requested if requested is not None else DEFAULT_PORT
    else:
        port = _find_free_port(host, requested or DEFAULT_PORT)

    configure_logging(cfg)

    import uvicorn

    from .server import app

    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    print(f"OpenDSS Designer running at {url}  (Ctrl+C to stop)")
    _report_frontend_build()

    # A server install has no browser to open, and opening one is a hang risk.
    headless = args.no_browser or deployment
    if not headless:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()

    # Config/Server rather than uvicorn.run so the idle watcher can ask for a
    # clean shutdown (server.should_exit), which is portable in a way that
    # signalling the process is not.
    # Single worker: the OpenDSS engine is a process-wide singleton.
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        workers=1,
        log_level="info" if cfg.demo else "warning",
        access_log=cfg.demo,
    )
    server = uvicorn.Server(config)
    app.state.server = server
    server.run()


if __name__ == "__main__":
    main()
