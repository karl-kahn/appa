# Multi-stage build for an Appa consumer project.
# Stage 1 builds the appa kernel; stage 2 ships a slim runtime with
# the Claude CLI + Node 20 + a non-root user.
#
# Usage from a consumer project (`my-classroom/`):
#   docker build -t my-classroom -f Dockerfile .
#   docker run -p 3848:3848 -v $(pwd)/data:/project -e ANTHROPIC_API_KEY=… my-classroom
#
# `data/` should contain team.json, tutor-prompt.md, shared-memory.md,
# appa.config.js (the consumer-side files). Transcripts, threads,
# audit log etc. accumulate in this volume.

# ---------- Stage 1: build appa from source ----------
FROM node:20-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json biome.json knip.json .fallowrc.json ./
COPY scripts ./scripts
COPY src ./src
COPY templates ./templates
COPY public ./public
RUN npm run build && npm prune --production

# ---------- Stage 2: runtime ----------
FROM node:20-bookworm-slim AS runtime

# Install the Claude CLI. The official installer puts it at
# /usr/local/bin/claude. Pin the install version once stable releases
# carry a version channel; for now we pull the latest at build time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL https://claude.ai/install.sh | bash \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Non-root user; APPA_PROJECT_DIR is bind-mounted from the host.
RUN groupadd -r appa && useradd -r -g appa -d /home/appa -m appa
USER appa
WORKDIR /home/appa/appa

COPY --from=build --chown=appa:appa /build/dist ./dist
COPY --from=build --chown=appa:appa /build/templates ./templates
COPY --from=build --chown=appa:appa /build/public ./public
COPY --from=build --chown=appa:appa /build/node_modules ./node_modules
COPY --from=build --chown=appa:appa /build/package.json ./package.json

ENV APPA_PROJECT_DIR=/project
ENV HOST=0.0.0.0
ENV PORT=3848

EXPOSE 3848

# The /project volume holds the consumer's data files. ANTHROPIC_API_KEY
# must be supplied at runtime — never bake it into the image.
VOLUME ["/project"]

CMD ["node", "dist/cli.js"]
