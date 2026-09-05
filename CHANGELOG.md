# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## 0.5.0 — 2026-09-05

### Added

- **Save circuits in the browser.** Save (Ctrl+S) keeps the whole project in
  the browser's own storage under a name: the first save asks for one, later
  saves are silent. Save as… makes a copy, and Open… (Ctrl+O) lists what is
  saved with rename, delete and export. Saved circuits live in that browser
  on that device and are never uploaded; clearing site data removes them.
  The old file round-trip is still there as Export .json and Import (inside
  the Open dialog) for moving a project between machines or keeping a backup.
- **A permanent plan corner** in the toolbar on hosted instances, showing
  the plan name and its links (for example "Guest plan · Sign in"), so the
  way to sign in survives dismissing the banner. Banner dismissals are now
  remembered per plan, and the banner no longer repeats the storage note.

## 0.4.0 — 2026-09-05

Nothing here changes a local install. This release is the "worker contract":
the three generic reverse-proxy features a hosted gateway needs from the app,
each inert unless an operator turns it on. The app still has no user concept;
see [docs/hosted-service.md](docs/hosted-service.md) for the service it
enables and [docs/deployment.md](docs/deployment.md) for the contract.

### Added

- **Per-request limit tightening from a trusted header.** When
  `OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER` names a header, the JSON in it
  lowers the size, cost and timeout limits for that request only. It can
  never raise one: the process environment is the ceiling the box was sized
  for, so a proxy bug cannot grant more than the operator allowed. Unset by
  default, so a browser cannot talk a local install into anything.
- **Engine-time reporting.** `X-Engine-Seconds` on every response whose
  handler used the OpenDSS engine, and `engineSeconds` in the final event of
  a time-series stream. Measured on the engine thread, so it is engine time,
  not queue time.
- **Plan description passthrough.** The trusted header may carry a `plan`
  block (name, message, links). `/api/health` echoes it and the hosted-instance
  banner renders it, so a gateway can show "Free plan · 12 of 20 min used ·
  Upgrade" without the app knowing what an account is.
- **`X-Request-ID` passthrough.** A well-formed incoming id is echoed on the
  response and attached to every JSON log line, including lines written from
  the engine thread, so a proxy log and a worker log can be joined.

### Changed

- Limit messages name the caller's plan ("the Free plan is limited to 500")
  when a gateway supplies one, and keep saying "the public demo" otherwise.
- `/api/health` `limits` now includes `maxTimeseriesCost`.

## 0.3.0 — 2026-09-04

### Fixed

- **Starting a new circuit no longer destroys your unsaved work.** The autosave
  subscribed to every store change with no filter, so `New` (and `Open`, and
  `Import`) cleared the editor and then, 800 ms later, wrote that *empty*
  circuit over the only copy of the previous session's work. It now refuses to
  overwrite a recovery copy with an empty document, and skips the write
  entirely when nothing about the circuit actually changed.
- **Undo no longer walks into the previously open circuit.** `Open` left the
  old document's undo history in place, so Ctrl+Z after opening a project
  reverted edits belonging to a different circuit. History is now cleared
  wherever a document is loaded.
- **Autosave works for large circuits again.** It lived in `localStorage`,
  which is capped near 5 MB per origin — a circuit with about three
  15-minute-year loadshapes exceeded it, and the resulting error was swallowed,
  so the people with the most to lose had no protection and no warning. Autosave
  now uses IndexedDB, falling back to `localStorage` where unavailable.

### Changed

- **Licence changed from MIT to AGPL-3.0-or-later.** The tool stays free to
  use, modify and self-host, including commercially. The one obligation added
  is the AGPL's network clause: if you run a *modified* version and let other
  people use it over a network, you must make those modifications available to
  them. Running an unmodified copy for yourself or your organisation carries no
  such obligation, and self-hosting remains a first-class supported path — see
  `NOTICE` for the reasoning and `docs/deployment.md` for the templates.
  Releases up to and including 0.2.0 remain available under MIT.
- **Project files now carry a checked format version.** The `version` field was
  written but never read, so a project saved by a newer build opened silently
  in an older one and lost anything it did not recognise on the next save. The
  version is now validated, malformed files fail with a readable message, and a
  document from the future opens with an explicit warning.
- **Element ids are now random rather than time-based**, so ids generated in
  different sessions cannot collide. Existing files are unaffected.

## 0.2.0 — 2026-09-01

Everything here is opt-in. `pip install opendss-designer` and run it as before
and nothing below applies: demo mode is off by default, and every limit is
unset in local mode.

### Added

- **Demo mode** (`--demo`, or `OPENDSS_DESIGNER_MODE=demo`) for running a
  public instance: caps on circuit size, request size, import size, solver
  queue depth and time-series cost; bounded on-disk caches; rate-limited
  outbound data fetchers; no interactive API docs. Size limits appear in the
  Problems list as ordinary validation errors while you draw, rather than as a
  failure when you press Solve. See [docs/deployment.md](docs/deployment.md).
- **Sample circuits**, in a Samples dropdown in the toolbar: a demo substation
  and a radial feeder with PV, storage and a daily load shape.
- **`Dockerfile`** building a single-session container, and `--host` / `$PORT`
  / idle-shutdown support so one can be run per visitor.
- **Deployment and security documentation**, plus a `SECURITY.md`.
- Security headers on every response, and structured logging (JSON with
  `OPENDSS_DESIGNER_LOG_JSON=1`) for hosted instances.

### Unchanged for local use

Demo mode adds limits; it never removes features. Every endpoint, element type
and analysis works exactly as before, `--port` still picks the next free port
if busy, and a `PORT` environment variable set for something else does not
relocate your install. The one deliberate change: importing a `.dss` file now
skips trailing `solve`/`export`/`show` lines with a warning instead of running
them, which does not affect the diagram it builds.

### Fixed

- **The OpenDSS engine no longer changes the process working directory.**
  Setting the engine's data path chdir'd the whole process, so every relative
  path in the program silently resolved somewhere else afterwards.
- **A time-series run no longer holds every sample in memory.** Long runs
  bucketed only at the end, so a yearly run allocated steps x elements floats;
  the envelope is now accumulated as the run goes. Fixing the bucket size up
  front also keeps the time axis aligned with the data when a run is cancelled.
- `config/linecodes.csv` now ships inside the wheel. A `pip install` previously
  loaded **zero** conductor presets unless you happened to have a repo checkout
  and the right working directory.
- The time-series progress queue is bounded, so a backgrounded browser tab no
  longer lets events accumulate without limit.
- A busy solver returns 503 with `Retry-After` instead of parking request
  threads until the whole app stops responding.

## 0.1.3 — 2026-09-01

### Security

Users of 0.1.2 and earlier should upgrade. The static-file fix below is
exploitable against a local install by any web page you visit while the app is
running.

- **Fixed arbitrary file read in the static-file handler.** The single-page-app
  fallback joined the request path onto the static directory without checking
  containment, so `GET /C:/Windows/win.ini` (or a percent-encoded `..`
  traversal) returned any file the server process could read. Paths are now
  resolved and required to stay inside the static directory.
- **Added `Host` header validation.** The server binds `127.0.0.1`, but without
  host checking a malicious page could reach it by pointing its own domain at
  `127.0.0.1` (DNS rebinding). Only loopback names are accepted; deployments set
  `OPENDSS_DESIGNER_ALLOWED_HOSTS`.
- **Hardened `.dss` import.** Reference checking previously ran only on the file
  defining the circuit, so a second selected file could `Redirect` to, or `Save`
  over, anything on the server. Now every uploaded file is checked; file
  references are rewritten to their base name so no path can leave the import's
  temporary directory; file-writing and process-spawning commands (`save`,
  `export`, `show`, `docmd`, …) are refused; and `mult=(file=…)` style
  references, which the old check did not look at, are covered.
- **Disabled unused OpenDSS capabilities.** `AllowEditor` and `AllowChangeDir`
  defaulted to on; with `AllowDOScmd` they are now explicitly off, so an
  imported script cannot spawn an editor, run a shell command, or move the
  server's working directory.
- **Allowlisted element property values.** `conn`, `units` and `dispatch` were
  interpolated into OpenDSS commands verbatim, letting a crafted circuit append
  extra properties to its own elements. Non-finite numbers (JSON `1e999`) and
  out-of-range phase counts are now rejected too.
- **Stopped leaking server details to the browser.** Responses no longer include
  the absolute path of `linecodes.csv` or the generated command list, temporary
  paths are redacted from OpenDSS error messages, and an unexpected failure
  during a time-series run reports a generic message instead of the raw
  exception.

### Fixed

- `/api/health` no longer waits on the OpenDSS engine, so it still answers while
  a long solve is running (a health check used to hang behind it).
- `redirect sub/codes.dss` now resolves to the matching selected file instead of
  failing to compile.
- An unusable uploaded file name (`..`) returns a clear error rather than a 500.
- Unknown `/api/*` routes return 404 instead of the app's HTML with a 200.

## 0.1.2

- Shape-preserving routing points; drag-to-re-route; grid-snap fix for symbol
  terminals; macOS SIGILL fix (FP traps re-masked when entering the DSS library).

## 0.1.1

- Single dedicated OpenDSS engine thread (fixes a CI segfault); full component,
  analysis, shapes and time-series documentation.

## 0.1.0

- Initial release.
