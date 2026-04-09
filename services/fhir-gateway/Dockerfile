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

ENV NODE_ENV=production
ENV PORT=3011

EXPOSE 3011

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3011/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
