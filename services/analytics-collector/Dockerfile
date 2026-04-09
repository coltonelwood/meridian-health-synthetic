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

RUN apk add --no-cache curl tini

COPY package*.json ./
RUN npm ci --production && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Analytics collector is memory-sensitive because of the event buffer
# Increase heap size to handle burst traffic
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV=production
ENV PORT=3010

EXPOSE 3010

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3010/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
