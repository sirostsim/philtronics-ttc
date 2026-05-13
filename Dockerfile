# ─────────────────────────────────────────────────────────────
# Philtronics Time-to-Complete – Dockerfile
# Multi-stage: build deps, then minimal production image
# ─────────────────────────────────────────────────────────────

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy application
COPY server/ ./server/
COPY public/ ./public/

# Create data directory for SQLite
RUN mkdir -p /data && chown -R node:node /data /app

# ─────────────────────────────────────────────────────────────
FROM base AS production

USER node
WORKDIR /app/server

# Seed on first start, then run server
# (seed.js is idempotent – safe to call every time)
CMD ["sh", "-c", "node seed.js && node server.js"]

EXPOSE 3000
