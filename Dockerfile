# MCP registries (Glama among them) enumerate a stdio server's tools by BUILDING
# and RUNNING it from the public mirror repo — and the mirror carries src/ but
# never dist/, because dist/ is build output shipped only in the npm tarball via
# package.json "files". So the mirror has no runnable entry point without this
# image: bin/featureflip-mcp.mjs imports ../dist/cli.mjs, a fresh clone does not
# have it, and no install step builds it (there is deliberately no "prepare"
# script — see packages/CLAUDE.md for why).
#
# The build context is THIS directory, which is also the mirror's repo root.
# Nothing here may reference a path outside packages/mcp-server/.

FROM node:22-alpine AS build
WORKDIR /app

# No package-lock.json to copy: the lock governing this package lives at the
# MONOREPO root and is not mirrored, so `npm ci` cannot run here at all. The
# dependency set is small and ranged in package.json, and mcp-server-ci.yml
# builds this image on every PR, so a resolution that breaks the build is caught
# there rather than on a registry's inspection run.
COPY package.json tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm install --no-audit --no-fund
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Runtime deps only. @modelcontextprotocol/server and zod are marked external in
# vite.config.ts, so they are resolved at runtime rather than bundled.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY bin ./bin

USER node

# stdio transport: JSON-RPC over stdin/stdout, so no port is exposed and nothing
# may be written to stdout except protocol frames. Runs with no credentials —
# tools/list must answer before FEATUREFLIP_TOKEN is ever set.
ENTRYPOINT ["node", "bin/featureflip-mcp.mjs"]
