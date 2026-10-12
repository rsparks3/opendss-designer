# Study reports

**File → Export → Study report…** (++ctrl+shift+e++) writes the study as a
**PDF**, an **Excel workbook**, or both. The sections follow what the
distribution planning tools print for a load-flow study, so the result can
go to a colleague, a design review or a regulator as it is.

Everything is built in the browser. If a study the report needs is out of
date or has not been run yet, the export runs it first: it solves the power
flow, and runs the fault study or the protection study when you ask for
those sections.

## Before you export

**File → Project properties…** holds two things the report prints:

- **Study**: title, case, engineer, company and a description. These make
  up the title page and every page header.
- **Abnormal-condition limits**: the undervoltage and overvoltage limits
  (pu), the loading level that counts as a warning, and the level that
  counts as an overload (% of rating). The defaults are ANSI C84.1 Range A
  (0.95–1.05 pu) and 100 % of rating. The same limits colour the canvas
  overlays and legends, draw the limit lines on the profile plots, and set
  the solve's violation flags, so the drawing and the report always agree.
  They are saved with the project.

The one-line in the report is drawn with whichever overlay is on
(voltages, loading, phases, …), so choose the overlay first.

## Sections

| Section | Contents |
|---|---|
| **Title page** (always) | Study, case, circuit, who prepared it, date, software and solver versions, the planning criteria, and the number of each kind of element |
| **Load flow** | *Load flow summary*: source kW/kvar/kVA/PF, total load, generation, capacitors, losses (and their share of the power in), lowest and highest voltage and where they occur, and the number of violations and warnings |
| | *Abnormal conditions*: every bus under or over its voltage limits (or de-energized), and every element at or above the warning or overload level, with phase, value and limit: lines, transformers, regulators and switches by current against their ampere rating, generators, PV and storage by apparent power against their kVA rating, capacitors against the 135 % of rated current IEEE 18 allows continuously. Violations come first, worst first, then warnings |
| | *Bus voltages*: base kV (line-to-line), per-phase magnitude (pu) and angle, minimum, maximum and status, followed by a **voltage profile** against distance from the source with the limits drawn in |
| | *Branch flows*: from and to bus, phases, per-phase current, rating, loading %, P, Q and losses for every series element |
| | *Loads and generation*: each load's P, Q, S, PF and the voltage at its bus; generators, PV, storage and capacitors with their output, rating and loading |
| | *Losses*: by element type, with the circuit total, and by element, largest first |
| **One-line diagram** | The drawing as vectors, on a page turned to suit its shape (an 11×17 sheet for a large feeder), followed by a table of its [notes](components.md#note-n) |
| **Short circuit** | For every bus: three-phase and line-to-ground fault current, three-phase MVA, the Thevenin R1, X1, R0 and X0, and X/R |
| **Protection** | Every fuse, recloser and relay element: curve, pickup, the fault current available at its bus and how long it takes to operate at that current. Then interrupting duty (available fault current against each switch's interrupting rating) and the coordination findings, followed by a time-current plot |
| **Time series** | The last daily or yearly run: energy, losses and their share, peak demand and when, and the lowest and highest voltage with where and when. A demand/losses chart is included; the workbook also lists every step |

A section you cannot use yet is greyed out in the dialog, with the reason:
*Protection* needs at least one breaker, fuse, recloser or relay, and *Time
series* needs a run. The dialog remembers your format and sections in this
browser.

Rows outside the criteria are tinted: red for a violation, amber for a
warning.

## The PDF

US Letter. Tables with many columns go on landscape pages, and their
header row repeats when a table runs onto the next page. Every page after
the title page is headed with the study and circuit and footed with the
software version, date and page number. Figures are vectors, so the
one-line stays sharp however far you zoom in.

The PDF uses the standard PDF fonts, which cover Western European text,
and spells out the few symbols those fonts lack (φ as *ph*, Ω as *ohm*,
∠ as *Ang*). A report with anything beyond that, text in another script
in a name, a title or a note, is set in DejaVu Sans instead: the browser
fetches the typeface (about 2 MB, cached after the first time) only when a
report needs it, and such a report comes out a couple of hundred kilobytes
larger, with every character as typed and the symbols printed as
themselves. If the font cannot be fetched (offline, say), the report is
still written, with those characters as `?`. The workbook keeps everything
as typed either way.

## The workbook

Each section has its own sheet. Units are in the column headers, and
numbers are stored as numbers, formatted to the decimals shown in the PDF,
so the sheets sort, filter, sum and chart like any other data. The main
table on a sheet has its header row frozen and an autofilter. The one-line,
the profile, the TCC plot and the time-series chart are embedded as images.
The *Time series* sheet adds every recorded step; for a long run that is the
minimum and maximum over each bucket of steps.

## Where the numbers come from

Every value comes from the OpenDSS engine's own solution, and no quantity
is recomputed by the report:

- Voltages are line-to-neutral per unit of each bus's base. Currents and
  powers are at an element's first terminal, the from bus, and power into an
  element is positive, which is why a source or generator appears as
  delivered power (the sign flipped) in the summary.
- The losses total is the engine's circuit figure. It can differ slightly
  from the sum of the elements listed, which covers only lines and
  transformers.
- Short-circuit values are OpenDSS's fault study: bolted faults, with loads,
  capacitors and storage left out.
- Protective device times are read off the same time-current curves the
  *Graph → TCC* view draws.

The IEEE test feeders shipped as samples reproduce the published solutions;
see [Validation](validation.md).
