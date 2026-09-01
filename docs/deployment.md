# Deploying a hosted instance

OpenDSS Designer is built as a local, single-user tool: one process, one
OpenDSS engine, no accounts. Running it on the public internet is a different
setting, so the limits that setting needs are opt-in and off by default. A
`pip install` behaves exactly as it always has.

## Demo mode

```bash
opendss-designer --demo --host 0.0.0.0
# or
OPENDSS_DESIGNER_MODE=demo OPENDSS_DESIGNER_HOST=0.0.0.0 opendss-designer
```

Demo mode caps circuit size, request size, import size, solver queue depth and
time-series cost; bounds the on-disk caches; rate-limits the outbound data
fetchers; hides the interactive API docs; and enables request logging.

## One process per session

The OpenDSS engine is a **process-wide singleton** behind a single thread and a
single lock. That is not incidental: the underlying library is not thread-safe,
and every solve is a full rebuild. One process therefore serves one circuit at
a time, and a long run blocks every other request in that process.

So a hosted deployment should run **one container per visitor session** rather
than one shared instance. The container is designed for it: it binds `$PORT`,
exits on its own once idle, and keeps its scratch directory to itself.

```bash
docker build -t opendss-designer .
docker run --init -p 8721:8721 \
  -e OPENDSS_DESIGNER_ALLOWED_HOSTS=demo.example.com \
  -v opendss-cache:/cache \
  opendss-designer
```

`--init` matters: without it `SIGTERM` does not reach PID 1 and the graceful
shutdown never runs.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENDSS_DESIGNER_MODE` | `local` | `demo` turns on the limits |
| `OPENDSS_DESIGNER_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in a container) |
| `PORT` | `8721` | bound **exactly** when set, with no fallback scan |
| `OPENDSS_DESIGNER_ALLOWED_HOSTS` | loopback names | comma-separated `Host` allowlist |
| `OPENDSS_DESIGNER_WORKDIR` | per-process temp dir | DSS side files; never share between sessions |
| `OPENDSS_DESIGNER_CACHE_DIR` | workdir | downloaded NREL/NSRDB data; safe to share |
| `OPENDSS_DESIGNER_CONFIG` | packaged copy | directory holding a custom `linecodes.csv` |
| `OPENDSS_DESIGNER_IDLE_TIMEOUT_S` | 1800 in demo | exit after this long idle (0 = never) |
| `OPENDSS_DESIGNER_LOG_JSON` | off | one JSON object per log line |

Every limit has its own override: `OPENDSS_DESIGNER_MAX_NODES`, `MAX_EDGES`,
`MAX_SHAPES`, `MAX_SHAPE_POINTS`, `MAX_TOTAL_SHAPE_POINTS`, `MAX_BODY_BYTES`,
`MAX_IMPORT_FILES`, `MAX_IMPORT_BYTES`, `MAX_QUEUED_ENGINE_CALLS`,
`ENGINE_RESULT_TIMEOUT_S`, `TIMESERIES_TIMEOUT_S`, `MAX_TIMESERIES_COST`,
`MAX_CONCURRENT_TIMESERIES`, `NREL_CACHE_BYTES`, `NSRDB_CACHE_BYTES`,
`SHAPE_CACHE_BYTES`, `MAX_OUTBOUND_BYTES`, `GEOCODE_PER_MINUTE`,
`FETCH_PER_HOUR`. Setting one to `0` disables that cap.

!!! warning "Set OPENDSS_DESIGNER_ALLOWED_HOSTS"
    The default allowlist is loopback only. A reverse proxy forwards your real
    hostname, which is not in that list, so **every request returns 400** until
    you set this. The server logs a warning at startup if you forget.

## The shared cache

NREL profiles and NSRDB responses are public files keyed only by what was
requested, so one volume can serve every session. Without it, each new
container re-downloads 10-30 MB files. The cache is size-bounded and evicts
least-recently-used entries.

Two consequences worth knowing: one visitor's NSRDB API key fetches data that
later visitors read for free, and concurrent containers write to it, which is
why writes go through a temp file and a rename.

## What this app deliberately does not do

Adding any of this would tax the local tool that is the actual product:

- **Authentication and authorization.** There is no user concept.
- **TLS and HSTS.** Terminate TLS in front.
- **Per-IP rate limiting.** The built-in limits are per process, which under
  one-process-per-session is per visitor. Edge limiting sees the real client.
- **Container orchestration**, CPU and memory limits, read-only rootfs,
  dropped capabilities, and an absolute session TTL.
- **Egress filtering.** Allow only `oedi-data-lake.s3.amazonaws.com`,
  `developer.nlr.gov` and `geocoding-api.open-meteo.com`. That, not anything
  in this app, is the real containment for outbound abuse.

A wrapper deployment owns all of the above.
