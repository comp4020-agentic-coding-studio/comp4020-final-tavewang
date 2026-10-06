# syntax = docker/dockerfile:1

# Fridge Rescue runs on plain Node 24: node:sqlite is built in (no native
# addon to compile) and Node runs .ts files directly (type-stripping), so
# there's nothing to build — one stage, no toolchain. See PROCESS.md for why.
FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY README.md ./README.md

ENV NODE_ENV=production
# Fly's volume (fly.toml [mounts]) is mounted here; this is the only place
# the app writes state that needs to survive a restart or redeploy.
ENV DATA_DIR=/data

EXPOSE 8080
CMD ["node", "src/server.ts"]
