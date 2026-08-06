/**
 * Filename normalization + validation at the create_agent_artifact_job choke point, plus
 * by-filename collision handling at artifact-write time (artifact-layout.saveArtifactBytes).
 *
 * Covers, in order:
 *  - normalizeArtifactFilename() unit behavior (steps 1-9 of the spec)
 *  - validateArtifactJobRequest applying normalization AFTER schema validation succeeds
 *  - the create_agent_artifact_job response surfacing the final normalized filename
 *    top-level and in `destination`
 *  - collision handling: different bytes under the same normalized name get -2, -3, ...;
 *    identical bytes resubmitted under the same or a similar name dedupe and keep their name
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import {
  normalizeArtifactFilename,
  FilenameValidationError,
  GENERIC_ARTIFACT_FILENAME_STEMS,
  validateArtifactJobRequest,
} from "../netlify/lib/agent-artifact-jobs.js";
import { createAgentArtifactJob } from "../netlify/lib/agent-artifact-mcp.js";
import { saveArtifactBytes as saveCanonicalArtifactBytes } from "../netlify/lib/artifact-layout.js";
import { readArtifactReferenceByFilename } from "../netlify/lib/artifact-core/artifact-index.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");

// --- normalizeArtifactFilename: unit behavior ------------------------------------------------

test("normalizeArtifactFilename: strips a baked-in version suffix and lowercases separators", () => {
  assert.equal(normalizeArtifactFilename("Downloadable-PDFs-Explained-v3.pdf", "pdf"), "downloadable-pdfs-explained.pdf");
  assert.equal(normalizeArtifactFilename("Downloadable-PDFs-Explained-v2.pdf", "pdf"), "downloadable-pdfs-explained.pdf");
  assert.equal(normalizeArtifactFilename("downloadable-pdfs-explained.pdf", "pdf"), "downloadable-pdfs-explained.pdf");
});

test("normalizeArtifactFilename: mixed case, punctuation, and an em dash collapse to single hyphens", () => {
  assert.equal(normalizeArtifactFilename("PDF Tool — Product Catalog!.pdf", "pdf"), "pdf-tool-product-catalog.pdf");
});

test("normalizeArtifactFilename: transliterates accented Unicode to ASCII and keeps a two-word stem out of the generic list", () => {
  assert.equal(normalizeArtifactFilename("héader photo.WEBP", "webp"), "header-photo.webp");
  // Sanity check on the spec's own callout: "header-photo" must NOT be treated as generic,
  // even though its first word alone is.
  assert.ok(!GENERIC_ARTIFACT_FILENAME_STEMS.has("header-photo"));
  assert.ok(GENERIC_ARTIFACT_FILENAME_STEMS.has("header"));
});

test("normalizeArtifactFilename: an exact generic stem is rejected with FILENAME_TOO_GENERIC", () => {
  assert.throws(
    () => normalizeArtifactFilename("header.webp", "webp"),
    (error: unknown) => error instanceof FilenameValidationError && error.code === "FILENAME_TOO_GENERIC" && /document's own title\/topic/.test(error.message)
  );
  // Every listed generic stem is rejected the same way, standalone.
  for (const stem of GENERIC_ARTIFACT_FILENAME_STEMS) {
    assert.throws(() => normalizeArtifactFilename(`${stem}.pdf`, "pdf"), (error: unknown) => error instanceof FilenameValidationError && error.code === "FILENAME_TOO_GENERIC");
  }
});

test("normalizeArtifactFilename: a name that normalizes to nothing is rejected with FILENAME_INVALID", () => {
  assert.throws(
    () => normalizeArtifactFilename("!!!.pdf", "pdf"),
    (error: unknown) => error instanceof FilenameValidationError && error.code === "FILENAME_INVALID"
  );
});

test("normalizeArtifactFilename: a 200-character name truncates to <= 60 total chars, cut at a '-' boundary", () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
  const longRaw = `${words.join("-")}.pdf`; // well over 200 chars including extension
  assert.ok(longRaw.length > 200, "fixture precondition: raw name must exceed 200 chars");
  const result = normalizeArtifactFilename(longRaw, "pdf");
  assert.ok(result.length <= 60, `expected <= 60 chars, got ${result.length}: ${result}`);
  assert.ok(result.endsWith(".pdf"));
  const stem = result.slice(0, -".pdf".length);
  // Cut at a '-' boundary, not mid-word: the stem must not end with a partial "wordNN" that
  // isn't a full word from the source list, and must not itself end in a stray hyphen.
  assert.ok(!stem.endsWith("-"));
  const lastSegment = stem.split("-").pop()!;
  assert.ok(words.includes(lastSegment), `expected the stem to end on a whole word, got trailing segment "${lastSegment}"`);
});

// --- validateArtifactJobRequest: normalization is the single choke point ---------------------

test("validateArtifactJobRequest normalizes the filename after schema validation succeeds", async () => {
  const result = await validateArtifactJobRequest({
    projectId: "dr-lurie",
    requestId: "req-norm-1",
    artifactKind: "pdf",
    filename: "Downloadable-PDFs-Explained-v3.pdf",
    templateId: "some-template",
    data: { title: "x" },
    tags: [],
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.filename, "downloadable-pdfs-explained.pdf");
});

test("validateArtifactJobRequest rejects a generic filename stem with a typed FILENAME_TOO_GENERIC issue", async () => {
  const result = await validateArtifactJobRequest({
    projectId: "dr-lurie",
    requestId: "req-norm-2",
    artifactKind: "image",
    prompt: "a header photo",
    filename: "header.webp",
    requirements: { image: { outputFormat: "webp" } },
    tags: [],
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.deepEqual(result.error.issues[0].path, ["filename"]);
    assert.equal(result.error.issues[0].code, "FILENAME_TOO_GENERIC");
    assert.match(result.error.issues[0].message, /document's own title\/topic/);
  }
});

test("validateArtifactJobRequest does NOT reject a two-word stem that merely contains a generic word", async () => {
  const result = await validateArtifactJobRequest({
    projectId: "dr-lurie",
    requestId: "req-norm-3",
    artifactKind: "image",
    prompt: "a header photo",
    filename: "héader photo.webp",
    requirements: { image: { outputFormat: "webp" } },
    tags: [],
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.filename, "header-photo.webp");
});

// --- create_agent_artifact_job: response surfaces the final normalized filename --------------

async function withTriggerStub<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const CREATE_OPTS = { baseUrl: "https://pdf-tool.test", token: "test-token" };

test("create_agent_artifact_job echoes the final normalized filename top-level and in destination", async () => {
  await withTriggerStub(async () => {
    const result = await createAgentArtifactJob(
      {
        projectId: "dr-lurie",
        requestId: "req-mcp-norm",
        artifactKind: "image",
        prompt: "a product catalog cover",
        filename: "PDF Tool — Product Catalog!.png",
      },
      CREATE_OPTS
    );
    assert.equal(result.ok, true);
    const body = result as { filename?: string; destination?: { filename?: string } };
    assert.equal(body.filename, "pdf-tool-product-catalog.png");
    assert.equal(body.destination?.filename, "pdf-tool-product-catalog.png");
  });
});

test("create_agent_artifact_job rejects a generic filename with errorCode FILENAME_TOO_GENERIC", async () => {
  const result = await createAgentArtifactJob(
    { projectId: "dr-lurie", requestId: "req-mcp-generic", artifactKind: "image", prompt: "a header photo", filename: "header.webp", requirements: { image: { outputFormat: "webp" } } },
    CREATE_OPTS
  );
  assert.equal(result.ok, false);
  const body = result as { statusCode?: number; errorCode?: string; error?: string };
  assert.equal(body.statusCode, 400);
  assert.equal(body.errorCode, "FILENAME_TOO_GENERIC");
  assert.match(body.error ?? "", /document's own title\/topic/);
});

// --- collision handling: by-filename index at artifact-write time ----------------------------

test("collision handling: a second, DIFFERENT-bytes submission under the same normalized name gets a -2 suffix", async () => {
  const bytesA = pngBytes;
  const bytesB = Buffer.concat([pngBytes, Buffer.from([0x00, 0x01, 0x02])]); // different content, still starts with the PNG signature
  assert.notEqual(bytesA.toString("hex"), bytesB.toString("hex"));

  const first = await saveCanonicalArtifactBytes({
    projectId: "dr-lurie",
    requestId: "req-collision",
    artifactKind: "image",
    filename: "product-catalog-cover.png",
    contentType: "image/png",
    bytes: bytesA,
    tags: [],
  });
  assert.equal(first.filename, "product-catalog-cover.png");

  const second = await saveCanonicalArtifactBytes({
    projectId: "dr-lurie",
    requestId: "req-collision",
    artifactKind: "image",
    filename: "product-catalog-cover.png",
    contentType: "image/png",
    bytes: bytesB,
    tags: [],
  });
  assert.equal(second.filename, "product-catalog-cover-2.png", "different bytes under a colliding name must get a -2 suffix");
  assert.notEqual(second.sha256, first.sha256);
  // blobKey stays content-addressed and independent of the collision-resolved display name.
  assert.notEqual(second.blobKey, first.blobKey);
  assert.ok(second.blobKey.includes(second.sha256));

  const lookupFirst = await readArtifactReferenceByFilename("dr-lurie", "req-collision", "product-catalog-cover.png", { storeName: "artifact-index" });
  const lookupSecond = await readArtifactReferenceByFilename("dr-lurie", "req-collision", "product-catalog-cover-2.png", { storeName: "artifact-index" });
  assert.equal(lookupFirst?.sha256, first.sha256);
  assert.equal(lookupSecond?.sha256, second.sha256);

  // A third, yet-again-different submission continues the sequence.
  const bytesC = Buffer.concat([pngBytes, Buffer.from([0x03, 0x04])]);
  const third = await saveCanonicalArtifactBytes({
    projectId: "dr-lurie",
    requestId: "req-collision",
    artifactKind: "image",
    filename: "product-catalog-cover.png",
    contentType: "image/png",
    bytes: bytesC,
    tags: [],
  });
  assert.equal(third.filename, "product-catalog-cover-3.png");
});

test("collision handling: identical bytes resubmitted under the same or a similar name dedupe and keep the original name", async () => {
  const bytes = pngBytes;

  const first = await saveCanonicalArtifactBytes({
    projectId: "dr-lurie",
    requestId: "req-dedupe",
    artifactKind: "image",
    filename: "quarterly-report-cover.png",
    contentType: "image/png",
    bytes,
    tags: [],
  });
  assert.equal(first.filename, "quarterly-report-cover.png");

  // Resubmitted verbatim under the exact same name: the pre-existing same-bytes-same-name
  // dedupe path must keep working exactly as it does today — no -2 suffix.
  const again = await saveCanonicalArtifactBytes({
    projectId: "dr-lurie",
    requestId: "req-dedupe",
    artifactKind: "image",
    filename: "quarterly-report-cover.png",
    contentType: "image/png",
    bytes,
    tags: [],
  });
  assert.equal(again.filename, "quarterly-report-cover.png", "identical bytes under the identical name must not be renamed");
  assert.equal(again.sha256, first.sha256);

  // Resubmitted under a name that normalizes to the SAME stem (a caller re-deriving the name
  // from the same title with different capitalization/separators) is exactly what
  // normalizeArtifactFilename collapses upstream — simulate that by passing the same
  // already-normalized name again, this time built from a differently-punctuated source.
  const similar = normalizeArtifactFilename("Quarterly Report Cover.PNG", "png");
  assert.equal(similar, "quarterly-report-cover.png");
  const viaSimilarName = await saveCanonicalArtifactBytes({
    projectId: "dr-lurie",
    requestId: "req-dedupe",
    artifactKind: "image",
    filename: similar,
    contentType: "image/png",
    bytes,
    tags: [],
  });
  assert.equal(viaSimilarName.filename, "quarterly-report-cover.png", "identical bytes under a similarly-derived name must dedupe, not get a -2 suffix");
});
