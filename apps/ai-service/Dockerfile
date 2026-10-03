# syntax=docker/dockerfile:1.7
# Forge AI service (FastAPI). Internal only: reached by the API and the worker, never the browser.
# Build from the repository root: docker build -f apps/ai-service/Dockerfile .

FROM python:3.12-slim-bookworm AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
# `build_ca` (optional build secret): an extra CA for networks with a TLS-intercepting proxy.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir uv==0.8.17
COPY apps/ai-service/pyproject.toml apps/ai-service/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --locked --no-dev --no-install-project

FROM python:3.12-slim-bookworm AS runtime
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN useradd --system --uid 10001 --no-create-home forge
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY apps/ai-service/app ./app
USER forge
EXPOSE 8000
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=2).status == 200 else 1)"]
