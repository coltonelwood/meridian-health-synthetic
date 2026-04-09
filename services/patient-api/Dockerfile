# Multi-stage Docker build for patient-api service
# Based on node:18-alpine for smaller image size
#
# Build: docker build -t meridian/patient-api .
# Run:   docker run -p 3001:3001 --env-file .env meridian/patient-api

# ---- Stage 1: Build ----
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci --ignore-scripts

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --production

# ---- Stage 2: Production ----
FROM node:18-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy migrations (needed for migration runner)
COPY migrations/ ./migrations/

# Don't copy .env - use environment variables from ECS task definition / k8s configmap

# Set ownership
RUN chown -R appuser:appgroup /app

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Expose port
EXPOSE 3001

# Node.js production settings
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512"
# TODO: evaluate if we need --enable-source-maps for production debugging

CMD ["node", "dist/index.js"]
