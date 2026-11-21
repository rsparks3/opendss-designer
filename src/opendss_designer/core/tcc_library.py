"""Generic relay curve families as OpenDSS `TCC_Curve` points (facility plan 2.5).

The engine ships IEEE moderately, very and extremely inverse (`mod_inv`,
`very_inv`, `ext_inv`) and `definite`. These add the IEC 60255-151 standard,
very, extremely and long-time inverse curves and the IEEE short-time inverse
(the US "U5" curve), computed from their published formulas at a time dial
(TMS) of 1 -- the relay's *time dial* scales them. They are formula curves,
not manufacturer data, so the roadmap's "no curve library" decision stands.

The compiler emits one only when a device names it (and the circuit does not
define a curve of the same name itself), so a `.dss` export carries just what
it uses.
"""
from __future__ import annotations

# Multiples of pickup the curves are tabulated at. Straight lines between them
# on log-log paper follow these smooth formulas to well within 2 %.
MULTIPLES: tuple[float, ...] = (
    1.1, 1.2, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0,
    12.0, 15.0, 20.0, 25.0, 30.0,
)

# name -> (label, k, alpha, b): t = k / (M^alpha - 1) + b, at a time dial of 1.
FAMILIES: dict[str, tuple[str, float, float, float]] = {
    "iec_si": ("IEC standard inverse", 0.14, 0.02, 0.0),
    "iec_vi": ("IEC very inverse", 13.5, 1.0, 0.0),
    "iec_ei": ("IEC extremely inverse", 80.0, 2.0, 0.0),
    "iec_lti": ("IEC long-time inverse", 120.0, 1.0, 0.0),
    "ieee_sti": ("IEEE short-time inverse (U5)", 0.00262, 0.02, 0.00342),
}


def seconds(name: str, multiple: float) -> float:
    _, k, alpha, b = FAMILIES[name]
    return k / (multiple**alpha - 1.0) + b


def points(name: str) -> tuple[list[float], list[float]]:
    return list(MULTIPLES), [round(seconds(name, m), 5) for m in MULTIPLES]


GENERIC_CURVES: dict[str, tuple[list[float], list[float]]] = {n: points(n) for n in FAMILIES}


def label(name: str) -> str:
    return FAMILIES[name][0]


def command(name: str) -> str:
    mult, secs = GENERIC_CURVES[name]
    return (f"new tcc_curve.{name} npts={len(mult)} "
            f"c_array=({' '.join(f'{m:g}' for m in mult)}) "
            f"t_array=({' '.join(f'{s:.5g}' for s in secs)})")
