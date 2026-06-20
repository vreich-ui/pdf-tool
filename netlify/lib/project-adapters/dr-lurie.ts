import { projectBlobStore } from "../blob-store.js";
import { sha256Hex, type ArtifactReference, type SaveArtifactBytesInput } from "../artifact-core/index.js";
import { writeArtifactReferenceIndexes } from "../artifact-core/artifact-index.js";
import type { ProjectArtifactAdapter } from "./types.js";

function safePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Invalid empty path segment");
  return safe;
}

function extensionForContentType(contentType: string, filename: string): string {
  const lower = filename.toLowerCase();
  if (contentType === "image/png" && !lower.endsWith(".png")) return ".png";
  if (contentType === "image/jpeg" && !lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) return ".jpg";
  if (contentType === "image/webp" && !lower.endsWith(".webp")) return ".webp";
  if (contentType === "application/pdf" && !lower.endsWith(".pdf")) return ".pdf";
  const match = lower.match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function validateBytes(input: SaveArtifactBytesInput, bytes: Buffer): void {
  if (bytes.byteLength === 0) throw new Error("Artifact bytes are empty");
  if (input.artifactKind === "image") {
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!isPng && !isJpeg && !isWebp) throw new Error("Unsupported or invalid image bytes");
  }
  if (input.artifactKind === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Unsupported or invalid PDF bytes");
}

export const drLurieAdapter: ProjectArtifactAdapter = {
  config: {
    projectId: "dr-lurie",
    siteIdEnv: "SITE_ID",
    blobsTokenEnv: "BLOBS_TOKEN",
    openAiKeyEnv: "OPENAI_API_KEY",
    artifactStoreName: "artifacts",
    artifactIndexStoreName: "artifact-index",
    allowedArtifactKinds: ["image", "pdf"],
    artifactReferenceAdapter: "dr-lurie",
    defaultModel: "dall-e-3",
    allowedModels: ["dall-e-3", "test-image-model", "alternate-test-image-model"],
    adapterVersion: "dr-lurie-v1"
  },
  async saveArtifactBytes(input) {
    const bytes = Buffer.from(input.bytes);
    validateBytes(input, bytes);
    const sha256 = input.sha256 ?? sha256Hex(bytes);
    const requestId = safePathSegment(input.requestId);
    const kind = safePathSegment(input.artifactKind);
    const extension = extensionForContentType(input.contentType, input.filename);
    const blobKey = `${kind}/${requestId}/${sha256}${extension}`;
    const artifact: ArtifactReference = {
      blobKey,
      sizeBytes: bytes.byteLength,
      sha256,
      contentType: input.contentType,
      createdAtISO: new Date().toISOString(),
      artifactKind: input.artifactKind,
      originalFilename: input.filename,
      label: input.label,
      tags: input.tags ?? [],
      metadata: {}
    };
    const blobStoreOptions = { siteID: process.env[this.config.siteIdEnv], token: process.env[this.config.blobsTokenEnv] };
    const store = await projectBlobStore(this.config.artifactStoreName, blobStoreOptions);
    await store.set(blobKey, bytes, { metadata: { requestId: input.requestId, sha256, contentType: input.contentType, artifactKind: input.artifactKind } });
    await store.setJSON(`${blobKey}.json`, artifact);
    await writeArtifactReferenceIndexes(input.requestId, artifact, { storeName: this.config.artifactIndexStoreName, projectId: input.projectId, slot: input.slot, filename: input.filename, ...blobStoreOptions });
    return artifact;
  }
};
