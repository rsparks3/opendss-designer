# IEEE PES distribution test feeders

The 13, 34, 37 and 123-bus radial test feeders, as a benchmark for the engine
and a yardstick for the importer. `tests/ieee_feeders.py` reads them,
`tests/test_ieee_feeders.py` asserts on them in CI, and
`scripts/ieee_validation.py` turns them into `docs/validation.md`.

## Where the files come from

**The `.dss` files are EPRI's**, copied unchanged on 2026-09-18 from the
OpenDSS test-case collection maintained by DSS-Extensions:
<https://github.com/dss-extensions/electricdss-tst/tree/master/Version8/Distrib/IEEETestCases>
(folders `13Bus`, `34Bus`, `37Bus`, `123Bus`). They are BSD-licensed; the
licence is in `License.txt` beside this file. Two things differ from the
upstream folders:

- Each folder there holds a one-line `IEEELineCodes.DSS` stub that redirects
  to `../IEEELineCodes.DSS`. The stub is replaced by a copy of that shared
  file, so every folder is self-contained and can be handed to the importer
  as one file set (the importer rewrites file references to their base name,
  and a file redirecting to another file of the same name would loop).
- The `Run_*.dss` scripts, plot scripts and the 123-bus load-shape and PV
  extras are not copied, nor is `IEEE123Switches.dss`, which is a second
  master file (it defines its own circuit) rather than a companion. The
  tap-locking commands from the run scripts' "2nd script" live in
  `tests/ieee_feeders.py` as `published_taps`.

**The published solutions** (`published-voltages.csv` in each folder) were
transcribed from the *Radial Power Flow* reports in each feeder's package on
the IEEE PES Test Feeder site, <https://cmte.ieee.org/pes-testfeeders/resources/>
(`feeder13.zip`, `feeder34.zip`, `feeder37.zip`, `feeder123.zip`; the
`VOLTAGE PROFILE` table in the `.doc` report, dated 2004-06-24). Columns are
`node, phase, vmag_pu, angle_deg`. The 37-bus table is line-to-line
(A-B, B-C, C-A under phases A, B, C); the others are line-to-neutral. Nodes
such as `RG60`, `XFXFM1`, `RG1`-`RG4`, `XF1` are Kersting's regulator and
transformer output pseudo-nodes and have no bus in EPRI's file unless the
file defines one (`RG60` in the 13-bus does).

## Modelling notes

The 13-bus and 123-bus files already zero out the substation transformer and
regulator impedances to match Kersting's ideal devices, and say so in their
comments. The 37-bus file does not, so `tests/ieee_feeders.py` applies the
same change to it before every run, with the reason recorded next to each
command. Nothing is changed on the 34-bus.
