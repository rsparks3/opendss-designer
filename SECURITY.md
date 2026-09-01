# Security Policy

## Supported versions

Fixes land on the latest release; please upgrade before reporting.

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/rsparks3/opendss-designer/security/advisories/new).
Please do not open a public issue for a suspected vulnerability.

Useful detail: the version (`/api/health`), whether the instance was a local
install or a hosted deployment, and the smallest request or `.dss` file that
shows the problem.

## Scope

OpenDSS Designer is a local single-user tool by default. Hosted deployments
should run with `--demo` and behind the controls described in
[docs/deployment.md](docs/deployment.md); authentication, TLS and per-IP rate
limiting are deliberately outside this project.
