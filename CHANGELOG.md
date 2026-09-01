# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
