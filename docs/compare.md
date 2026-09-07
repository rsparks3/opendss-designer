---
title: OpenDSS Designer vs OpenDSS-G vs the built-in OpenDSS interface
description: An honest comparison of the graphical options for OpenDSS — EPRI's built-in Windows program, EPRI's OpenDSS-G, and the browser-based, open-source OpenDSS Designer — including what each one cannot do.
---

# OpenDSS Designer, OpenDSS-G, or the built-in interface?

There are three graphical ways to work with OpenDSS. They are not
interchangeable, and the right one depends on what you are doing. This page
is written by the author of one of them, so read it with that in mind; the
"what it cannot do" rows are the ones to weigh.

## At a glance

| | Built-in OpenDSS program | OpenDSS-G | OpenDSS Designer |
| --- | --- | --- | --- |
| Made by | EPRI | EPRI | Independent, open source |
| Runs on | Windows | Windows | Any browser; server on Windows, macOS, Linux; or hosted |
| How you build a model | Write `.dss` script | Graphical objects and forms, plus script | Draw the one-line diagram; the drawing is the model |
| Results | Text reports, plot windows | Plots, geographic view | Overlays on the diagram, hover details, graphs, spreadsheet |
| Time series | Yes, by script and monitors | Yes | Daily and yearly with a scrubber over the diagram |
| Element coverage | Everything OpenDSS has | Most of OpenDSS | The substation and feeder essentials; see below |
| Install | Download | Download | `pip install`, or nothing (hosted) |
| Licence | Free, EPRI terms | Free, EPRI terms | AGPL-3.0, source on GitHub |
| Cost | Free | Free | Free; hosted copy free with limits, paid plan for larger runs |

## The built-in OpenDSS program

This is the executable in the standard OpenDSS download: a script editor
with a menu bar, the command window, and plotting. Every feature of the
engine is reachable from it, because it *is* the engine with a text front
end. It is the reference. If you already write DSS scripts fluently, it may
be all you need.

What it is not: a way to build a model without writing the script, or a way
to see the circuit as a drawing while you edit it. The plot window shows a
circuit once it has bus coordinates, but you do not edit there.

## OpenDSS-G

EPRI's graphical application over OpenDSS. You describe the system with
graphical objects and property forms, can lay elements out geographically,
and get plots and reports. It is the most complete graphical option for the
full breadth of OpenDSS features, including the controls and protection
elements that a distribution planner needs.

What it is not: cross-platform, browser-based, or open source. It is a
Windows desktop application, and the drawing is a way to build and inspect
a scripted model rather than the model itself.

## OpenDSS Designer

A one-line diagram editor in the browser. You draw a substation or a feeder
the way you would sketch it on a whiteboard, and every solve compiles that
drawing into OpenDSS commands and runs them through the real engine via
OpenDSSDirect.py. Results come back as overlays: voltage in per unit on the
buses, loading pies on the lines and transformers, red where something is
out of band. Import brings an existing `.dss` model in with an automatic
layout; export writes a `.dss` script anyone can run in the other two tools.

It runs anywhere Python runs, or as a hosted copy with nothing to install,
and it is AGPL-licensed so it can be read, changed and self-hosted.

What it is not, as of this writing:

- **Complete.** It covers sources, busbars, two-winding transformers,
  breakers, lines, loads, capacitors, generators, PV and storage. Voltage
  regulators, three-winding transformers, fuses, reclosers and relays are on
  the [roadmap](https://github.com/rsparks3/opendss-designer/blob/main/FUTURE_IMPROVEMENTS.md)
  and not in the tool. If your study needs them today, use OpenDSS-G or
  script it.
- **Geographic.** The canvas is a schematic, not a map. Bus coordinates from
  an imported model are used for the initial layout and then it is a
  one-line.
- **A replacement for scripting at scale.** A thousand-element feeder is
  better imported than drawn, and unusual element types survive import only
  as a warning.

## Which one, then

- You know the DSS language and want every feature: the **built-in program**.
- You want a full-featured graphical desktop tool on Windows and do not mind
  that it is closed: **OpenDSS-G**.
- You want to draw a substation or a feeder and see it solve, teach OpenDSS
  to someone who will not learn the script, work on a Mac or Linux machine,
  or try something in a browser tab right now: **OpenDSS Designer**, at
  [opendssdesigner.ryanmsparks.com](https://opendssdesigner.ryanmsparks.com)
  or `pip install opendss-designer`.

They also combine. Drawing a feeder in OpenDSS Designer and exporting the
`.dss` gives you a clean script to carry on with in either EPRI tool.

*Corrections welcome. If something here about OpenDSS-G or the built-in
program is out of date, please
[open an issue](https://github.com/rsparks3/opendss-designer/issues).*
