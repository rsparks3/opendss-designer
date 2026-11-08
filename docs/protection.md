---
description: Protection and reliability depth in OpenDSS Designer — faults anywhere on a line, device reach with DER, fuse-saving and fuse-blowing coordination, sectionalizers, reclose intervals, the settings sheet, MAIFI, ASAI, CEMI, ASIFI, outage cost and recloser placement.
---

# Protection and reliability depth

What the protection engineer and the reliability analyst ask for after the
time-current plot and the SAIFI/SAIDI study. Everything here runs from
**Studies → Protection** and the **Reliability** tab.

## Faults anywhere on a line

**Fault on a line** splits a chosen line at a chosen fraction of its length
in the compiled model, places a fault there — three-phase, line-to-ground,
line-to-line or double-line-to-ground, through a resistance for the ground
cases — and solves. It reports the current in the fault and the current
every protective device carries. `POST /api/faultline` is the route;
`POST /api/faultpoint` does the same at a bus.

## Reach

**Check every device's reach** finds, for every fuse, recloser and relay,
the buses of its protection section and the **minimum** fault current
among them: line-to-line bolted and line-to-ground through the resistance
given (20 Ω by default), from Fault-element solves. That against the
device's phase pickup (and its ground pickup against the line-to-ground
case) is the **reach ratio**; below 1.5 × pickup the device may not see
the fault at the end of its zone, and the row is flagged. DER in the zone
feeds the fault too, so the device sees less of it: the DER's contribution
(1.2 × rated current for inverters, 5 × for a machine) is taken off, and
both figures are shown.

## Fuse saving and fuse blowing

**Grade every recloser–fuse pair.** For each fuse with a recloser above it:
at the **maximum** fault at the fuse (the fault study's three-phase value)
the recloser's fast curve must operate before the fuse melts — the
fuse-saving test; at the **minimum** fault at the end of the fuse's zone
the fuse must clear before the recloser's delayed curve — the fuse-blowing
test. Total clearing time comes from the fuse's *Total-clear curve* when it
has one (a second curve, added like any other in the Curves tab), else
from its melting time times 1.15. Each pair says which tests it passes and
why not.

## Sectionalizers and reclose intervals

A breaker ticked **Sectionalizer** opens during the upstream recloser's
dead time after counting fault interruptions; it carries no curve and never
interrupts fault current itself. OpenDSS has no class for it, so for the
reliability sections it heads it compiles as a relay with a pickup nothing
reaches — the EnergyMeter counts it as a section boundary, the
coordination study leaves it out. A recloser's **Reclose intervals** (a
list of seconds, e.g. `0.5, 2, 5`) are written as the engine's
`recloseintervals`.

## Settings sheet

The report's protection section gained a **Settings** table, in the form a
relay technician reads: pickup in primary amps and as a multiple of the
device's continuous rating, curves, time dial (added delay), fast
operations and shots to lockout, reclose intervals, interrupting rating.

## Reliability indices

The **Reliability** tab and report add to SAIFI, SAIDI and CAIDI:

| Index | What it is |
|---|---|
| **MAIFI** | Momentary interruptions per customer per year: the temporary share of each recloser-headed section's faults (fault rate less the permanent share) interrupts every customer below the recloser. Fuses and relays make every fault sustained |
| **ASAI** | Availability, 1 − SAIDI/8760 |
| **CEMI₁, ₂, ₃, ₅** | The share of customers whose expected sustained interruptions a year exceed 1, 2, 3 or 5. The expectation, not a random draw: every load sees the permanent faults of its own section and of every section above it |
| **ASIFI** | SAIFI weighted by load kW instead of customers |
| **Outage cost** | Customer interruption cost: per sustained interruption and per customer-hour by load class (residential, commercial, industrial; a default for the rest), order-of-magnitude figures in the range of the US DOE ICE Calculator. Replace them with the utility's own |

## Where a recloser helps most

**Try a recloser on each line** places a recloser mid-way on each candidate
line in turn (longest first, up to forty), reruns the reliability study
and ranks the lines by the fall in SAIDI and the customer-hours saved. It
is the number that justifies the spend.

## What has been checked

`tests/test_m16.py` holds: a fault half-way along a line sits between the
currents at its two ends and every upstream device carries it; the reach
study finds every device's minimum fault and ranks the weakest reach first,
and DER in a fuse's zone lowers what the fuse sees; the recloser–fuse pair
is graded both ways from the curves; the recloser placement ranks by the
SAIDI fall; a sectionalizer heads a reliability section without appearing
in the TCC plot and reclose intervals compile; MAIFI, ASAI, CEMI, ASIFI
and the outage cost come out of the study, and a feeder with no recloser
has no momentary interruptions.
