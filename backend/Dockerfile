# Backend image: Node 22 (better-sqlite3 ships prebuilt binaries for it).
# Build context is the REPO ROOT (see docker-compose.yml) so we can copy both
# the backend and the static frontend into one "app" service.
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY backend/package*.json ./
RUN npm ci --omit=dev

# App source + the static frontend.
COPY backend/ ./
COPY frontend/ /frontend

ENV NODE_ENV=production
ENV FRONTEND_DIR=/frontend
EXPOSE 3000

CMD ["node", "src/server.js"]
