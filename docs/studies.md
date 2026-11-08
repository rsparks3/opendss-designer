---
description: The planning studies in OpenDSS Designer's Studies tab — N-1 contingency and tie restoration, transfer capability, Volt/VAR setting sweeps, CVR, capacitor placement, phase balancing, loss evaluation and feeder capacity.
---

# Planning studies

The **Studies** tab holds the batch studies a distribution planner is asked
for, each run on the open scenario at the active load level, each kept
until the next run and printed in the report's **Planning studies**
section. Hosting capacity has [its own page](hosting-capacity.md).

## Contingency

**N-1.** Every closed switch and protective device (and, if asked, every
line and transformer) is taken out in turn. For each: the load left dark;
the normally-open **tie switch** that restores the most of it, chosen
among the breakers marked *Tie switch* in their properties (or every
normally-open breaker when none is marked); the lowest voltage and highest
loading while the tie carries it; and the violations that appear. Ranked
by the load that cannot be restored. A tie restoring load but bringing a
new violation is still offered, with the count; tick nothing and it is the
planner's call.

**Transfer capability.** For a tie: close it, isolate one side at the
first switch between it and its source (so the tie feeds that side), and
scale that side's load until the voltage limit or the active level's
rating (normal or emergency) binds. Reported both ways: the load
transferred, the load the other feeder can carry, as a multiple of the
present load, and whether the present load can be carried at all.

**Switching sequences** (`POST /api/switching`): a list of open/close
steps applied in order and solved after each, with the load dark and the
worst voltage and loading at every step; the material of a restoration
plan. The scenario manager is the way to keep one.

## Volt/VAR and CVR

**Setting sweep.** A regulator's setpoint, bandwidth or line-drop R and X,
or a controlled capacitor's on/off settings and delay, run through a list
of values, a day of the loadshapes per value (24 or 96 solves): energy,
losses, voltage range, control operations and violation counts in one
table, rows without violations first and then by losses. Several
elements at once give the cartesian product (the API takes a list of
sweeps). Without loadshapes every hour is the same, and the tab says so.

**CVR.** Paired daily runs at the present regulator setpoints and at a
chosen number of volts (120 V base) lower, or the source voltage lowered
by the same share when there is no regulator: energy saved, the voltage
reduction, their ratio as the **CVR factor**, losses saved, and the lowest
customer voltage afterwards. It needs loads on a voltage-dependent model
(CVR model 4 with its factors, or ZIP model 8); constant-power loads save
nothing, and the tab warns.

**Capacitor placement.** A bank of a given size tried at every three-phase
primary bus: the loss reduction and the lift in the lowest voltage, with
any placement that pushes a bus over the upper limit set aside. Greedy
for several banks: the best is kept and the search repeats.

## Phase balance

The current unbalance at the feeder head (largest deviation of a phase
current from the mean, as a share of the mean) and the voltage unbalance
at every three-phase bus (the same on the phase-to-neutral magnitudes).
Then every single-phase **lateral** (a connected run of single-phase
elements off a three-phase bus) is tried on each other phase: the head
unbalance after the move, the change in losses, the worst voltage
unbalance. Moving a lateral changes the bus nodes the compiler writes, so
each trial is a rebuild and a solve. *Apply* re-pins the lateral on the
drawing, in the open scenario if one is open.

## Losses and capacity

**Loss evaluation.** A day or a year of the loadshapes, the engine's
per-element losses read at every step and summed by class (lines,
transformers, regulators, switches and protective devices, reactors):
kWh, share, cost at a price per kWh, and the losses at the system peak.

**Capacity.** The load multiplier at which the feeder first breaks a
criterion, undervoltage or an overload at the active level's rating, by
bisection: the capacity in kW, the headroom above the present case, what
binds and where. OpenDSS's own `Capacity` command answers the same
question from EnergyMeter registers; this needs no meter and says why.

## What has been checked

`tests/test_m14_studies.py` holds each study to a two-feeder circuit with a
tie and to a regulated feeder with a controlled capacitor: the N-1 loop
finds the tie and the load it restores, and ranks the unrestorable loss
first; transfer capability transfers the isolated side's load and finds a
larger multiple for the lighter feeder; a sweep gives more energy at a
higher setpoint and sorts clean rows first; CVR saves energy with CVR
loads and nothing with constant-power ones; placement reduces losses and
prefers the far end; the best phase move lowers the head unbalance when
applied; losses by class sum to the total; and the capacity multiplier is
confirmed by solving just under and just over it.
