/**
 * Shared job-asset resolution for render-service engines (typst, chromium). Resolves the
 * job's assets.images entries to inline base64 payloads for the service request — the
 * storage grant never leaves Netlify. Supported entry shapes:
 *   { assetId, dataUri: "data:image/png;base64,..." }
 *   { assetId, blobKey, storeName? }               — read from an allowlisted client store
 *   { assetId, artifactReference: { blobKey, storeName? } }
 * Store names are constrained to the stores this render is entitled to (the project's own
 * artifact/template stores plus whatever an active storage grant names) — Blobs tokens are
 * site-wide, so the store NAME is the access boundary.
 */
import { projectBlobStore } from "../artifact-core/blob-store.js";
import { currentStorageGrant } from "../storage-grant.js";
import { getProjectAdapter } from "../agent-project-registry.js";
import { RenderError } from "./errors.js";
import { DOC_TREE_LIMITS } from "./doc-tree/schema.js";
import type { RenderServiceAsset } from "./render-service-client.js";

interface JobImageAssetEntry {
  assetId?: string;
  name?: string;
  id?: string;
  dataUri?: string;
  storeName?: string;
  blobKey?: string;
  contentType?: string;
  artifactReference?: { storeName?: string; blobKey?: string; contentType?: string };
}

function entryId(entry: JobImageAssetEntry): string | undefined {
  return entry.assetId ?? entry.name ?? entry.id;
}

function safeAssetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/\.{2,}/g, ".");
}

function sniffContentType(bytes: Buffer): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

async function readAllowlistedBlob(projectId: string, storeName: string | undefined, blobKey: string): Promise<Buffer | null> {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new RenderError("ASSET_NOT_FOUND", `Unsupported projectId: ${projectId}`);
  const resolvedStore = storeName ?? adapter.config.artifactStoreName;
  const grant = currentStorageGrant();
  const allowedStores = new Set<string>(
    [adapter.config.artifactStoreName, adapter.config.templateStoreName, ...(grant ? Object.values(grant.stores) : [])].filter(
      (name): name is string => typeof name === "string" && name.length > 0
    )
  );
  if (!allowedStores.has(resolvedStore)) {
    throw new RenderError("ASSET_NOT_FOUND", `Asset storeName "${resolvedStore}" is not accessible to this render`, {
      storeName: resolvedStore,
      allowedStores: [...allowedStores],
    });
  }
  const store = await projectBlobStore(resolvedStore, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
  });
  const value = await store.get(blobKey, { type: "arrayBuffer" }).catch(() => null);
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

/** Resolves assets.images entries to inline service assets. Entries without a usable
 * payload (no dataUri and no blobKey) are skipped — the service render will fail with a
 * clear message only if the template actually references the missing name. */
export async function resolveJobAssetsForService(projectId: string, assets: { images?: unknown[] } | undefined): Promise<RenderServiceAsset[]> {
  const entries: JobImageAssetEntry[] = Array.isArray(assets?.images) ? (assets.images as JobImageAssetEntry[]) : [];
  const resolved: RenderServiceAsset[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = entryId(entry);
    if (!id) continue;

    let bytes: Buffer | undefined;
    let contentType = entry.contentType ?? entry.artifactReference?.contentType;

    if (typeof entry.dataUri === "string") {
      const comma = entry.dataUri.indexOf(",");
      if (comma < 0) continue;
      contentType = contentType ?? entry.dataUri.slice(entry.dataUri.indexOf(":") + 1, entry.dataUri.indexOf(";"));
      bytes = Buffer.from(entry.dataUri.slice(comma + 1), "base64");
    } else {
      const blobKey = entry.blobKey ?? entry.artifactReference?.blobKey;
      if (!blobKey) continue;
      const storeName = entry.storeName ?? entry.artifactReference?.storeName;
      const read = await readAllowlistedBlob(projectId, storeName, blobKey);
      if (!read) {
        throw new RenderError("ASSET_NOT_FOUND", `Job asset "${id}" blob not found: ${blobKey}`, { assetId: id, blobKey });
      }
      bytes = read;
    }

    if (bytes.byteLength > DOC_TREE_LIMITS.maxAssetBytes) {
      throw new RenderError("ASSET_TOO_LARGE", `Job asset "${id}" exceeds ${DOC_TREE_LIMITS.maxAssetBytes} bytes`, {
        assetId: id,
        actual: bytes.byteLength,
      });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > DOC_TREE_LIMITS.maxAssetBytesTotal) {
      throw new RenderError("ASSET_TOO_LARGE", `Job assets exceed the ${DOC_TREE_LIMITS.maxAssetBytesTotal}-byte per-render budget`, { totalBytes });
    }

    resolved.push({
      name: safeAssetName(id),
      contentType: contentType ?? sniffContentType(bytes),
      bytesBase64: bytes.toString("base64"),
    });
  }

  return resolved;
}
