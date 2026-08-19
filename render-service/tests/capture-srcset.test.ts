import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTRACT_PAGE_MODEL_SCRIPT } from "../src/capture.js";

// Regression test for T12.17: srcsetCandidates() used to be `value.split(',')[0]`, which
// truncated a Wix transform URL's first candidate at the first comma INSIDE the URL
// (e.g. '.../v1/fill/w_146,h_194,.../file.jpg 1x, ...' -> '.../v1/fill/w_146'), a prefix Wix
// answers with HTTP 403. This test extracts the REAL srcsetCandidates source out of the
// shipped EXTRACT_PAGE_MODEL_SCRIPT template literal (rather than a hand copy of it) and runs
// it through `new Function(...)`, so any future edit to the in-browser script is exercised
// here without needing a browser/jsdom.

function loadSrcsetCandidates(): (value: unknown) => string[] {
  const match = EXTRACT_PAGE_MODEL_SCRIPT.match(
    /const srcsetCandidates = \(value\) => \{[\s\S]*?\n {2}\};/
  );
  assert.ok(match, "EXTRACT_PAGE_MODEL_SCRIPT must contain a srcsetCandidates(value) helper");
  // EXTRACT_PAGE_MODEL_SCRIPT is already the evaluated runtime string (its source in
  // capture.ts is a backtick template literal, so escapes like `\\s` have already collapsed
  // to `\s` by the time we read this constant) — compile the extracted slice as-is.
  const source = match[0];
  return new Function(`${source}\nreturn srcsetCandidates;`)() as (
    value: unknown
  ) => string[];
}

const srcsetCandidates = loadSrcsetCandidates();

test("Wix-shaped srcset candidate with internal commas resolves to the full untruncated URL", () => {
  const wixUrl =
    "https://static.wixstatic.com/media/X~mv2.jpg/v1/fill/w_146,h_194,q_75,enc_avif,quality_auto/X~mv2.jpg";
  const srcset = `${wixUrl} 1x, https://static.wixstatic.com/media/X~mv2.jpg/v1/fill/w_292,h_388,q_75,enc_avif,quality_auto/X~mv2.jpg 2x`;
  const [first] = srcsetCandidates(srcset);
  assert.equal(first, wixUrl);
  assert.ok(!first.endsWith("/v1/fill/w_146"), "must not truncate at the first internal comma");
});

test("plain comma-separated srcset list yields both URLs", () => {
  const result = srcsetCandidates("a.jpg, b.jpg");
  assert.deepEqual(result, ["a.jpg", "b.jpg"]);
});

test("width/pixel-density descriptors are not mistaken for URLs", () => {
  assert.deepEqual(srcsetCandidates("a.jpg 1x, b.jpg 480w"), ["a.jpg", "b.jpg"]);
});

test("empty string yields no candidates", () => {
  assert.deepEqual(srcsetCandidates(""), []);
});

test("null/undefined yield no candidates", () => {
  assert.deepEqual(srcsetCandidates(null), []);
  assert.deepEqual(srcsetCandidates(undefined), []);
});
