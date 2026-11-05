# syntax=docker/dockerfile:1
# Proc-Robot worker: Node 22 + LibreOffice headless (DOCX/XLSX → PDF for
# rendered RFQs and quotations, TASKS.md T1.9.9). Build context: the repo
# root (Railway builds it from railway.json).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
# LibreOffice without the GUI; Liberation fonts are metric-compatible with
# Arial, the fallback of the default templates (design/THEME.md §7). tini is
# PID 1: it forwards SIGTERM and reaps LibreOffice child processes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui libreoffice-calc-nogui \
    fonts-liberation fonts-dejavu-core fontconfig tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Unprivileged; LibreOffice keeps its profile in /home/node.
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
