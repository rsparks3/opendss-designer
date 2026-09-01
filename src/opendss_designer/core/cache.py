"""Size-bounded on-disk caches.

Three directories grow from user requests and nothing ever removed anything:
the NREL profile cache (~313 reachable files at 10-30 MB each), the NSRDB
irradiance cache (keyed by rounded coordinates, so ~360k reachable keys), and
the loadshape side files written on every solve. Left alone they fill the disk
of a long-lived deployment.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def sweep(directory: Path, max_bytes: int | None) -> int:
    """Delete least-recently-used files until the directory fits the budget.

    Returns the number of bytes removed. Never raises: a cache that cannot be
    trimmed should degrade, not break the request that triggered the sweep.
    """
    if max_bytes is None or not directory.is_dir():
        return 0
    try:
        entries = []
        total = 0
        for path in directory.iterdir():
            if not path.is_file():
                continue
            stat = path.stat()
            entries.append((stat.st_atime, stat.st_size, path))
            total += stat.st_size
        if total <= max_bytes:
            return 0

        freed = 0
        for _atime, size, path in sorted(entries):
            if total - freed <= max_bytes:
                break
            try:
                path.unlink()
            except OSError:
                continue
            freed += size
            logger.info("cache: evicted %s (%d bytes) from %s",
                        path.name, size, directory)
        return freed
    except OSError:
        logger.warning("cache: could not sweep %s", directory, exc_info=True)
        return 0


def write_atomic(path: Path, text: str, encoding: str = "utf-8") -> None:
    """Write via a temp file and rename.

    Matters on a cache directory shared between sessions: a process killed
    mid-write would otherwise leave a truncated file that every later reader
    treats as a valid cache hit.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(text, encoding=encoding)
    tmp.replace(path)
