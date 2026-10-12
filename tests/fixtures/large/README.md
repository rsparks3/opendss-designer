# Real-sized test feeders

EPRI's ckt5, ckt7 and ckt24 test circuits and the IEEE 8500-node feeder:
2,000 to 10,000 elements each, written the way utility models are written.
`tests/large_feeders.py` pushes each through the importer and the solve, and
`tests/test_large_feeders.py` holds the result to the engine's own solution
of the same files in CI.

## Where the files come from

Copied unchanged on 2026-10-12 from the OpenDSS test-case collection
maintained by DSS-Extensions, <https://github.com/dss-extensions/electricdss-tst>
(`Version8/Distrib/EPRITestCircuits/ckt5`, `ckt7`, `ckt24` and
`Version8/Distrib/IEEETestCases/8500-Node`). They are BSD-licensed by EPRI
and the DSS-Extensions contributors; the licence is in `License.txt` beside
this file.

Only the files each master actually uses are kept: the master, everything
it redirects to, its bus coordinates, and the data files its load shapes
read. Left out are the run scripts, plot scripts, monitors no master loads,
the 8500-node folder's unbalanced variant (`Master-unbal.dss` and
`UnbalancedLoads.DSS`), its cloud-transient and PV scenario scripts, and its
second line-code library.

## What each one exercised

Each of these broke the importer before M11:

| Feeder | Elements | What it found |
|---|---|---|
| ckt5 | 4,411 | Eleven open ties written `enabled=False` were dropped; 240 V service buses read 1.75 pu because the file's `voltagebases` were not kept; names with a dash broke the `CapControl`s that referred to them |
| ckt7 | 2,232 | Did not import: the master redirects to the file that defines the circuit, and the importer compiled that file alone. Then 0.027 pu low: the CVR load exponents and the source's X/R were not kept |
| ckt24 | 9,967 | A bus at 269 pu: two-phase lines named a one-phase line code. Its 230/34.5 kV substation transformer has an LTC and was turned into a 230/230 kV regulator. 420 kvar short at the head: transformer magnetising current was dropped |
| 8500-node | 6,103 | Did not converge in 15 iterations; the centre-tapped service transformers' unequal winding resistances were averaged |

All four now come back within 1e-5 pu at every node, except ckt7 at 2e-4
pu (4 kW of its 76.5 MW is unaccounted for at the source).

Compiling the original ckt24 files writes a trace CSV beside them (its
`RegControl` has `debugtrace=yes`), so the reference solve compiles from a
temporary copy.
