import { AGENT_ARTIFACT_JOB_STORE } from "../agent-artifact-jobs.js";
import { pdfToolOwnStorageGrant, runWithStorageGrant, type StorageGrant } from "../storage-grant.js";

/**
 * T12.13 — WHERE CAPTURE WRITES. Wolf ratified "option A, same-site writes" on 2026-08-14:
 * the capture plane persists its job records, screenshots and snapshot.v1 into PDF-TOOL'S
 * OWN Blob store, and the tenant reads/imports what it wants back through its own artifact
 * bridge. The consequence is the point of the whole task: **capture needs no per-site
 * Netlify PAT.** A tenant whose PDF_TOOL_STORAGE_TOKEN / PDF_TOOL_STORAGE_SITE_ID are unset
 * can still run a capture job end to end, because no cross-site credential is involved
 * anywhere in this plane — there is nothing to mint, nothing to rotate, and nothing to leak.
 *
 * Mechanically this is one ALS frame: every capture entrypoint runs its store work inside
 * runWithCaptureStorage, which BINDS pdf-tool's own-storage grant (see
 * PDF_TOOL_OWN_STORAGE_GRANT_TYPE in ../storage-grant.ts) for the duration. Because
 * storageGrantContext.run REPLACES whatever grant was ambient, a caller that still sends a
 * `storage` argument cannot make the capture plane write with its credential — the argument
 * is accepted by the transport (grant-optional) and then simply never used here.
 *
 * The `jobs` store deliberately stays pdf-tool's own operational job store
 * (AGENT_ARTIFACT_JOB_STORE — the same store the health probe round-trips) rather than the
 * canonical client-owned "pdf-tool-jobs" name: these records are now pdf-tool's own state,
 * not a tenant's. Job keys remain namespaced per project
 * (`projects/<projectId>/capture-jobs/...`, see ./jobs.ts), and every entrypoint resolves
 * projectId server-side, so one tenant can never name another's job.
 */
export function captureStorageGrant(projectId: string): StorageGrant {
  return pdfToolOwnStorageGrant(projectId, { jobs: AGENT_ARTIFACT_JOB_STORE });
}

export function runWithCaptureStorage<T>(projectId: string, fn: () => T): T {
  return runWithStorageGrant(captureStorageGrant(projectId), fn);
}
