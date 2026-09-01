"""Per-process token buckets for the endpoints that make outbound requests.

Per *process*, not per IP, on purpose: the demo runs one process per visitor
session, so a process-wide budget is already a per-visitor budget. Per-IP
limiting belongs at the wrapper's edge, where the real client address is known
and where a single visitor cannot be split across containers.

These bound this deployment's own outbound traffic -- our share of a third
party's quota, and the disk the responses land on. They are not a security
boundary for the upstream services.
"""
from __future__ import annotations

import threading
import time


class RateLimited(Exception):
    """Budget for this window is spent."""


class TokenBucket:
    """Refills continuously at `capacity` tokens per `per_seconds`."""

    def __init__(self, capacity: int | None, per_seconds: float, name: str = ""):
        self.capacity = capacity
        self.per_seconds = per_seconds
        self.name = name
        self._tokens = float(capacity or 0)
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def take(self, tokens: float = 1.0) -> None:
        """Spend `tokens`, or raise RateLimited. No-op when uncapped."""
        if self.capacity is None:
            return
        with self._lock:
            now = time.monotonic()
            rate = self.capacity / self.per_seconds
            self._tokens = min(self.capacity,
                               self._tokens + (now - self._updated) * rate)
            self._updated = now
            if self._tokens < tokens:
                wait = max(1, int((tokens - self._tokens) / rate))
                raise RateLimited(
                    f"The public demo limits {self.name or 'these requests'} to "
                    f"{self.capacity} per "
                    f"{'minute' if self.per_seconds <= 60 else 'hour'}. "
                    f"Try again in about {wait} second{'s' if wait != 1 else ''}."
                )
            self._tokens -= tokens
