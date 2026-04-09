# Auth Service Dockerfile
# TODO: switch to distroless base image for smaller attack surface
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:18-alpine

# Security: run as non-root user
RUN addgroup -g 1001 -S meridian && \
    adduser -S meridian -u 1001

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# HIPAA: don't store PHI in container filesystem
# All PHI should be in the database
VOLUME ["/app/logs"]

USER meridian

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

EXPOSE 3001

# TODO: should we use PM2 or similar for process management?
# Right now if the process crashes, the container restarts (handled by k8s)
CMD ["node", "dist/index.js"]
