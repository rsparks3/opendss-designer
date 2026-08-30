"""Build the frontend and copy it into the Python package's static dir.

Run before `python -m build` (or any packaging step):
    python scripts/build_frontend.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
FRONTEND = ROOT / "frontend"
STATIC = ROOT / "src" / "opendss_designer" / "static"


def main() -> None:
    npm = shutil.which("npm")
    if not npm:
        sys.exit("npm not found — install Node.js to build the frontend")
    subprocess.run([npm, "ci"], cwd=FRONTEND, check=True)
    subprocess.run([npm, "run", "build"], cwd=FRONTEND, check=True)
    if STATIC.exists():
        shutil.rmtree(STATIC)
    shutil.copytree(FRONTEND / "dist", STATIC)
    print(f"Frontend built and copied to {STATIC}")


if __name__ == "__main__":
    main()
