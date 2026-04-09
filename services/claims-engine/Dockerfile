FROM node:18-alpine AS builder

WORKDIR /app

# NOTE(ops): we had an incident where npm ci was pulling different versions
# on build servers vs local. Pinning with package-lock should fix this but
# leaving this note just in case. - Marcus 2024-08-12
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

# TODO: we should not be running as root but changing this broke
# file permissions on the EDI staging directory in ECS.
# Ticket: INFRA-2891
# USER node

ENV NODE_ENV=production
ENV PORT=3004

EXPOSE 3004

# Health check hits the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3004/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
