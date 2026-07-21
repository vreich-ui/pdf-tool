# syntax=docker/dockerfile:1
#
# pdf-tool-render: fastify + native typst 0.15.0 binary + Playwright/Chromium.
# NOT built in this session (no docker daemon available) — built by deploy/cloud-run.sh via
# `gcloud builds submit`. TYPST_SHA256 has no default: the build fails loudly rather than
# trusting an unpinned download.
#
# PLAYWRIGHT_VERSION MUST match the "playwright" version pinned in package.json exactly. The
# runtime base image ships a specific pre-downloaded Chromium *revision*; the "playwright" npm
# package (also version-pinned) expects a specific revision too, and if the two disagree,
# Chromium auto-discovery fails at launch (`browserType.launch: Executable doesn't exist at
# ...`). Bump both together when upgrading playwright. Using the matching Playwright image
# means the runtime container needs no CHROMIUM_EXECUTABLE_PATH override — that env var exists
# purely as a local-dev/test escape hatch for environments with a mismatched pre-installed
# browser (see README.md).

ARG PLAYWRIGHT_VERSION=1.61.1

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
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: the runtime image below already ships the matching
# Chromium revision at /ms-playwright — `npm ci` in THIS stage must not also try to download
# a browser (no network policy assumption during `gcloud builds submit`, and it would be
# thrown away anyway since dist/node_modules get copied into a different base image).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# --- runtime image ------------------------------------------------------------------------
# Official Playwright image: Ubuntu Noble + Node.js + the exact Chromium build the pinned
# "playwright" npm version expects, preinstalled at /ms-playwright (PLAYWRIGHT_BROWSERS_PATH
# is already set by this base image — left untouched here). Ships a non-root `pwuser` account.
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime
WORKDIR /app

COPY --from=typst-fetch /usr/local/bin/typst /usr/local/bin/typst
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Bundled OFL fonts (react-pdf's Netlify twin; also inlined as @font-face by the chromium
# engine) + a deliberately empty vendored typst package cache: no @preview package is ever
# pre-installed, so package-download imports fail closed. vendor/ locked read-only so a
# compromised render can't write into it at runtime; everything else stays default
# world-readable (COPY's default perms) so `pwuser` can read it without extra chown.
COPY fonts /srv/fonts
COPY vendor /srv/vendor
RUN chmod -R a-w /srv/vendor \
  && chown -R pwuser:pwuser /app

ENV TYPST_PACKAGE_PATH=/srv/vendor/typst-packages \
    TYPST_PACKAGE_CACHE_PATH=/srv/vendor/typst-packages \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
USER pwuser
CMD ["node", "dist/index.js"]
