"""Console entry point: start the local server and open the browser."""
from __future__ import annotations

import argparse
import socket
import threading
import time
import urllib.request
import webbrowser


def _find_free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
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


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="opendss-designer",
        description="One-line diagram designer for OpenDSS")
    parser.add_argument("--port", type=int, default=8721)
    parser.add_argument("--no-browser", action="store_true",
                        help="don't open a browser window")
    args = parser.parse_args()

    import uvicorn

    port = _find_free_port(args.port)
    url = f"http://127.0.0.1:{port}"
    print(f"OpenDSS Designer running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()
    # Single worker: the OpenDSS engine is a process-wide singleton.
    uvicorn.run("opendss_designer.server:app", host="127.0.0.1", port=port,
                workers=1, log_level="warning")


if __name__ == "__main__":
    main()
