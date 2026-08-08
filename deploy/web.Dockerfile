# Web image — Next.js. Builds with `next build`, runs with `next start`.
#
# Build context = repo ROOT (npm workspaces need packages/*):
#   docker build -f deploy/web.Dockerfile --build-arg API_ORIGIN=http://cre-api.internal:3001 -t cre-web .
#
# API_ORIGIN is read by next.config.js at build/start to point the /api proxy at the
# private Fly api. Defaults to localhost:3001 (dev) when unset.

FROM node:22-bookworm-slim

# next build + tsx tooling live in devDependencies → install WITH devDeps (like the api).
ENV HUSKY=0
# The internal api URL for the /api rewrite (next.config.js reads process.env.API_ORIGIN).
ARG API_ORIGIN=http://localhost:3001
ENV API_ORIGIN=${API_ORIGIN}

WORKDIR /app

# Manifests first (cached npm ci layer). Every workspace package.json must be present.
COPY package.json package-lock.json ./
COPY apps/api/package.json            apps/api/
COPY apps/web/package.json            apps/web/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/shared/package.json     packages/shared/
COPY packages/handbook-data/package.json    packages/handbook-data/
COPY packages/handbook-engine/package.json  packages/handbook-engine/

# Drop the root husky prepare (no .git in the image), install all workspaces with devDeps.
RUN npm pkg delete scripts.prepare && npm ci --include=dev

# Source, then build the web app.
COPY . .
WORKDIR /app/apps/web
RUN npm run build

EXPOSE 3000

# next start honors PORT (Fly sets internal_port 3000). Basic-Auth gate + the JWT login
# both apply at runtime via env / Fly secrets.
CMD ["npm", "run", "start"]
