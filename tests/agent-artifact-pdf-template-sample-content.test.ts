/**
 * X2 (BRIEF R9 — the last, cosmetic wave): `templates/article_brochure_v1.json`'s
 * `sampleData` is the content the D3 publish-time thumbnail worker renders into
 * `thumbnails/<templateId>/v<n>.png` — it is the first thing a person sees when choosing
 * this template, so it has to be real, on-brand-looking content rather than lorem ipsum or a
 * bare-minimum schema-satisfying stub.
 *
 * This file locks that content in structurally so a future edit that "simplifies" the
 * fixture back down to placeholder text fails loudly here rather than only degrading a
 * thumbnail nobody is watching in CI. It is deliberately about CONTENT, not schema shape —
 * schema-shape strictness is already covered by
 * agent-artifact-pdf-template-article-brochure.test.ts (D2) — so it duplicates none of that
 * file's assertions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Walks up from this file's directory to find the repo-root `templates/` fixture — robust
 * to both a direct tsx run (tests/*.test.ts) and the compiled `.tmp-tests/tests/*.js` layout
 * `npm run test:netlify` actually executes (see tsconfig.test.json's outDir). */
function findRepoFile(relativePath: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate "${relativePath}" by walking up from ${import.meta.url}`);
}

interface SampleData {
  brand?: { logo?: unknown };
  title?: unknown;
  deck?: unknown;
  coverImage?: unknown;
  sections?: Array<{ heading?: unknown; paragraphs?: unknown[]; figure?: { assetId?: unknown } }>;
  pullQuotes?: Array<{ quote?: unknown; attribution?: unknown }>;
  sources?: Array<{ label?: unknown; url?: unknown; note?: unknown }>;
  footerNote?: unknown;
  disclaimer?: unknown;
}

function loadFixture(): { sampleData: SampleData; sampleAssets?: { images?: Array<Record<string, unknown>> } } {
  const filePath = findRepoFile("templates/article_brochure_v1.json");
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(parsed.templateId, "article_brochure_v1");
  assert.ok(parsed.sampleData && typeof parsed.sampleData === "object", "expected sampleData to be present");
  return { sampleData: parsed.sampleData as SampleData, sampleAssets: parsed.sampleAssets };
}

function loadSampleData(): SampleData {
  return loadFixture().sampleData;
}

/** Every image assetId the sample content binds, read out of sampleData rather than
 * hardcoded so it tracks whatever the fixture actually says. */
function referencedAssetIds(data: SampleData): string[] {
  const ids = new Set<string>();
  if (typeof data.brand?.logo === "string") ids.add(data.brand.logo);
  if (typeof data.coverImage === "string") ids.add(data.coverImage);
  for (const section of data.sections ?? []) {
    if (typeof section.figure?.assetId === "string") ids.add(section.figure.assetId);
  }
  return [...ids].sort();
}

/** Lorem-ipsum / bare-placeholder detection — deliberately loose (substring + a handful of
 * generic filler words), so it catches an accidental revert to boilerplate without being a
 * fragile exact-string match against today's specific wording. */
const PLACEHOLDER_PATTERN = /lorem ipsum|dolor sit amet|placeholder|sample text|todo|tbd|xxx|lorem$/i;

function assertNotPlaceholder(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, "string", `expected ${label} to be a string`);
  const text = value as string;
  assert.ok(text.trim().length > 0, `expected ${label} to be non-empty`);
  assert.ok(!PLACEHOLDER_PATTERN.test(text), `expected ${label} not to look like placeholder text, got: ${JSON.stringify(text)}`);
}

test("article_brochure_v1 sampleData: has a real, non-placeholder title and deck", () => {
  const data = loadSampleData();
  assertNotPlaceholder(data.title, "title");
  assertNotPlaceholder(data.deck, "deck");
  // A cover headline needs real substance to read as "a real article", not a two-word stub.
  assert.ok((data.title as string).length >= 10, `title looks too short to be a real headline: ${JSON.stringify(data.title)}`);
  assert.ok((data.deck as string).length >= 40, `deck looks too short to be a real dek: ${JSON.stringify(data.deck)}`);
});

test("article_brochure_v1 sampleData: a cover image asset is set", () => {
  const data = loadSampleData();
  assert.equal(typeof data.coverImage, "string");
  assert.ok((data.coverImage as string).length > 0, "expected a non-empty coverImage assetId");
});

test("article_brochure_v1 sampleData: exactly 3 sections, each with a heading and real paragraph copy", () => {
  const data = loadSampleData();
  assert.ok(Array.isArray(data.sections), "expected sections to be an array");
  assert.equal(data.sections!.length, 3, `expected exactly 3 sections, got ${data.sections!.length}`);
  for (const [i, section] of data.sections!.entries()) {
    assertNotPlaceholder(section.heading, `sections[${i}].heading`);
    assert.ok(Array.isArray(section.paragraphs) && section.paragraphs.length >= 1, `expected sections[${i}].paragraphs to be non-empty`);
    for (const [j, paragraph] of section.paragraphs!.entries()) {
      assertNotPlaceholder(paragraph, `sections[${i}].paragraphs[${j}]`);
      assert.ok((paragraph as string).length >= 30, `sections[${i}].paragraphs[${j}] looks too short to be real body copy`);
    }
  }
});

test("article_brochure_v1 sampleData: exactly 2 pull quotes, each with real quoted text", () => {
  const data = loadSampleData();
  assert.ok(Array.isArray(data.pullQuotes), "expected pullQuotes to be an array");
  assert.equal(data.pullQuotes!.length, 2, `expected exactly 2 pull quotes, got ${data.pullQuotes!.length}`);
  for (const [i, quote] of data.pullQuotes!.entries()) {
    assertNotPlaceholder(quote.quote, `pullQuotes[${i}].quote`);
    assert.ok((quote.quote as string).length >= 15, `pullQuotes[${i}].quote looks too short to be a real quote`);
  }
});

test("article_brochure_v1 sampleData: exactly 3 sources, each with a real label", () => {
  const data = loadSampleData();
  assert.ok(Array.isArray(data.sources), "expected sources to be an array");
  assert.equal(data.sources!.length, 3, `expected exactly 3 sources, got ${data.sources!.length}`);
  for (const [i, source] of data.sources!.entries()) {
    assertNotPlaceholder(source.label, `sources[${i}].label`);
  }
});

test("article_brochure_v1 sampleData: a real footerNote and disclaimer are present", () => {
  const data = loadSampleData();
  assertNotPlaceholder(data.footerNote, "footerNote");
  assertNotPlaceholder(data.disclaimer, "disclaimer");
  assert.ok((data.disclaimer as string).length >= 40, `disclaimer looks too short to be a real disclaimer: ${JSON.stringify(data.disclaimer)}`);
});

/**
 * REVIEW: the content guard above is only half the story. This template's cover binds
 * `brand.logo` and `coverImage` (and each section may bind a `figure.assetId`) as
 * `https://render.assets.invalid/<assetId>` — ids that resolve to nothing unless the version
 * ALSO ships the bytes behind them. The publish-time thumbnail worker renders exactly this
 * sampleData, so a fixture that names an image it does not supply produces a shipped preview
 * full of broken images. Keep the two sides in lockstep here.
 */
test("article_brochure_v1: every assetId sampleData references is supplied by sampleAssets", () => {
  const { sampleData, sampleAssets } = loadFixture();
  const referenced = referencedAssetIds(sampleData);
  assert.ok(referenced.length > 0, "expected the sample content to reference at least one image asset");

  const images = sampleAssets?.images;
  assert.ok(Array.isArray(images), "expected sampleAssets.images to be an array");

  const supplied = new Map(images!.map((image) => [String(image.assetId), image]));
  for (const assetId of referenced) {
    const image = supplied.get(assetId);
    assert.ok(image, `sampleData references assetId "${assetId}" but sampleAssets supplies no entry for it`);
    // The resolver (job-assets.ts) needs one of these two; an entry with neither is a typed
    // ASSET_SOURCE_MISSING at render time, i.e. no thumbnail at all.
    const hasSource = typeof image!.dataUri === "string" || typeof image!.blobKey === "string";
    assert.ok(hasSource, `sampleAssets entry "${assetId}" has neither a dataUri nor a blobKey to resolve it from`);
    if (typeof image!.dataUri === "string") {
      assert.match(image!.dataUri as string, /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i, `sampleAssets entry "${assetId}" is not a base64 image data URI`);
    }
  }
});
