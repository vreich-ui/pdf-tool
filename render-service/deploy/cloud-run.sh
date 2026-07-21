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
  echo "== typst.sha256 is unset (TBD) — downloading typst v${TYPST_VERSION} to compute + pin it =="
  TARBALL_URL="https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz"
  TMP_TARBALL="$(mktemp)"
  curl -fsSL -o "${TMP_TARBALL}" "${TARBALL_URL}"
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
  TYPST_SHA256="${CURRENT_SHA_LINE}"
  echo "== Using pinned typst sha256 from typst.sha256: ${TYPST_SHA256} =="
fi

# --- build via Cloud Build (gcloud builds submit doesn't take --build-arg directly) -------
GIT_SHA="$(cd "${REPO_ROOT}" && git rev-parse --short HEAD)"
IMAGE_TAG="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}:${GIT_SHA}"

echo "== Building + pushing ${IMAGE_TAG} via Cloud Build =="
gcloud builds submit "${RENDER_SERVICE_DIR}" \
  --config="${RENDER_SERVICE_DIR}/deploy/cloudbuild.yaml" \
  --substitutions="_TYPST_VERSION=${TYPST_VERSION},_TYPST_SHA256=${TYPST_SHA256},_IMAGE_TAG=${IMAGE_TAG}"

# --- secret ---------------------------------------------------------------------------------
SECRET="${RENDER_SERVICE_SECRET:-$(openssl rand -hex 32)}"

# --- deploy to Cloud Run ---------------------------------------------------------------------
echo "== Deploying ${SERVICE_NAME} to Cloud Run (${REGION}) =="
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE_TAG}" \
  --region="${REGION}" \
  --allow-unauthenticated \
  --memory=1Gi \
  --cpu=1 \
  --timeout=300 \
  --max-instances=3 \
  --set-env-vars="RENDER_SERVICE_SECRET=${SECRET}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --format='value(status.url)')"
echo "Service URL: ${SERVICE_URL}"

# --- smoke test -------------------------------------------------------------------------------
echo "== Smoke test: GET /healthz =="
HEALTH_RESPONSE="$(curl -fsS "${SERVICE_URL}/healthz")"
echo "${HEALTH_RESPONSE}"
if ! grep -q '"ok":true' <<<"${HEALTH_RESPONSE}"; then
  echo "ERROR: /healthz did not report ok:true" >&2
  exit 1
fi
if ! grep -q '"typst":{"available":true' <<<"${HEALTH_RESPONSE}"; then
  echo "ERROR: /healthz reports typst engine unavailable" >&2
  exit 1
fi

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
echo "Sample render succeeded."

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
