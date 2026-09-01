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
 *
 * F3 — BINDING CONVENTION (how a template field actually references an assets.images entry;
 * this was previously undocumented anywhere in the codebase):
 *   - chromium: the entry's `assetId` (falling back to `name`/`id`) becomes the last path
 *     segment of a virtual URL the template's HTML/CSS references directly, e.g.
 *     `<img src="https://render.assets.invalid/<assetId>">` (see render-service/src/engines/
 *     chromium.ts's VIRTUAL_ASSET_HOST / assetMap).
 *   - typst: the entry is written to `assets/<assetId>` inside the render sandbox; the
 *     template's .typ source loads it with `image("assets/<assetId>")` (see render-service/
 *     src/engines/typst.ts).
 *   - react-pdf (docTree): an `image` node's `src` is `{ kind: "jobAsset", assetId }`; the
 *     interpreter looks up that exact `assetId` against `assets.images` at render time (see
 *     doc-tree/interpreter.ts + engines/react-pdf-render.ts's resolveImages). This path does
 *     NOT go through resolveJobAssetsForService (below) — react-pdf resolves images directly.
 *   - pdfme: NOT SUPPORTED. pdfme templates bind image data directly through the per-render
 *     `data` object (a data-URI string keyed by the schema field's `name`), never through
 *     `assets.images` — a pdfme job's `assets` parameter is accepted by the input schema but
 *     silently has no effect. If a pdfme image-binding-via-assets use case shows up, this is
 *     the mismatch to close (either wire it in pdfme-render.ts, or reject `assets` on pdfme
 *     jobs with a clear "not supported for pdfme" error instead of the current silent no-op).
 */
import { projectBlobStore } from "../artifact-core/blob-store.js";
import { projectStoreNames, validateProjectAccess } from "../project-descriptor.js";
import { RenderError } from "./errors.js";
import { DOC_TREE_LIMITS } from "./doc-tree/schema.js";
import { assertImageBytesDecodable, assertNotRemoteUrl } from "./image-decode.js";
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
  const accessIssue = validateProjectAccess(projectId);
  if (accessIssue) throw new RenderError("ASSET_NOT_FOUND", accessIssue);
  const stores = projectStoreNames();
  const resolvedStore = storeName ?? stores.artifacts;
  const allowedStores = new Set<string>(
    Object.values(stores).filter((name): name is string => typeof name === "string" && name.length > 0)
  );
  if (!allowedStores.has(resolvedStore)) {
    throw new RenderError("ASSET_NOT_FOUND", `Asset storeName "${resolvedStore}" is not accessible to this render`, {
      storeName: resolvedStore,
      allowedStores: [...allowedStores],
    });
  }
  const store = await projectBlobStore(resolvedStore);
  const value = await store.get(blobKey, { type: "arrayBuffer" }).catch(() => null);
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

/** Resolves assets.images entries to inline service assets. An entry with no `assetId` (nor
 * `name`/`id` fallback) is skipped — there is no name to bind it under, so nothing a
 * template could reference. An entry that DOES name an id but has neither a dataUri nor a
 * blobKey is a typed ASSET_SOURCE_MISSING rejection (D4/BRIEF 3.10) rather than a silent
 * skip — as is one whose `dataUri` is not a data URI at all — see the docstring at the top
 * of this file for the blobKey resolution path
 * (blobKey → base64 → bound at `https://render.assets.invalid/<assetId>` for chromium). */
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
      assertNotRemoteUrl(id, entry.dataUri);
      const comma = entry.dataUri.indexOf(",");
      // REVIEW: a dataUri with no comma is not a data URI at all. Skipping it silently (as
      // this did) put the entry back in exactly the position ASSET_SOURCE_MISSING exists to
      // rule out: a NAMED asset that resolves to nothing, surfacing later as a broken image
      // inside an otherwise-successful render instead of a typed error naming the asset.
      if (comma < 0) {
        throw new RenderError(
          "ASSET_SOURCE_MISSING",
          `Job asset "${id}" has a dataUri that is not a data URI (no "," separating the header from the payload)`,
          { assetId: id }
        );
      }
      contentType = contentType ?? entry.dataUri.slice(entry.dataUri.indexOf(":") + 1, entry.dataUri.indexOf(";"));
      bytes = Buffer.from(entry.dataUri.slice(comma + 1), "base64");
    } else {
      const blobKey = entry.blobKey ?? entry.artifactReference?.blobKey;
      // D4/BRIEF 3.10: an entry that names an assetId but has neither a dataUri nor a
      // blobKey to resolve it from is a typed rejection, not a silent skip — silently
      // dropping it would surface later, confusingly, as a broken/missing image inside the
      // render rather than a clear error naming the asset.
      if (!blobKey) {
        throw new RenderError("ASSET_SOURCE_MISSING", `Job asset "${id}" has neither a dataUri nor a blobKey to resolve it from`, { assetId: id });
      }
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

    // F1: fail fast (IMAGE_DECODE_ERROR naming this asset) on corrupted/truncated image
    // bytes here, BEFORE dispatching to the render service — a bad image handed to the
    // downstream renderer is not guaranteed to fail cleanly (see image-decode.ts).
    await assertImageBytesDecodable(id, bytes);

    resolved.push({
      name: safeAssetName(id),
      contentType: contentType ?? sniffContentType(bytes),
      bytesBase64: bytes.toString("base64"),
    });
  }

  return resolved;
}
