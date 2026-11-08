"""Background jobs: the long studies, run off the request thread.

A snapshot solve answers in a request; a hosting-capacity study is
thousands of solves and does not. A job is submitted, runs on one worker
thread (so jobs queue behind each other the way engine calls do), reports
progress, can be cancelled, and keeps its result for a while so a client
that lost its connection -- or came back later -- can fetch it.

The job function is given a `progress(done, total, message)` callback and
a `threading.Event` to poll for cancellation, and returns a plain dict. It
must do its engine work through `core.engine`'s entry points (or be one
itself), which keep the single-engine-thread discipline.
"""
from __future__ import annotations

import contextvars
import logging
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .. import context

logger = logging.getLogger(__name__)

JobFn = Callable[[Callable[[int, int, str | None], None], threading.Event], dict[str, Any]]

# Results kept after completion, oldest dropped first.
KEEP_FINISHED = 20


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | failed | cancelled
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    done: int = 0
    total: int = 0
    message: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    engine_seconds: float = 0.0
    cancel: threading.Event = field(default_factory=threading.Event)
    # Woken on every change, so an SSE stream can wait without polling.
    changed: threading.Condition = field(default_factory=threading.Condition)
    # The request that submitted it; its limits overlay follows the work.
    ctx: contextvars.Context | None = None

    def snapshot(self, with_result: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "kind": self.kind, "status": self.status,
            "created": self.created, "started": self.started, "finished": self.finished,
            "progress": {"done": self.done, "total": self.total, "message": self.message},
            "engineSeconds": round(self.engine_seconds, 3),
        }
        if self.error:
            out["error"] = self.error
        if with_result and self.result is not None:
            out["result"] = self.result
        return out


class JobManager:
    def __init__(self, workers: int = 1) -> None:
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="study")

    def submit(self, kind: str, fn: JobFn) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, ctx=contextvars.copy_context())
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        self._pool.submit(self._run, job, fn)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [j.snapshot() for j in self._jobs.values()]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None:
            return False
        job.cancel.set()
        if job.status == "queued":
            self._finish(job, "cancelled")
        return True

    def events(self, job_id: str, timeout: float = 15.0) -> Iterator[dict[str, Any]]:
        """Progress snapshots as they change, then the final one with the
        result. Yields `None` when nothing changed for `timeout` seconds, so
        a stream can send a keep-alive."""
        job = self.get(job_id)
        if job is None:
            return
        last: tuple | None = None
        while True:
            with job.changed:
                state = (job.status, job.done, job.total, job.message)
                if state == last:
                    if not job.changed.wait(timeout):
                        yield {"type": "ping"}
                        continue
                    state = (job.status, job.done, job.total, job.message)
                last = state
                finished = job.status in ("done", "failed", "cancelled")
                snap = job.snapshot(with_result=finished)
            yield {"type": "result" if finished else "progress", **snap}
            if finished:
                return

    # --- internals -------------------------------------------------------------

    def _prune(self) -> None:
        finished = [j for j in self._jobs.values()
                    if j.status in ("done", "failed", "cancelled")]
        for j in finished[:-KEEP_FINISHED] if len(finished) > KEEP_FINISHED else []:
            self._jobs.pop(j.id, None)

    def _notify(self, job: Job) -> None:
        with job.changed:
            job.changed.notify_all()

    def _finish(self, job: Job, status: str, result: dict[str, Any] | None = None,
                error: str | None = None) -> None:
        job.status = status
        job.result = result
        job.error = error
        job.finished = time.time()
        self._notify(job)

    def _run(self, job: Job, fn: JobFn) -> None:
        if job.cancel.is_set():
            return
        job.status = "running"
        job.started = time.time()
        self._notify(job)

        def progress(done: int, total: int, message: str | None = None) -> None:
            job.done, job.total, job.message = done, total, message
            self._notify(job)

        def work() -> dict[str, Any]:
            return fn(progress, job.cancel)

        try:
            # Run inside the submitting request's context so the plan's
            # limits overlay reaches the engine thread, and bill the engine
            # time to the job rather than to a request that has long since
            # been answered.
            req = context.current_context() if job.ctx is None else job.ctx.run(context.current_context)
            result = job.ctx.run(work) if job.ctx is not None else work()
            if req is not None:
                job.engine_seconds = req.engine_seconds
            if job.cancel.is_set() and result.get("cancelled"):
                self._finish(job, "cancelled", result)
            else:
                self._finish(job, "done", result)
        except Exception as exc:  # noqa: BLE001 -- reported to the client
            logger.exception("Study job %s (%s) failed", job.id, job.kind)
            from .engine import EngineBusy  # local: engine imports are heavy
            message = (str(exc) if isinstance(exc, (EngineBusy, ValueError))
                       else "The study failed unexpectedly. Check the server log for details.")
            self._finish(job, "failed", error=message)


jobs = JobManager()
