# =============================================================================
# Meridian Health - Base Node.js Docker Image
# =============================================================================
#
# Base image for all Node.js microservices. Includes:
# - Node.js 20 LTS (Alpine for small image size)
# - Security patches applied
# - Non-root user (required for HIPAA/container security)
# - Health check script
# - Common native dependencies (node-gyp, etc.)
#
# Build: docker build -t meridian/base-node:latest -f base-node.Dockerfile .
# Size: ~180MB (Alpine base + Node.js + native deps)
#
# Update cadence: Rebuilt weekly by CI for security patches.
# Last security audit: 2026-03-15 (no critical findings)

FROM node:20.11-alpine3.19 AS base

# Install security updates and common native dependencies
RUN apk update && \
    apk upgrade --no-cache && \
    apk add --no-cache \
      # Native module compilation
      python3 \
      make \
      g++ \
      # Health check
      curl \
      # TLS certificates (for HIPAA-compliant connections)
      ca-certificates \
      # Timezone data (important for healthcare date handling)
      tzdata \
      # Process management
      tini \
    && rm -rf /var/cache/apk/*

# Set timezone to UTC (all timestamps should be UTC, converted in app layer)
ENV TZ=UTC

# Create non-root user for running the application
# HIPAA: Services should never run as root
RUN addgroup -g 1001 -S meridian && \
    adduser -u 1001 -S meridian -G meridian -h /app -s /bin/sh

# Create app directory structure
RUN mkdir -p /app/node_modules /app/dist /app/logs && \
    chown -R meridian:meridian /app

WORKDIR /app

# Copy package files for dependency caching
# (Individual services will copy their own package.json)
COPY --chown=meridian:meridian package*.json ./

# Install production dependencies only
RUN npm ci --production --ignore-scripts && \
    # Clean npm cache to reduce image size
    npm cache clean --force && \
    # Remove unnecessary files from node_modules
    find /app/node_modules -name "*.md" -delete 2>/dev/null || true && \
    find /app/node_modules -name "*.txt" -delete 2>/dev/null || true && \
    find /app/node_modules -name "CHANGELOG*" -delete 2>/dev/null || true && \
    find /app/node_modules -name "LICENSE*" -delete 2>/dev/null || true

# Copy the health check script
COPY --chown=meridian:meridian docker/healthcheck.sh /app/healthcheck.sh
RUN chmod +x /app/healthcheck.sh

# Switch to non-root user
USER meridian

# Default environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info \
    # Disable Node.js color output in production
    NO_COLOR=1 \
    # Memory limits (can be overridden per service)
    NODE_OPTIONS="--max-old-space-size=768"

# Expose default port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /app/healthcheck.sh

# Use tini as init system (handles signals properly)
ENTRYPOINT ["/sbin/tini", "--"]

# Default command (overridden by individual services)
CMD ["node", "dist/index.js"]
