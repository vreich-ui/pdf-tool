#!/usr/bin/env bash
# Deploys render-service/ to Cloud Run (europe-west1 by default). Runnable by a Cowork
# session with GCP creds in its env, or by a human with the same env vars set locally.
#
# Required env:
#   GCP_PROJECT_ID          - target GCP project
#   GCP_SERVICE_ACCOUNT_KEY - path to a service-account JSON key file, OR the inline JSON
#                              key content itself
# Optional env:
#   GCP_REGION               - default europe-west1
#   RENDER_SERVICE_SECRET    - if unset, a random 32-byte hex secret is generated
#   TYPST_VERSION             - default 0.15.0 (must match render-service/typst.sha256)
#   NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID - if both present, this script wires
#                              RENDER_SERVICE_URL / RENDER_SERVICE_SECRET into Netlify env
#                              automatically via `netlify env:set`.
#
# Never echoes RENDER_SERVICE_SECRET. The generated/used secret is written to
# render-service/.local/render-service-secret (gitignored, chmod 600) for local reference.

set -euo pipefail

# --- locate render-service/ regardless of invocation cwd ---------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER_SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RENDER_SERVICE_DIR}/.." && pwd)"

echo "== render-service Cloud Run deploy =="
echo "render-service dir: ${RENDER_SERVICE_DIR}"

# --- required env --------------------------------------------------------------------------
if [[ -z "${GCP_PROJECT_ID:-}" ]]; then
  echo "ERROR: GCP_PROJECT_ID is required." >&2
  exit 1
fi
if [[ -z "${GCP_SERVICE_ACCOUNT_KEY:-}" ]]; then
  echo "ERROR: GCP_SERVICE_ACCOUNT_KEY is required (file path or inline JSON key)." >&2
  exit 1
fi

REGION="${GCP_REGION:-europe-west1}"
TYPST_VERSION="${TYPST_VERSION:-0.15.0}"
AR_REPO="pdf-tool"
IMAGE_NAME="pdf-tool-render"
SERVICE_NAME="pdf-tool-render"

# --- service account key: accept a file path OR inline JSON ------------------------------
KEY_FILE=""
CLEANUP_KEY_FILE=0
if [[ -f "${GCP_SERVICE_ACCOUNT_KEY}" ]]; then
  KEY_FILE="${GCP_SERVICE_ACCOUNT_KEY}"
else
  KEY_FILE="$(mktemp)"
  CLEANUP_KEY_FILE=1
  printf '%s' "${GCP_SERVICE_ACCOUNT_KEY}" > "${KEY_FILE}"
  chmod 600 "${KEY_FILE}"
fi

cleanup() {
  if [[ "${CLEANUP_KEY_FILE}" -eq 1 && -f "${KEY_FILE}" ]]; then
    rm -f "${KEY_FILE}"
  fi
}
trap cleanup EXIT

echo "== Authenticating gcloud =="
gcloud auth activate-service-account --key-file="${KEY_FILE}"
gcloud config set project "${GCP_PROJECT_ID}" >/dev/null

# --- Artifact Registry repo ---------------------------------------------------------------
echo "== Ensuring Artifact Registry repo '${AR_REPO}' exists in ${REGION} =="
if ! gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="pdf-tool render service images"
else
  echo "Artifact Registry repo already exists."
fi

# --- typst.sha256: fill in on first trusted deploy ----------------------------------------
SHA_FILE="${RENDER_SERVICE_DIR}/typst.sha256"
CURRENT_SHA_LINE="$(head -n1 "${SHA_FILE}" 2>/dev/null || true)"
if [[ -z "${CURRENT_SHA_LINE}" || "${CURRENT_SHA_LINE}" == "TBD" ]]; then
  echo "== typst.sha256 is unset (TBD) — trying to download typst v${TYPST_VERSION} to compute + pin it =="
  TARBALL_URL="https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz"
  TMP_TARBALL="$(mktemp)"
  if curl -fsSL -o "${TMP_TARBALL}" "${TARBALL_URL}"; then
    COMPUTED_SHA="$(sha256sum "${TMP_TARBALL}" | awk '{print $1}')"
    rm -f "${TMP_TARBALL}"
    {
      echo "${COMPUTED_SHA}"
      echo "# sha256 of typst-x86_64-unknown-linux-musl.tar.xz for typst v${TYPST_VERSION}, pinned by deploy/cloud-run.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    } > "${SHA_FILE}"
    echo "##############################################################################"
    echo "# typst.sha256 was just filled in with a freshly computed digest."
    echo "# >>> COMMIT render-service/typst.sha256 to source control now. <<<"
    echo "##############################################################################"
    TYPST_SHA256="${COMPUTED_SHA}"
  else
    rm -f "${TMP_TARBALL}"
    echo "Download blocked/unavailable from this machine — Cloud Build's resolve-typst-sha step"
    echo "will compute the digest inside Google's network (trust-on-first-use) and log it as"
    echo "TYPST_TARBALL_SHA256=<sha>; this script pins it into typst.sha256 afterwards."
    TYPST_SHA256="TBD"
  fi
else
  TYPST_SHA256="${CURRENT_SHA_LINE}"
  echo "== Using pinned typst sha256 from typst.sha256: ${TYPST_SHA256} =="
fi

# --- build via Cloud Build (gcloud builds submit doesn't take --build-arg directly) -------
GIT_SHA="$(cd "${REPO_ROOT}" && git rev-parse --short HEAD)"
IMAGE_TAG="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}:${GIT_SHA}"

echo "== Building + pushing ${IMAGE_TAG} via Cloud Build =="
BUILD_LOG="$(mktemp)"
# --gcs-log-dir: the DEFAULT logs bucket is outside the project and only streams for
# project Viewers/Owners; a deploy service account with Storage Admin can stream from the
# project's own staging bucket instead.
gcloud builds submit "${RENDER_SERVICE_DIR}" \
  --config="${RENDER_SERVICE_DIR}/deploy/cloudbuild.yaml" \
  --gcs-log-dir="gs://${GCP_PROJECT_ID}_cloudbuild/logs" \
  --substitutions="_TYPST_VERSION=${TYPST_VERSION},_TYPST_SHA256=${TYPST_SHA256},_IMAGE_TAG=${IMAGE_TAG}" \
  2>&1 | tee "${BUILD_LOG}"

# When the pin was TBD, Cloud Build's resolve-typst-sha step computed the digest — pin it now.
if [[ "${TYPST_SHA256}" == "TBD" ]]; then
  COMPUTED_SHA="$(grep -oE 'TYPST_TARBALL_SHA256=[0-9a-f]{64}' "${BUILD_LOG}" | head -n1 | cut -d= -f2 || true)"
  if [[ -n "${COMPUTED_SHA}" ]]; then
    {
      echo "${COMPUTED_SHA}"
      echo "# sha256 of typst-x86_64-unknown-linux-musl.tar.xz for typst v${TYPST_VERSION}, computed inside Cloud Build on $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    } > "${SHA_FILE}"
    echo "##############################################################################"
    echo "# typst.sha256 pinned from the Cloud Build log: ${COMPUTED_SHA}"
    echo "# >>> COMMIT render-service/typst.sha256 to source control now. <<<"
    echo "##############################################################################"
  else
    echo "WARNING: could not extract TYPST_TARBALL_SHA256 from the build log (streaming may be" >&2
    echo "CLOUD_LOGGING_ONLY); fetch it with: gcloud builds log <build-id> | grep TYPST_TARBALL_SHA256" >&2
  fi
fi
rm -f "${BUILD_LOG}"

# --- secret ---------------------------------------------------------------------------------
# A random secret is correct for the FIRST deploy and catastrophic for every one after it: the
# caller of this service is pdf-tool's Netlify site, which holds RENDER_SERVICE_SECRET in its own
# env. Minting a fresh one on every redeploy silently 401s every capture job unless
# NETLIFY_AUTH_TOKEN/NETLIFY_SITE_ID happen to be set in the same shell. So: an explicit
# RENDER_SERVICE_SECRET always wins; otherwise REUSE the running service's own value; only mint a
# random one when there is no service yet to reuse from.
if [[ -n "${RENDER_SERVICE_SECRET:-}" ]]; then
  SECRET="${RENDER_SERVICE_SECRET}"
  SECRET_SOURCE="supplied"
else
  EXISTING_SECRET="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" \
    --format='value(spec.template.spec.containers[0].env.filter("name", "RENDER_SERVICE_SECRET").extract("value").flatten())' 2>/dev/null || true)"
  if [[ -n "${EXISTING_SECRET}" ]]; then
    SECRET="${EXISTING_SECRET}"
    SECRET_SOURCE="reused from the running service"
  else
    SECRET="$(openssl rand -hex 32)"
    SECRET_SOURCE="newly minted (no existing service)"
  fi
fi
echo "== RENDER_SERVICE_SECRET: ${SECRET_SOURCE} =="

# --- deploy to Cloud Run ---------------------------------------------------------------------
# T12.8: the capture endpoint (/capture/page — JS enabled, multi-viewport screenshots) needs
# more than the print path's old 300s/1Gi/1CPU. Numbers + cost estimate: docs/CAPTURE_OPS.md.
echo "== Deploying ${SERVICE_NAME} to Cloud Run (${REGION}) =="
# --update-env-vars, never --set-env-vars: the merge form changes only the keys named and leaves
# every other variable on the service untouched. The replace form has taken a sibling deployment
# down twice by deleting variables the command did not happen to list (see CMS-Agent's
# scripts/deploy-mcp.sh, which exists for that reason). To REMOVE a key, use
# `gcloud run services update --remove-env-vars KEY`.
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE_TAG}" \
  --region="${REGION}" \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --timeout=600 \
  --max-instances=3 \
  --concurrency=2 \
  --update-env-vars="RENDER_SERVICE_SECRET=${SECRET},SERVICE_GIT_SHA=${GIT_SHA},SERVICE_DEPLOYED_AT=${DEPLOYED_AT}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --format='value(status.url)')"
echo "Service URL: ${SERVICE_URL}"
echo "Deployed commit: ${GIT_SHA}"

# --- smoke test -------------------------------------------------------------------------------
# /health, not /healthz: Google's frontend intercepts the exact path /healthz on *.run.app
# and answers 404 before the container is reached.
echo "== Smoke test: GET /health =="
HEALTH_RESPONSE="$(curl -fsS "${SERVICE_URL}/health")"
echo "${HEALTH_RESPONSE}"
if ! grep -q '"ok":true' <<<"${HEALTH_RESPONSE}"; then
  echo "ERROR: /health did not report ok:true" >&2
  exit 1
fi
if ! grep -q '"typst":{"available":true' <<<"${HEALTH_RESPONSE}"; then
  echo "ERROR: /health reports typst engine unavailable" >&2
  exit 1
fi
if ! grep -q '"chromium":{"available":true' <<<"${HEALTH_RESPONSE}"; then
  echo "ERROR: /health reports chromium engine unavailable" >&2
  exit 1
fi

# THE CHECK THIS SCRIPT WAS MISSING. On 2026-08-19 a redeploy reported success while the running
# revision still served pre-fix code, and nothing here noticed — "deployed" and "what is actually
# serving traffic" are different facts (the same distinction the env-var comment above is about).
# The service now echoes the commit it was built from, so a deploy that did not take fails here.
if ! grep -q "\"gitSha\":\"${GIT_SHA}\"" <<<"${HEALTH_RESPONSE}"; then
  echo "ERROR: /health does not report the commit just deployed (${GIT_SHA})." >&2
  echo "       Traffic is still on an older revision, or the build did not include HEAD." >&2
  echo "       Reported: $(grep -o '"build":{[^}]*}' <<<"${HEALTH_RESPONSE}" || echo '<no build block — the running image predates build stamping>')" >&2
  exit 1
fi
echo "Verified: /health reports the deployed commit ${GIT_SHA}."

echo "== Smoke test: authenticated sample typst render =="
SMOKE_BODY_FILE="$(mktemp)"
cat > "${SMOKE_BODY_FILE}" <<'JSON'
{"template":{"source":"= Smoke\n#json(bytes(sys.inputs.data)).label"},"data":{"label":"ok"}}
JSON
RENDER_RESPONSE="$(curl -fsS -X POST "${SERVICE_URL}/render/typst" \
  -H "content-type: application/json" \
  -H "x-render-secret: ${SECRET}" \
  --data @"${SMOKE_BODY_FILE}")"
rm -f "${SMOKE_BODY_FILE}"
if ! grep -q '"ok":true' <<<"${RENDER_RESPONSE}"; then
  echo "ERROR: sample typst render did not report ok:true" >&2
  echo "${RENDER_RESPONSE}" >&2
  exit 1
fi
echo "Sample typst render succeeded."

echo "== Smoke test: authenticated sample chromium render =="
CHROMIUM_SMOKE_BODY_FILE="$(mktemp)"
cat > "${CHROMIUM_SMOKE_BODY_FILE}" <<'JSON'
{"template":{"html":"<h1>Smoke</h1><p>{{ label }}</p>"},"data":{"label":"ok"}}
JSON
CHROMIUM_RENDER_RESPONSE="$(curl -fsS -X POST "${SERVICE_URL}/render/chromium" \
  -H "content-type: application/json" \
  -H "x-render-secret: ${SECRET}" \
  --data @"${CHROMIUM_SMOKE_BODY_FILE}")"
rm -f "${CHROMIUM_SMOKE_BODY_FILE}"
if ! grep -q '"ok":true' <<<"${CHROMIUM_RENDER_RESPONSE}"; then
  echo "ERROR: sample chromium render did not report ok:true" >&2
  echo "${CHROMIUM_RENDER_RESPONSE}" >&2
  exit 1
fi
echo "Sample chromium render succeeded."

# --- persist secret locally (never echoed) ----------------------------------------------------
LOCAL_DIR="${RENDER_SERVICE_DIR}/.local"
mkdir -p "${LOCAL_DIR}"
SECRET_FILE="${LOCAL_DIR}/render-service-secret"
printf '%s' "${SECRET}" > "${SECRET_FILE}"
chmod 600 "${SECRET_FILE}"
echo "Secret written to ${SECRET_FILE} (chmod 600, gitignored)."

# --- wire into Netlify env, if creds present --------------------------------------------------
if [[ -n "${NETLIFY_AUTH_TOKEN:-}" && -n "${NETLIFY_SITE_ID:-}" ]]; then
  echo "== Setting Netlify env vars via netlify-cli =="
  (cd "${REPO_ROOT}" && npx --yes netlify-cli env:set RENDER_SERVICE_URL "${SERVICE_URL}" --context production)
  (cd "${REPO_ROOT}" && npx --yes netlify-cli env:set RENDER_SERVICE_SECRET "${SECRET}" --context production)
  echo "Netlify env vars RENDER_SERVICE_URL / RENDER_SERVICE_SECRET set."
else
  echo "=============================================================================="
  echo "NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID not both present — set Netlify env by hand:"
  echo "  RENDER_SERVICE_URL    = ${SERVICE_URL}"
  echo "  RENDER_SERVICE_SECRET = (value in ${SECRET_FILE}, not printed here)"
  echo "=============================================================================="
fi

echo "== Done =="
