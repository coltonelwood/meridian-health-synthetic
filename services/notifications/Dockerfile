# Notifications Service Dockerfile
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Copy templates to dist
# TODO: templates should be compiled at build time, not loaded at runtime
RUN cp -r src/templates dist/templates

FROM node:18-alpine

RUN addgroup -g 1001 -S meridian && \
    adduser -S meridian -u 1001

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

USER meridian

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3003/health || exit 1

EXPOSE 3003

CMD ["node", "dist/index.js"]
