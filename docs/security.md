# Security

## The two settings

**Local (the default).** The server binds `127.0.0.1`, and whoever is using the
app already has an account on that machine. Reading local files is a *feature*
here: that is what importing a `.dss` feeder is. There are no size limits,
because your own hardware is the limit.

**Hosted.** Requests come from strangers. Demo mode adds size, cost and rate
limits, and a hosted instance should sit behind the auth, TLS and orchestration
described in [Deploying](deployment.md).

## Reporting a vulnerability

Please report privately through
[GitHub security advisories](https://github.com/rsparks3/opendss-designer/security/advisories/new)
rather than opening a public issue.

## Enforced in both modes

- **Static files cannot escape the app's own directory.** Request paths are
  resolved and checked for containment, so neither a `..` segment nor an
  absolute path reaches the filesystem.
- **The `Host` header is validated.** Without this, a page you happen to visit
  could reach a `127.0.0.1` server through DNS rebinding. Loopback names are
  allowed by default; a deployment adds its own.
- **Imported `.dss` files are treated as data, not as a program.** Every
  uploaded file is checked, not only the one defining the circuit. File
  references are rewritten to their base name, so no path can leave the
  import's temporary directory. Commands that write files or spawn processes
  (`save`, `export`, `show`, `docmd`, and friends) are skipped with a warning,
  and the OpenDSS capabilities that could run an editor, run a shell command,
  or change the working directory are switched off.
- **Element property values are allowlisted** before they reach OpenDSS command
  text, so a crafted circuit cannot append properties to its own elements.
- **Responses carry no server detail:** no filesystem paths, no generated
  command list, and an unexpected failure returns a generic message with the
  detail logged server-side.

## Added by demo mode

Caps on circuit and request size, engine queue depth, and time-series cost and
duration; bounded caches; rate-limited outbound fetchers; and no interactive
API docs.

## What none of it protects against

- **A large `params` blob on a single element.** Element parameters are an open
  dictionary by design, so element *counts* do not bound their size. The
  request body limit is the defense there.
- **A visitor monopolizing their own session's solver.** There is no safe way
  to interrupt the OpenDSS engine mid-solve without corrupting it; a request
  timeout frees the HTTP worker, not the engine. Bound it with a container CPU
  or wall-clock limit.
- **Anything about who the visitor is.** There is no authentication here.

## The NSRDB API key

The irradiance fetcher asks for *your* NLR Developer Network key and forwards
it to NSRDB with the request. It is never stored server-side and never logged,
but on a hosted instance it does transit that server. If you would rather not
hand a key to a site you do not run, use that feature locally.
