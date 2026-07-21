# syntax=docker/dockerfile:1
#
# pdf-tool-render: fastify + native typst 0.15.0 binary (chromium/playwright lands PR4).
# NOT built in this session (no docker daemon available) — built by deploy/cloud-run.sh via
# `gcloud builds submit`. TYPST_SHA256 has no default: the build fails loudly rather than
# trusting an unpinned download.

FROM node:22-slim AS base

# --- fetch + verify the pinned typst release tarball -----------------------------------
FROM base AS typst-fetch
ARG TYPST_VERSION=0.15.0
ARG TYPST_SHA256
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates xz-utils curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/typst
RUN if [ -z "$TYPST_SHA256" ]; then \
      echo "ERROR: TYPST_SHA256 build-arg is required. See render-service/typst.sha256 / deploy/cloud-run.sh." >&2; \
      exit 1; \
    fi
RUN curl -fsSL -o typst.tar.xz \
      "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
  && echo "${TYPST_SHA256}  typst.tar.xz" | sha256sum -c - \
  && tar -xf typst.tar.xz \
  && mv "typst-x86_64-unknown-linux-musl/typst" /usr/local/bin/typst \
  && chmod +x /usr/local/bin/typst

# --- build the TypeScript service -------------------------------------------------------
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# --- runtime image ------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /app

COPY --from=typst-fetch /usr/local/bin/typst /usr/local/bin/typst
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Bundled OFL fonts (react-pdf's Netlify twin) + a deliberately empty vendored typst
# package cache: no @preview package is ever pre-installed, so package-download imports
# fail closed. Locked read-only so a compromised render can't write into it at runtime.
COPY fonts /srv/fonts
COPY vendor /srv/vendor
RUN chmod -R a-w /srv/vendor

ENV TYPST_PACKAGE_PATH=/srv/vendor/typst-packages \
    TYPST_PACKAGE_CACHE_PATH=/srv/vendor/typst-packages \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
