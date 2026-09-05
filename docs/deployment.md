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

## How many containers?

The OpenDSS engine is a **process-wide singleton** behind a single thread and a
single lock. That is not incidental: the underlying library is not thread-safe,
and every solve is a full rebuild. One process therefore serves one circuit at
a time, and a long run blocks every other request in that process.

What that does *not* imply is per-visitor containers. The server keeps **no
session state at all** — no cookies, no session ids, nothing user-scoped. Every
request carries the whole circuit and the engine rebuilds from it, so any
container can serve any request and no session affinity is needed.

So pick whichever fits your platform:

- **One shared container** — the simplest, and how the public demo runs. Solves
  serialise, and the admission control returns `503` with `Retry-After` when the
  queue is full rather than piling up. Fine until the demo is busy enough that
  visitors see those 503s.
- **A pool behind a load balancer** — horizontal scaling works with no affinity
  and no sticky sessions, because of the statelessness above.
- **One container per session** — worth it only on a platform that scales to
  zero and bills per request, where the idle timeout below earns its keep.

```bash
docker build -t opendss-designer .
docker run --init -p 127.0.0.1:8721:8721 \
  -e OPENDSS_DESIGNER_ALLOWED_HOSTS=demo.example.com,127.0.0.1,localhost \
  -v opendss-cache:/cache \
  opendss-designer
```

`--init` matters: without it `SIGTERM` does not reach PID 1 and the graceful
shutdown never runs.

!!! warning "Three things that will bite you"
    **Keep the loopback names in `OPENDSS_DESIGNER_ALLOWED_HOSTS`.** The value
    *replaces* the defaults, and the image's own `HEALTHCHECK` requests
    `Host: 127.0.0.1`. Drop them and the container runs but is permanently
    reported unhealthy.

    **Publish to `127.0.0.1`, not `0.0.0.0`.** Docker writes its own iptables
    rules, which your host firewall never sees — `-p 8721:8721` exposes the app
    on the public interface even with everything but 80/443 closed.

    **Set `OPENDSS_DESIGNER_IDLE_TIMEOUT_S=0` under a restart policy.** The
    idle shutdown exists for platforms that scale to zero. Combined with
    `restart: unless-stopped` it just cycles the container on a timer.

    And if a CDN sits in front, keep `ENGINE_RESULT_TIMEOUT_S` below its origin
    timeout (Cloudflare's is 100s) so a slow solve returns this app's error
    rather than the CDN's.

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

## Running behind a gateway: the worker contract

A hosted service with accounts, plans and metering is a *separate* program
(see [the hosted service plan](hosted-service.md)). What this app offers such
a gateway is three generic reverse-proxy features, all off unless configured,
so that the gateway can run **unmodified release images** of this app as
workers.

### Per-request limits from a trusted header

```bash
OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER=X-OpenDSS-Limits
```

With that set, a request carrying the named header has its JSON applied on
top of the process settings **for that request only**. Keys mirror
`/api/health`:

```json
{"maxNodes": 500, "maxEdges": 1000, "maxShapes": 8, "maxShapePoints": 8760,
 "maxTotalShapePoints": 50000, "maxImportFiles": 5, "maxImportBytes": 262144,
 "maxTimeseriesCost": 250000, "engineResultTimeoutS": 30,
 "timeseriesTimeoutS": 30,
 "plan": {"name": "Free", "message": "12 of 20 min used this month.",
          "links": [{"label": "Upgrade", "url": "/account"}]}}
```

Two rules make this safe to expose to a proxy you wrote yourself:

- **It only tightens.** Each value is `min(process value, header value)`;
  a value of zero or below is ignored rather than read as "no limit". The
  environment the worker started with is the ceiling the box was sized for,
  and nothing a request says can raise it.
- **Unset means ignored.** Without the variable the header is not read at
  all, which is the local default. Never expose a worker directly to
  browsers with the variable set: whoever can reach it can *lower* their own
  limits, which is harmless, and can label themselves any plan name, which is
  merely silly, but the intent is that only the gateway talks to workers.

A malformed header returns **400**, not a silently ignored header: it is a
bug in the proxy and should be loud.

Not overridable per request, because they are process-wide pools or fixed at
startup: the engine queue depth, concurrent time-series slots, fetch rate
buckets, cache sizes, the working directory, and `MAX_BODY_BYTES` (enforced
before routing).

### Engine time

Responses whose handler used the OpenDSS engine carry
`X-Engine-Seconds: 0.137`: the time the single engine thread spent on this
call, excluding any wait in the queue. A time-series stream cannot carry it in
headers (they are sent before the run), so its final event does:
`{"type": "result", "result": {...}, "engineSeconds": 6.31}`, likewise on
`error` events and on cancelled runs. This is the number to meter.

### Plan display

If the header includes `plan`, `/api/health` echoes it as `plan` and reports
the *effective* limits for that caller, and the banner in the UI renders the
plan name, the message, and the links (only `https://` URLs and site-relative
paths are accepted). Limit messages in the Problems list say "the Free plan
is limited to 500" instead of "the public demo". The app never decides who is
on which plan; it renders what it is told.

### Request ids

An incoming `X-Request-ID` matching `[A-Za-z0-9._:-]{1,64}` is echoed on the
response and included as `requestId` in every JSON log line the request
produces, including lines written from the engine thread and the time-series
worker thread.

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
