# API image — runs the Node/Express api via tsx (NOT `node dist`).
#
# Why tsx: apps/api/tsconfig.json uses moduleResolution:"bundler" and the workspace
# packages (@cre/contracts, @cre/shared, …) are consumed as TS SOURCE (main: ./src/index.ts,
# no JS build). So `tsc` + `node dist/index.js` cannot resolve them at runtime. Running the
# TS entrypoint through tsx (the same engine dev uses) is the lowest-friction prod path.
#
# Build context = repo ROOT (npm workspaces need packages/*):
#   docker build -f deploy/api.Dockerfile -t cre-api .
# Run with a data volume (SQLite lives at process.cwd()/data/cre.db; cwd = /app/apps/api):
#   docker run -p 3001:3001 -v "$PWD/deploy/dryrun-data:/app/apps/api/data" cre-api

FROM node:22-bookworm-slim

# Toolchain for better-sqlite3's native build (node-gyp fallback when no prebuilt binary).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ⚠️ Do NOT set NODE_ENV=production for the install: `tsx` (the runtime engine) is a
# devDependency, so `npm ci --omit=dev` would leave the container with no way to run.
# (Finding: moving tsx to `dependencies` would let a prod image drop devDeps + be leaner.)
ENV HUSKY=0

WORKDIR /app

# Copy only manifests first so `npm ci` is cached across source changes. Every workspace
# package.json must be present for the workspace install to resolve.
COPY package.json package-lock.json ./
COPY apps/api/package.json            apps/api/
COPY apps/web/package.json            apps/web/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/shared/package.json     packages/shared/
COPY packages/handbook-data/package.json    packages/handbook-data/
COPY packages/handbook-engine/package.json  packages/handbook-engine/

# Drop the root `prepare: husky` script (no .git / no dev tooling in the image) so it
# doesn't abort the install, then install ALL workspaces WITH devDeps (tsx). This
# compiles/fetches the better-sqlite3 native binary for the linux image.
RUN npm pkg delete scripts.prepare && npm ci --include=dev

# Now the source (packages/* are consumed as TS source at runtime).
COPY . .

# The api reads DB_PATH = process.cwd()/data/cre.db, so cwd must be apps/api.
WORKDIR /app/apps/api

EXPOSE 3001

# Liveness — the api exposes GET /health.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run the TS entrypoint via tsx (no watch).
CMD ["npx", "tsx", "src/index.ts"]
