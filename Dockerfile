# Build stage — compiles TypeScript, then is discarded.
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage — production dependencies and compiled output only.
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# su-exec drops privileges in the entrypoint after it has fixed the data
# directory's ownership.
RUN apk add --no-cache su-exec

# Create the OAuth client store directory owned by the unprivileged user
# BEFORE any volume is mounted over it. Docker copies this directory's
# ownership when it initialises an empty named volume, so a fresh deployment
# gets a writable volume with no further intervention.
RUN mkdir -p /app/data && chown -R node:node /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Recording playback (PLAYBACK_PORT) and the MCP tool endpoint (MCP_PORT).
EXPOSE 8787 8788

# The entrypoint starts as root only long enough to correct ownership on a
# pre-existing volume, then execs the server as `node`. The server process
# itself never runs as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
