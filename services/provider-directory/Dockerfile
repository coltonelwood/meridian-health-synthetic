FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- production stage ---
FROM node:18-alpine

WORKDIR /app

# hadolint ignore=DL3018
RUN apk add --no-cache curl tini

COPY package*.json ./
RUN npm ci --production && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/

# NOTE: elasticsearch client needs more memory for bulk operations
# We've had OOM kills in prod at the default 512MB heap
ENV NODE_OPTIONS="--max-old-space-size=1024"

ENV NODE_ENV=production
ENV PORT=3006

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3006/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
