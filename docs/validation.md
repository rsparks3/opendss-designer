---
description: How OpenDSS Designer's results compare with the published IEEE PES distribution test feeder solutions, and how much of a model survives import.
---

# Validation against the IEEE test feeders

*Generated 2026-09-19 by `scripts/ieee_validation.py` with OpenDSS Designer 0.6.0 on DSS C-API 0.14.5 (OpenDSS SVN 3723), OpenDSSDirect.py 0.9.4. The same comparison runs in CI (`tests/test_ieee_feeders.py`).*

The [IEEE PES Distribution Test Feeders](https://cmte.ieee.org/pes-testfeeders/resources/) are the benchmark every distribution planning tool is measured against: small radial feeders with unbalanced loads, single-phase laterals, regulators and capacitors, each with a published power-flow solution by W. H. Kersting. This page answers two separate questions about them.

1. **Does the engine reproduce the published solution?** OpenDSS Designer solves with OpenDSS itself (via OpenDSSDirect.py), so this is EPRI's own `.dss` file for each feeder, compiled and solved exactly as the app's Solve button would, with the regulator taps set to the values Kersting reports so that the comparison is of the power flow and not of two regulator control models.
2. **Does the model survive the Import button?** The same files are pushed through the importer, the resulting one-line is solved, and the answer is compared with the engine's own solution of the original file. Any gap here is the importer's, and it is what the *real models in* milestone (M11) is measured by.

Inputs: the `.dss` files are EPRI's, from the [OpenDSS test-case collection](https://github.com/dss-extensions/electricdss-tst/tree/master/Version8/Distrib/IEEETestCases) (BSD licence); the published voltage profiles were transcribed from the radial power-flow reports in each feeder's package on the IEEE site. Both live under `tests/fixtures/ieee/` with a README on provenance.

## 1. Engine against the published solutions

Regulator taps locked to the published values. Deviation is the absolute difference in per-unit voltage magnitude at every node (bus and phase) in the published profile.

| Feeder | Node-phases | Max deviation (pu) | Mean deviation (pu) | Beyond tolerance | Tolerance |
|---|---:|---:|---:|---:|---:|
| IEEE 13-bus | 35 | 0.0013 | 0.00044 | 0 | 0.002 |
| IEEE 34-bus | 86 | 0.0013 | 0.00063 | 0 | 0.002 |
| IEEE 37-bus | 111 | 0.0001 | 0.00003 | 0 | 0.001 |
| IEEE 123-bus | 259 | 0.0014 | 0.00017 | 0 | 0.002 |

Tolerance is 0.002 pu, which is the resolution of the published tables (four decimals) plus one rounding step. The 37-bus is held to 0.001 pu because, with the modelling assumptions listed under it, it matches to the last published digit.

### IEEE 13-bus

File: `13Bus/IEEE13Nodeckt.dss`. Published profile is line-to-neutral.

Taps used: reg1 +10, reg2 +8, reg3 +11.

Largest deviations:

| Bus | Phase | Published | Solved | Deviation |
|---|---|---:|---:|---:|
| 675 | C | 0.9758 | 0.9771 | 0.0013 |
| 692 | C | 0.9777 | 0.9790 | 0.0013 |
| 680 | C | 0.9778 | 0.9790 | 0.0012 |

Published nodes with no bus in EPRI's file (regulator and transformer output pseudo-nodes): XFXFM1.

### IEEE 34-bus

File: `34Bus/ieee34Mod1.dss`. Published profile is line-to-neutral.

Taps used: creg1a +12, creg1b +5, creg1c +5, creg2a +13, creg2b +11, creg2c +12.

Largest deviations:

| Bus | Phase | Published | Solved | Deviation |
|---|---|---:|---:|---:|
| 890 | B | 0.9235 | 0.9248 | 0.0013 |
| 888 | B | 0.9983 | 0.9996 | 0.0013 |
| 852 | B | 0.9680 | 0.9692 | 0.0012 |

Published nodes with no bus in EPRI's file (regulator and transformer output pseudo-nodes): RG10, RG11, XF10.

### IEEE 37-bus

File: `37Bus/ieee37.dss`. Published profile is line-to-line, as Kersting reports this three-wire delta feeder.

Changes applied to EPRI's file before solving, each for the reason given:

- `Transformer.SubXF.Xhl=0.0001`, `Transformer.SubXF.%rs=[0.00001 0.00001]` - the published case starts at 1.0 pu at bus 799; EPRI's file keeps an 8 % substation transformer, which drops 799 to 0.92 pu at this load. EPRI's 13-bus file makes the same change itself.
- `Transformer.reg1a.XHL=0.001`, `Transformer.reg1a.%loadloss=0.00001`, `Transformer.reg1c.XHL=0.001`, `Transformer.reg1c.%loadloss=0.00001` - Kersting's regulators are ideal; EPRI's file gives the open-delta bank 1 % reactance, which costs 0.01 pu at the regulator output. EPRI's 123-bus file uses 0.001 % for the same reason.

Taps used: creg1a +7, creg1c +4.

Largest deviations:

| Bus | Phase | Published | Solved | Deviation |
|---|---|---:|---:|---:|
| 729 | A | 1.0157 | 1.0156 | 0.0001 |
| 706 | A | 1.0204 | 1.0203 | 0.0001 |
| 736 | B | 0.9951 | 0.9952 | 0.0001 |

Published nodes with no bus in EPRI's file (regulator and transformer output pseudo-nodes): RG7, XF7.

### IEEE 123-bus

File: `123Bus/IEEE123Master.dss`. Published profile is line-to-neutral.

Taps used: creg1a +7, creg2a -1, creg3a +0, creg3c -1, creg4a +8, creg4b +1, creg4c +5.

Largest deviations:

| Bus | Phase | Published | Solved | Deviation |
|---|---|---:|---:|---:|
| 81 | B | 1.0352 | 1.0338 | 0.0014 |
| 82 | B | 1.0364 | 1.0350 | 0.0014 |
| 83 | B | 1.0375 | 1.0362 | 0.0013 |

Reported but not held to the tolerance:

- **Bus 610** (A 0.9880 vs 0.9960, B 1.0256 vs 1.0097, C 1.0052 vs 1.0134): the 480 V secondary of transformer XFM1. Kersting's solution treats the 150 kVA delta-delta unit differently from the engine (the three phases are off by -0.008, +0.016 and -0.008 pu); every 4.16 kV bus agrees.

Published nodes with no bus in EPRI's file (regulator and transformer output pseudo-nodes): RG1, RG2, RG3, RG4, XF1.

## 2. With the regulators left to the engine

The same files with `RegControl` active, which is how a user would run them. Kersting's tap positions come from a different control model, so the engine settles one or more steps away on some regulators and the voltages move by a step's worth (0.00625 pu each). EPRI's own run files note the same thing.

| Feeder | Max deviation (pu) | Mean deviation (pu) | Engine taps | Published taps |
|---|---:|---:|---|---|
| IEEE 13-bus | 0.0135 | 0.01015 | reg1 +9, reg2 +6, reg3 +9 | reg1 +10, reg2 +8, reg3 +11 |
| IEEE 34-bus | 0.0127 | 0.00583 | creg1a +14, creg1b +4, creg1c +5, creg2a +13, creg2b +13, creg2c +13 | creg1a +12, creg1b +5, creg1c +5, creg2a +13, creg2b +11, creg2c +12 |
| IEEE 37-bus | 0.0187 | 0.00912 | creg1a +7, creg1c +7 | creg1a +7, creg1c +4 |
| IEEE 123-bus | 0.0138 | 0.00588 | creg1a +6, creg2a +0, creg3a +2, creg3c +0, creg4a +10, creg4b +4, creg4c +6 | creg1a +7, creg2a -1, creg3a +0, creg3c -1, creg4a +8, creg4b +1, creg4c +5 |

## 3. What survives the Import button

Each feeder imported as a one-line and solved by the app, against the engine's solution of the original file (regulators free in both, line-to-neutral, the file exactly as shipped). This is the importer's scorecard: what the Import button keeps of a model.

| Feeder | Elements imported | Solves | Max deviation (pu) | Mean deviation (pu) | Losses, app / engine (kW) |
|---|---:|:---:|---:|---:|---:|
| IEEE 13-bus | 35 | yes | 0.0000 | 0.00001 | 112.4 / 112.4 |
| IEEE 34-bus | 111 | yes | 0.0000 | 0.00000 | 273.5 / 273.5 |
| IEEE 37-bus | 71 | yes | 0.0000 | 0.00001 | 152.4 / 152.3 |
| IEEE 123-bus | 230 | yes | 0.0000 | 0.00001 | 96.0 / 96.0 |

Every element in all four feeders is read (nothing is reported as unsupported), every imported circuit solves and exports again, and the solution agrees with the original to the rounding of matrix entries on export (six significant figures). Losses agree to the same precision.

It did not start that way. Measured on 2026-09-18 the same table read 0.07 pu on the 13-bus with a third of its losses, because a `LineCode` defined by phase impedance matrices came back as the engine's default `r1 x1 r0 x0`, and three smaller properties were dropped: transformer `%loadloss`, the source's `MVAsc3`/`MVAsc1` and load `vminpu`. Line codes now travel with the circuit (see the Line codes tab), and the last 0.0015 pu on the 37-bus turned out to be a switch's `c1=0 c0=0`, which the engine's default capacitance is not. Switches now keep their own impedance and capacitance, regulators their winding connection.

## Reproducing this page

```
PYTHONPATH=src python scripts/ieee_validation.py
PYTHONPATH=src python -m pytest tests/test_ieee_feeders.py
```

The test holds section 1 to each feeder's tolerance and section 3 to 0.0005 pu and 0.2 % of losses, so an engine upgrade or an importer change that moves either shows up in CI before it shows up here.
