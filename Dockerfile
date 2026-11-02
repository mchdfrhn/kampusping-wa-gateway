# KampusPing WhatsApp gateway image.
#
#   docker build -t kampusping-wa-gateway .
#
# Secrets are never baked in: WA_GATEWAY_API_KEY, WA_WEBHOOK_SECRET and WA_WEBHOOK_URL come from the
# environment at run time (the gateway refuses to start without them). The image has no .env file.
#
# Persistent state lives in two directories that MUST be mounted as volumes:
#   /app/session   holds the WhatsApp login (WA_AUTH_DIR=/app/session/auth_state). Credentials.
#   /app/data      holds the client_ref dedupe store (WA_DEDUPE_FILE=/app/data/sent-refs.json).
# The session volume is mounted one level above auth_state on purpose: POST /logout renames the
# session folder to `auth_state.old-<ms>` and recreates it, and a mount point itself cannot be renamed.

# Baileys pulls libsignal from GitHub (git+ssh in the lockfile), so installs need git, and the ssh URL
# is rewritten to https because the build has no SSH keys. The git tool never reaches the runtime image.
FROM node:22-alpine AS base
RUN apk add --no-cache git \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global --add url."https://github.com/".insteadOf "git@github.com:"
WORKDIR /app


FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force


FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    GATEWAY_PORT=8095 \
    WA_AUTH_DIR=/app/session/auth_state \
    WA_DEDUPE_FILE=/app/data/sent-refs.json
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# State folders owned by the non-root user. New named volumes inherit this owner and mode.
RUN mkdir -p /app/session /app/data \
    && chown node:node /app/session /app/data \
    && chmod 0700 /app/session /app/data

USER node
EXPOSE 8095

# TCP-level check: every HTTP route needs the bearer token, so the API itself is not probed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "import('node:net').then(({ connect }) => { const s = connect(Number(process.env.GATEWAY_PORT || 8095), '127.0.0.1'); s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 3000); })"

CMD ["node", "dist/index.js"]
