# =============================================================================
# Meridian Health - Base Python Docker Image
# =============================================================================
#
# Base image for Python/ML services. Used by:
# - risk-model-service (readmission risk prediction)
# - nlp-service (clinical note extraction)
# - analytics-engine (reporting/dashboards)
#
# CUDA support is commented out because we moved ML inference to
# SageMaker endpoints in Q1 2026. Keeping the CUDA setup here in case
# we need to run models locally again for development or batch processing.
#
# Build: docker build -t meridian/base-python:latest -f base-python.Dockerfile .
# Size: ~450MB without CUDA, ~2.8GB with CUDA

# --- CUDA variant (commented out) ---
# FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04 AS base-cuda
# ENV CUDA_VISIBLE_DEVICES=0

FROM python:3.11-slim-bookworm AS base

# Install system dependencies and security updates
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
      # Build tools for native Python packages
      build-essential \
      # Health check
      curl \
      # For postgres driver
      libpq-dev \
      # TLS
      ca-certificates \
      # Timezone
      tzdata \
      # Process management
      tini \
    && apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set timezone
ENV TZ=UTC
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Create non-root user
RUN groupadd -g 1001 meridian && \
    useradd -u 1001 -g meridian -m -d /app -s /bin/bash meridian

# Set up virtual environment
RUN python -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"
ENV VIRTUAL_ENV="/app/venv"

# Upgrade pip and install common packages
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install common ML/data science dependencies
# These are shared across all Python services
COPY requirements-base.txt /tmp/requirements-base.txt
RUN pip install --no-cache-dir -r /tmp/requirements-base.txt && \
    rm /tmp/requirements-base.txt

# Create app directory
RUN mkdir -p /app/src /app/models /app/data /app/logs && \
    chown -R meridian:meridian /app

WORKDIR /app

# Switch to non-root user
USER meridian

# Environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    LOG_LEVEL=info \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["tini", "--"]

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
