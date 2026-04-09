FROM node:18-alpine AS builder

WORKDIR /app

# Sharp requires build tools for native modules
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++ vips-dev

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- production stage ---
FROM node:18-alpine

WORKDIR /app

# Sharp needs vips at runtime, and we need curl for health checks
# hadolint ignore=DL3018
RUN apk add --no-cache curl tini vips

COPY package*.json ./
RUN npm ci --production && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/

# Create upload temp directory
RUN mkdir -p /tmp/meridian-uploads && chmod 777 /tmp/meridian-uploads

# Create local storage directory (fallback)
RUN mkdir -p /var/meridian/documents

# Running as root because the temp dir and storage dir need write access
# TODO: fix permissions and run as non-root user (INFRA-3456)
# USER node

ENV NODE_ENV=production
ENV PORT=3012
ENV UPLOAD_TEMP_DIR=/tmp/meridian-uploads
ENV LOCAL_STORAGE_PATH=/var/meridian/documents

EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3012/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
