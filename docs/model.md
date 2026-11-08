---
description: Model quality in OpenDSS Designer — conductor and geometry libraries, the transformer catalogue, the 120/240 V service transformer, the Model QA check, service-transformer loading, load allocation from meter data, adoption scenarios, growth levels and the change log.
---

# Model quality, libraries and the secondary

The model a planner will sign: where its data comes from, what is checked,
and how the secondary side is drawn.

## Conductors and geometries

The **Line codes** tab has three views. *Line codes* are the impedance
matrices lines refer to by name. *Conductors* are the wires themselves
(OpenDSS `WireData`, or `CNData` / `TSData` for a concentric-neutral or
tape-shield cable): resistance, GMR, radius and ampacity in the units the
conductor table gives them. *Geometries* (`LineGeometry`) hang conductors
on a pole or lay them in a trench: which conductor, where (x and height),
how many are phases and whether the neutral is Kron-reduced. A line's
**Geometry** field names one; the engine then builds the impedance matrix
from the conductors and their spacing with Carson's equations, and the
line needs no line code and no rating of its own (the conductors carry
one).

*From the library…* adds a conductor from `config/wiredata.csv`, a starter
set of standard ACSR, AAC, copper and 15 kV concentric-neutral sizes with
the values the standard tables publish. It is a CSV beside
`linecodes.csv`: add the conductors your utility strings. Imported `.dss`
files keep their wires and geometries whole, so a pole configuration can
be edited after import.

## Transformer catalogue

A transformer's **Pick from catalogue** field lists `config/transformers.csv`
— typical pole, pad and substation units — and applies the nameplate:
phases, kV, kVA, connections, impedance and losses. Edit the CSV to make
it your standards list.

## The 120/240 V service transformer

Tick **120/240 V centre-tapped service unit** on a single-phase transformer
and it compiles as the engine's single-phase three-winding form: the
primary on one phase, the two secondary half-windings between leg 1 and
the centre tap and the centre tap and leg 2. Downstream, a 120 V load pins
to phase **A** (leg 1) or **B** (leg 2) and a 240 V load takes **A-B**; a
triplex secondary is a two-phase line. The impedance is split the way
Kersting's interlaced model does (XHL = XHT = 1.2 X, XLT = 0.8 X, %r of
½R, R, R), and 0.208 kV joins the voltage bases so the 120 V legs read
1 pu.

## Model QA

**Studies → Model QA** is the one-click check to run on a converted model,
beyond the live validation that stops a solve. It lists, per element, what
a planner wants fixed: impedances still at the editor's placeholder,
lengths that cannot be right for the voltage class, loads without a kW,
customers or a class, voltage bases no winding matches, sources with no
short-circuit strength, devices with no interrupting rating, loops in a
radial feeder, normally-open breakers not marked as ties, elements out of
service and elements with no place on the map. A completeness table gives
the share of expected fields present per element class and an overall
score; the findings export to CSV and print in the report.

## Service transformers

**Studies → Service transformers** runs a day or a year of the loadshapes
and, for every service transformer (a split-phase unit, or any with a
secondary under 1 kV), reports the peak loading, the hours above 100 % and
150 % of rating, the hottest-spot temperature and the loss of insulation
life by IEEE C57.91 Clause 7 (65 °C-rise unit, loss ratio 5, exponents
0.8, the ambient you give), scaled to a year; and for every load under
1 kV the lowest voltage over the run in volts on the 120 V base against
114 V at the meter (ANSI C84.1 Range A). This is where an electrification
study is decided: four 7 kW chargers behind a 25 kVA transformer fail here
long before anything on the primary does.

## Load allocation

**Analysis → Allocate loads from meter data…** takes pasted CSV — billing
kWh for a period, demand kW, or AMI kW intervals — matched to the loads by
name, bus or class (a bus or class row splits evenly over its loads). kWh
becomes kW by the hours in the period and a load factor, one for all or
per class (`residential=0.45, commercial=0.6`); intervals become a
loadshape per load, normalised to the peak that becomes the load's kW. An
optional **metered feeder head** scales every load so the solved head
power matches it (two passes, since losses move with the loads). The
preview lists what matched, what did not and the head before and after;
apply it as a new scenario or to the open circuit.

## Adoption scenarios

**Analysis → Adoption scenario…** draws EV chargers, heat pumps or rooftop
PV at random among the loads of a class at a given adoption rate and size,
each adopter a new load (or PV system) on the parent load's bus with a
built-in shape — a home Level 2 charger in the evening, a workplace
charger by day, a heat pump on a cold day, a clear-day roof — or any shape
of the project's. Several **draws** with different seeds become several
scenarios, so *Run all* in the Scenarios tab shows the spread of outcomes.
The built-in shapes are typical, not measured; replace them with a
utility's own when there is one.

## Growth levels

In **Project properties → Load levels**, *Add growth levels* turns a base
year, a growth rate and a list of years ahead into load levels (×1.015⁵
for five years at 1.5 %), so a study year is a level like any other and
the batch solves every scenario at every year.

## Change log

Every parameter change is logged: when, by whom (the engineer named in the
study block), which element, which parameter, from what to what, and in
which scenario. Project properties shows the latest; the report's **Change
log** section prints it all. The log is saved with the project and is not
undone by Undo.

## What has been checked

`tests/test_m15.py` holds: a geometry compiles, solves, carries its
conductors' ampacity to the line and round-trips through `.dss` to the same
voltages; a split-phase transformer serves 120 V and 240 V loads and
compiles to the expected windings and impedances; the QA report finds a
long line, a placeholder impedance, a default rating and a loop; the
service-transformer run flags an overloaded unit with a hot spot above
110 °C and ranks the lowest meter voltage; allocation reproduces the kWh
arithmetic, splits a class row evenly, makes a shape from intervals and
hits a head target within 2 %; and the catalogues load with no errors.
