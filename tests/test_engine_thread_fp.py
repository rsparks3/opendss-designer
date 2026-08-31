"""Regression: the DSS library must not be entered with FP traps armed.

Free Pascal's RTL enables the FPU trap bits (invalid / divide-by-zero /
overflow) the first time libdss_capi is entered from a thread it did not
create. OpenDSS then divides by a not-yet-initialized `Fundamental` while
building a circuit, and on macOS/arm64 a trapped FP exception arrives as
EXC_BAD_INSTRUCTION — SIGILL, the process gone with no traceback. Since the
engine pins every native call to a worker thread, that killed every solve.

The failure mode is a process kill, not an exception, so these run the work in
a subprocess and assert on the exit status: a regression shows up as a clean
test failure instead of taking the whole test session down with it.
"""
import platform
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SRC = str(Path(__file__).parent.parent / "src")


def _run(body: str) -> subprocess.CompletedProcess:
    script = f"import sys; sys.path.insert(0, {SRC!r})\n" + textwrap.dedent(body)
    return subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)


def test_engine_survives_off_main_thread():
    """A build+solve driven from the engine's worker thread must not crash."""
    proc = _run("""
        import opendssdirect as dss
        from opendss_designer.core import engine
        for i in range(3):
            engine._dss_executor.submit(
                lambda: [dss.Text.Command(c) for c in (
                    "clear", "new circuit.t%d" % i,
                    "new load.l1 bus1=sourcebus kv=12.47 kw=100", "solve")]
            ).result()
        print("ok")
    """)
    assert proc.returncode == 0, (
        f"engine thread died with {proc.returncode} "
        f"(-4/132 = SIGILL, the FP-trap crash)\n{proc.stderr}")
    assert "ok" in proc.stdout


@pytest.mark.skipif(sys.platform != "darwin" or platform.machine() != "arm64",
                    reason="fenv_t layout / trap bits below are arm64 macOS")
def test_fp_traps_stay_masked_on_engine_thread():
    """Directly assert the trap-enable bits are clear after entering the
    library, so a regression is caught even where a trap wouldn't be fatal."""
    proc = _run("""
        import ctypes
        import opendssdirect as dss
        from opendss_designer.core import engine

        def fp_env():
            # First 8 bytes of the thread's FP environment. On arm64 macOS
            # that is fpsr(4) + fpcr(4); trap-enable bits live in fpcr[12:8].
            libc = ctypes.CDLL(None)
            buf = (ctypes.c_uint32 * 2)()
            libc.fegetenv(ctypes.byref(buf))
            return buf[0], buf[1]

        def probe():
            dss.Text.Command("clear")
            dss.Text.Command("new circuit.t")
            return fp_env()

        fpsr, fpcr = engine._dss_executor.submit(probe).result()
        traps = (fpcr >> 8) & 0x1f
        print("fpcr=0x%x traps=0x%x" % (fpcr, traps))
        assert traps == 0, "FP traps armed on the engine thread: fpcr=0x%x" % fpcr
    """)
    assert proc.returncode == 0, f"{proc.stdout}\n{proc.stderr}"
