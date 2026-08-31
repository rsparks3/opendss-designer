# Time-series analysis

Simulate a day or a year of operation — loads following their shapes, PV
following the sun, storage charging and discharging — then scrub through the
results on the diagram itself.

Switch the toolbar to **Time series** mode. A transport bar appears under the
toolbar, and the snapshot **Solve** / **Auto** buttons gray out (individual
runs are disabled in this mode; switching back re-enables them).

## Running a simulation

Assign shapes first — loads need a [load shape](shapes.md), PV systems an
irradiance shape, storage a dispatch shape if using `follow` mode. Elements
without a shape hold their rated values for the whole run.

Then pick the horizon and step in the transport bar and press **▶ Run**:

| Horizon | Step | Steps solved |
|---|---|---|
| Daily | 1 h | 24 |
| Daily | 15 min | 96 |
| Yearly | 1 h | 8,760 |
| Yearly | 15 min | 35,040 |

Progress streams live into the Run button (click ✕ to cancel). The engine
drives the solution one step at a time and records **everything**
automatically — per-step voltage range at every bus and P/Q/current/loading
for every element — so there are no monitor elements to place, and any
element can be inspected after the run. Steps that fail to converge are
recorded as zeros and counted in the summary rather than aborting the run.

Any edit to the circuit clears the results (like every other result in the
app); re-run after changes.

## Scrubbing the results

When a run completes, the scrubber parks at the **system peak hour** and the
canvas overlays — voltage badges, loading pies, line colors, power labels,
hover tooltips — show the network at the scrubbed moment. Drag the slider to
move through time, or press the play button to animate through the run
(~10 steps per second). The readout shows the simulation time (`13.00 h` for
daily runs, `Jun 21, h 4092` for yearly).

Tooltips in this mode show each bus's recorded voltage min/max at that step
(per-phase magnitudes and angles are not recorded per step) and the element's
recorded power and loading.

!!! warning "Yearly runs scrub an envelope"
    Runs over 2,000 steps are downsampled for display into alternating
    minimum/maximum buckets (about half a day each for an hourly year). The
    scrubber then shows those envelope extremes — the bucket's worst case,
    which is usually what a planning study needs — **not the exact network
    state at a specific hour**. A dialog explains this when such a run
    completes, and an *envelope* chip stays on the transport bar. Daily runs
    are never downsampled and scrub exactly, step by step.

## The time graph

The **Graph** tab gains a **Time** sub-mode (selected automatically when a
run completes). Plot system totals (total P, losses), per-bus voltage min/max,
or per-element P/Q/current/loading over the run — one trace per selected
entity (up to 8; the picker defaults to the lowest-voltage buses or
most-loaded elements). Yearly plots get month-boundary axis labels; a dashed
cursor line tracks the transport-bar scrub position; zoom and pan work as in
the snapshot graph.

Above the plot, a summary table reports energy served and losses (MWh and
percent), peak demand and when it occurred, the voltage extremes with their
bus and hour, and the step count (with any non-converged steps flagged).

## Semantics worth knowing

- The same shape drives daily and yearly runs (daily shapes repeat across a
  year). OpenDSS interpolates when the step is finer than the shape interval.
- Storage state of charge carries through the run: it starts at *Initial
  charge* and evolves with dispatch and efficiencies, floored at *Reserve*.
- Snapshot mode is unaffected: it still solves the base case with shapes
  ignored — see [Solving & analysis](analysis.md#analysis-modes).
