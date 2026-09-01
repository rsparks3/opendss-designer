# Build the frontend, then ship it inside the Python wheel.
FROM node:24-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# The schema-drift fixture is shared with pytest and imported by a
# vitest file, so `tsc -b` needs it on the same relative path.
COPY tests/fixtures/ /app/tests/fixtures/
RUN npm run build

FROM python:3.12-slim AS build
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ ./src/
COPY --from=frontend /app/frontend/dist/ ./src/opendss_designer/static/
RUN pip install --no-cache-dir build && python -m build --wheel --outdir /dist

FROM python:3.12-slim
# opendssdirect.py ships manylinux wheels, so no build toolchain is needed here.
RUN useradd --create-home --uid 10001 app
COPY --from=build /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl

ENV OPENDSS_DESIGNER_MODE=demo \
    OPENDSS_DESIGNER_HOST=0.0.0.0 \
    OPENDSS_DESIGNER_CACHE_DIR=/cache \
    PYTHONUNBUFFERED=1 \
    PORT=8721

# Read by the native library at load time, before any Python runs -- belt and
# braces for the flags engine._ensure_init already sets.
ENV DSS_CAPI_ALLOW_DOSCMD=0 \
    DSS_CAPI_ALLOW_CHANGE_DIR=0

# Created and owned *before* VOLUME: changes to a path after it is declared a
# volume are discarded, so a later chown would silently not apply.
RUN mkdir -p /cache && chown app:app /cache
# Public, static downloads keyed only by what was requested; mount one shared
# volume across sessions so each new container does not refetch 10-30 MB files.
VOLUME ["/cache"]

USER app
EXPOSE 8721
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8721/api/health', timeout=4).status==200 else 1)"

# Run with --init (or tini) so SIGTERM reaches PID 1 and the graceful
# shutdown actually runs.
CMD ["opendss-designer"]
