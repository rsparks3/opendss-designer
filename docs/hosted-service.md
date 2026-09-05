# The hosted service: model, architecture, and roadmap

*Planning document, written 2026-09-04. Stages 0–2 shipped 2026-09-05, and
Stage 3's code is deployed pending sign-in credentials; the rest is not built
yet. It exists so the shape is decided before
the code is, and so a contributor can see why the local tool stays the way it
is.*

## The model in one paragraph

OpenDSS Designer stays what it is: an AGPL tool anyone can `pip install` and
run on their own machine with no account, no limits and no network dependency.
Alongside it, one hosted instance at **opendssdesigner.ryanmsparks.com** lets
people use the same tool in a browser without installing anything. That
instance is free with limits, a free account raises the limits, and a paid
plan (about $5/month) raises them further. What the paid plan sells is
**compute**: bigger circuits, longer and finer time-series runs, priority in
the solver queue, and a larger monthly budget of engine time. It does **not**
sell storage: circuits are never kept on the server in any tier, and the
hosted instance and the local tool never talk to each other.

The comparison that keeps coming up is Zotero: a free open-source client plus
a hosted service with a free tier and paid tiers. The differences matter.
Zotero sells storage and keeps its sync server hard to self-host. This project
sells compute, stores nothing, and publishes the whole stack including the
plan enforcement and billing code under the same licence. The only thing the
hosted instance has that a self-hoster does not is a domain name, an uptime
history and a Stripe account.

## Which repository runs on the server

Three repositories, each with one job. The answer to "which one runs on the
server" is: **the unmodified image from this repository, several copies of
it, behind a small gateway from a new repository, deployed by the existing
demo repository.**

| Repository | Licence | Role | What runs where |
| --- | --- | --- | --- |
| `opendss-designer` (this one) | AGPL | The tool. PyPI package, GHCR image, docs. Has **no user concept** and never will. | Local installs run it directly. The server runs it as *worker* containers: one engine each, reached only through the gateway. |
| `opendss-designer-cloud` (new) | AGPL | The gateway: accounts, plans, the solver queue, metering, Stripe. Serves the sign-in and account pages, proxies `/api/*` to workers. | Server only. A self-hoster who wants accounts and quotas runs it too; a self-hoster who does not, skips it. |
| `opendss-designer-demo` (exists) | any | Deployment: compose file, proxy vhosts, env templates, runbooks. No application code. | Describes the server. Grows from one container to gateway plus workers. |

Two rules keep the local tool honest:

1. **Anything the gateway needs from the app must be useful to a self-hoster
   without the gateway.** Per-request limit overrides from a trusted proxy and
   an engine-time header are generic reverse-proxy features. A login page is
   not, so it lives in the cloud repository.
2. **The server runs release images, never a fork.** If the hosted instance
   needs a change in the app, the change ships in a release and every local
   install gets it. The AGPL network clause then costs nothing, because the
   running source *is* the published source.

## Architecture of the hosted instance

```
                     Cloudflare (TLS, WAF, edge rate limit, /assets cache)
                                          |
                            nginx on the Lightsail box
                    /api/* /auth/* /account /billing/*    /  (static SPA)
                                          |                   |
                          opendss-designer-cloud (gateway)    |
                          . session cookie -> user -> plan    |
                          . priority queue, one slot/worker   |
                          . ledger of engine-seconds (SQLite) |
                          . Stripe webhooks                   |
                                 /              \             |
                        worker-1:8721        worker-2:8721  <-+
                   (opendss-designer image,  (same image)
                    demo mode, one engine)
```

**The gateway is the only thing that knows who you are.** Workers receive a
request with a trusted header describing the caller's *limits*, not the
caller. They apply those limits exactly as demo mode applies its env-var
limits today, do the work, and report how many engine-seconds it took. The
gateway debits the ledger.

**Workers are cattle.** Each is one container from this repository's image,
identical to what the compose file runs today. The engine inside is
single-threaded, so one worker does one solve at a time; the gateway holds one
dispatch slot per worker and never sends a second request until the first
returns. Adding capacity means adding a worker line to the compose file.

**There is no session state anywhere but the cookie.** A worker restart loses
at most the run it was doing. A gateway restart loses in-flight runs and
nothing else, because the ledger is written when a run finishes and the plan
comes from the database. Deploys drain: stop admitting, wait up to the longest
run timeout, restart.

**Static files come from a worker, not the gateway.** The SPA is inside the
app image already and Cloudflare caches `/assets/*` by content hash. nginx
routes `/` to a worker and the API paths to the gateway, so the gateway never
learns about the frontend build.

### Why a gateway rather than separate fleets per plan

Every limit in the app today is a process-wide value read from the
environment at import. The obvious way to get plans with zero app changes is
one container fleet per plan. On a 2 GB box shared with a WordPress site that
means three idle engines and no way to lend a free-tier worker to a paying
user when the free fleet is quiet. Threading the limits through the request
instead costs a few hundred lines in the app and lets two workers serve every
plan.

### Why the gateway is Python

The queue, the proxy and the Stripe handling are all small and the maintainer
already writes FastAPI. httpx streams server-sent events without buffering,
Authlib covers GitHub and Google, `itsdangerous` signs magic links and the
session cookie, and the `stripe` package handles Checkout, the Customer Portal
and webhook verification. The database is SQLite: the entire user base of a
$5/month tool fits in a file, and one file is easy to back up. If this ever
outgrows one box, Postgres is a driver swap.

## Plans

Starting values. They are meant to be tuned from the ledger once real usage
exists, so nothing in the code should hard-code them: plans are rows in the
gateway's database and the numbers below are its seed data.

| | Anonymous | Free account | Pro (about $5/month) |
| --- | --- | --- | --- |
| Elements per circuit | 500 | 1,200 | 2,000 |
| Time-series cost per run (steps × entities) | 250 k | 1 M | 3 M |
| Longest single run | 30 s | 90 s | 600 s |
| Engine time budget | 5 min per day, per client | 20 min per month | 5 h per month |
| Concurrent runs | 1, and anonymous traffic as a whole never holds more than one worker | 1 | 2 |
| Queue priority | lowest | normal | highest |
| Outbound data fetches (NREL, NSRDB) | shared pool | 20 per hour | 60 per hour |
| Shapes, points, body size | current demo caps | current demo caps | current demo caps |

For scale: on the current image a cost-1 M run is a 107-element feeder for a
year at hourly steps and takes about 6 s and 69 MiB. Cost 3 M is the app's own
demo default, roughly 20 s and 210 MiB, and is the largest run this box should
allow until the worker memory limit is re-measured. Snapshot solves are about
0.1 s and are debited too, but they only matter to the budget if someone
scripts them.

Capacity: one worker is 3,600 engine-seconds an hour. Two workers on this box
are about five million engine-seconds a month; a hundred Pro subscribers using
their full five hours would use under two million. The constraint is peak
concurrency, not monthly volume, and the queue handles that.

The anonymous "per client" key is the Cloudflare-supplied client IP plus a
first-party cookie. It is deliberately weak; it exists to stop a loop in a
browser tab, not a determined person, and anyone determined is asked to make a
free account, which costs nothing.

## Metering

The unit is the **engine-second**: wall-clock time the worker's engine thread
spends on a call. The engine is single-threaded, so wall time is CPU time.
Queue wait is not charged. A cancelled or timed-out run is charged for the
time it used.

The worker reports it. A JSON response carries an `X-Engine-Seconds` header;
the final server-sent event of a time-series run carries `engineSeconds`.
The gateway records `(who, plan, endpoint, seconds, outcome, timestamp)` in
the ledger and keeps a per-month running total per user. The account page and
the in-app banner show "14 min of 20 used this month", which is also the
upgrade prompt.

Budgets reset on the calendar month for free accounts and on the billing
period for Pro. When a budget is exhausted the gateway refuses with the same
`Issue` shape the app already uses for demo limits, so the message renders in
the Problems list like any other limit.

## What changes in this repository

One release, provisionally **0.4.0, "worker contract"**. Everything is opt-in
and inert in local mode; every item is a generic reverse-proxy feature that
would make sense without this hosted service.

- **Per-request limit overrides from a trusted header.** When
  `OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER` names a header, the values in it
  overlay the process `Settings` for that request only. `limit_issues(circuit,
  cfg)` in `core/validate.py` already takes a settings object, which is the
  template: the time-series cost check, the two timeouts and the fetch limits
  move to the same pattern, and the engine-thread timeout travels in a
  context variable. Workers are never reachable except through the gateway,
  and the flag is off by default, so a local install cannot be talked into
  raising its own limits. The header is not in `Access-Control-Allow-Headers`
  and the gateway strips any incoming copy.
- **Engine-time reporting.** `X-Engine-Seconds` on engine-backed responses
  and `engineSeconds` in the final time-series event. Measured inside
  `on_engine_thread`, so it is exact for what was charged.
- **A plan block in `/api/health`.** Today health returns `limits` and the
  banner renders "Public demo. Circuits are limited to N elements." The
  trusted header may also carry `plan: {name, message, links[]}` and health
  echoes it. The banner renders whatever it is given: name, usage message,
  and links such as "Sign in" or "Upgrade". The SPA learns nothing about
  accounts; it renders strings.
- **Limit messages stop saying "the public demo".** They say the plan name
  from the header, falling back to the current wording. The "run it locally
  with pip" hint stays in every tier, because it is true and it is the point.
- **Request-id passthrough** in the JSON logs, so a gateway log line and a
  worker log line can be joined.

Not changing: the engine, the circuit format, the frontend's stores, anything
a local user can see.

## What lives in `opendss-designer-cloud`

- **Identity**: email magic link, GitHub OAuth, Google OAuth. One user may
  have several identities; the email address is the join key. Magic links are
  signed, single-use, fifteen-minute tokens sent from a dedicated sending
  subdomain so the main domain's mail reputation is untouched.
- **Session**: signed, `HttpOnly`, `SameSite=Lax` cookie, thirty days
  sliding.
- **Plans**: a table, seeded from the numbers above. A user's plan is
  `pro` if they have an active or grace-period Stripe subscription, else
  `free` if signed in, else `anonymous`.
- **Queue**: an asyncio priority queue keyed `(priority, arrival)`, one
  dispatcher per worker, plus two policies: anonymous traffic collectively
  holds at most one worker, and a user never exceeds their plan's
  concurrency. A refused request gets the 503 and `Retry-After` the app uses
  today, so the frontend needs nothing new.
- **Proxy**: `/api/*` to the chosen worker with the limits header added and
  the engine-seconds read back; server-sent events streamed unbuffered.
- **Ledger and usage**: as above, plus `/api/me` for the SPA banner and an
  `/account` page with usage, identities, and billing links.
- **Billing**: one Stripe product, one monthly price; `POST /billing/checkout`
  creates a Checkout session, `GET /billing/portal` opens the Customer Portal
  for cancellation and card changes, `POST /billing/webhook` keeps the
  subscription table current. No card data ever touches the box. With no
  Stripe keys configured, billing routes are disabled and every signed-in user
  is treated as Pro, which is what a self-hoster wants.
- **Legal pages**: privacy policy and terms of service. Both Google's OAuth
  consent screen and Stripe require them. The privacy policy has an unusually
  good story to tell: circuits are processed in memory and never stored,
  logs contain no circuit data, and the only personal data held is an email
  address and a Stripe customer id.
- **Abuse controls**: per-IP limits on the auth endpoints, signup rate
  limits, and a per-user kill switch.

## What changes in `opendss-designer-demo`

- Compose grows from one service to `gateway`, `worker-1`, `worker-2`, with
  the workers on an internal network and only the gateway and one worker's
  static port published to loopback.
- nginx vhost routes API and account paths to the gateway, everything else to
  a worker, and sets the real client IP from Cloudflare's header (trusting
  only Cloudflare's published ranges).
- A `data/` bind mount for the gateway's SQLite file, and a backup job.
- The sizing table is re-measured with two workers, and the memory budget
  rule gains a row for the gateway.

## Roadmap

Effort is in focused working days, not calendar time. Each stage leaves the
site working and is independently shippable. Feature milestones M6 and M7
resume after Stage 5; only bug fixes to the editor ship in between.

### Stage 0 — Ship the demo as it stands *(about 1 day)*

The box is migrated and the container is not yet deployed; that is Phase 9 of
the migration runbook. Two hostname fixes first: the docs move from
`opendssdesigner.ryanmsparks.com` (currently a GitHub Pages CNAME) to
`opendssdesigner-docs.ryanmsparks.com`, which the free Cloudflare certificate
still covers, and the app takes the bare name. That touches `mkdocs.yml`
`site_url`, the GitHub Pages custom domain, the DNS record, the docs link in
`DemoBanner.tsx`, and the PyPI project URLs. Then deploy, add the five-minute
health check, and leave it alone for a while. The traffic and the 503 rate
from this stage are the baseline every later number is tuned against.

*Done when:* the app answers at the bare name, the docs answer at the new
name, and a yearly time-series run on the sample feeder completes from a
phone on mobile data.

### Stage 1 — Worker contract in this repository, 0.4.0 *(3 to 4 days)*

The list under "What changes in this repository". Tests: the header is
ignored unless the env flag is set; the overlay never *loosens* a limit below
the process floor (a worker's own env is the ceiling, the header can only
tighten or equal it, so a bug in the gateway cannot grant more than the box
was sized for); engine-seconds are reported for a solve, a fault study, a
completed run and a cancelled run. Ships to PyPI and GHCR like any release;
local users see a changelog entry and nothing else.

*Done when:* the demo compose file runs the new image with no env changes and
behaves identically.

### Stage 2 — Gateway v0.1, anonymous only *(about 5 days)*

The new repository with the queue, the proxy, the ledger and *no accounts*:
every caller is anonymous. Deployed in place of the single container, with
two workers. This is deliberately a whole stage before anyone can sign in,
because it retires the real weakness of the current demo (one visitor's
four requests 503 everyone) and proves the proxy path, including streamed
events through Cloudflare, before identity adds its own failure modes.

*Done when:* two browsers run yearly time series at once and both finish; a
third gets a queue message rather than an error; the ledger shows the
engine-seconds; and a gateway deploy in the middle of a run loses only that
run.

### Stage 3 — Accounts and the free plan *(6 to 8 days)*

Magic link, GitHub, Google; the account page; per-user budgets and the usage
message in the banner; privacy and terms pages; the transactional email
provider and its DNS records; the two OAuth applications. The anonymous
limits tighten to the table above at the same time, so the sign-in prompt
has a reason to exist.

*Done when:* a new visitor can sign in three ways, sees their usage, and hits
a limit whose message names the plan. Also when the maintainer has read the
privacy policy aloud and not winced.

### Stage 4 — Pro via Stripe *(4 to 5 days)*

Checkout, Portal, webhooks, plan switching, the grace period on a failed
payment, downgrade at period end, and refund and cancellation wording in the
terms. Decide Stripe Tax here: it is the difference between filing sales tax
in many jurisdictions and paying half a percent to not. Test the whole cycle
in Stripe test mode, including a card that fails on renewal.

*Done when:* a real card buys a month, the plan changes within seconds of the
webhook, the Portal cancels it, and the plan reverts on the period end.

### Stage 5 — Run it like a service *(about 3 days, then ongoing)*

Nightly SQLite backup off the box (Litestream to object storage, or a cron
copy to a Lightsail bucket), a restore drill, alerting on the health check
and on queue depth, a plain status page, and a written trigger for moving to
a dedicated box: sustained WordPress contention, more than about twenty
subscribers, or the first support email about slowness. The dedicated-box
move is a compose file and a DNS edit; write the runbook now while it is
cheap.

### Stage 6 — After evidence

Only once the ledger shows people hitting the Pro caps, in roughly this
order: a larger tier; team billing; and **cloud-saved projects**, which are
deferred by decision rather than oversight. Storage means backups of user
content, deletion and export flows, and a different privacy policy, and it is
worth exactly nothing until someone asks for it. Then M6 and M7 resume.

## Risks and how they are handled

- **The box is shared with WordPress.** Paid users on a shared 2 GB box is a
  deliberate choice to reach revenue before spending it. `cpu_shares` already
  favours the site; the queue is the buffer; the dedicated-box trigger in
  Stage 5 is the exit. At $5 a month, five subscribers pay for the second box.
- **Charging money as an individual.** Terms, privacy, refunds, and tax are
  real obligations. Stripe Tax and Stripe's hosted pages remove most of the
  mechanics but none of the responsibility. This is not legal advice and a
  short conversation with an accountant before Stage 4 is cheap.
- **Cloudflare's 100 s origin timeout.** It applies to time-to-first-byte,
  so a streamed time-series run that emits progress is fine at 600 s. A
  snapshot solve is not streamed, so its per-request timeout stays under
  100 s in every plan.
- **Someone hosts a competing copy.** The whole stack is AGPL, so they may.
  The bet is the same as Grafana's or Gitea's: operations, trust and the
  domain are the product, not withheld code.
- **Magic-link email lands in spam.** A dedicated sending subdomain with SPF,
  DKIM and DMARC from day one, and GitHub and Google as the fallback paths.
- **Anonymous keying is weak.** By design; see Plans.

## What the hosted service deliberately does not do

- Store circuits, results, or shapes. Not in any tier.
- Talk to local installs. There is no "run in cloud" button in the pip
  package and no sync. This keeps the local tool's privacy story absolute:
  it makes no network calls except the data fetches the user asks for.
- Put a user concept into this repository.
- Run modified code. The server runs release images.
