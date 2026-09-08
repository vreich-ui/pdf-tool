/**
 * `check_image_text` matches against every word OCR found, but reports a capped `detected`
 * list. Without saying so, the response contradicts itself — a string can sit in `matched`
 * while being absent from `detected`, which reads as proof the text is missing from the
 * image. That misreading happened for real on 2026-09-08.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTextCheck, MAX_REPORTED_ITEMS } from "../netlify/lib/image-annotate/text-match.js";

function words(...texts: string[]) {
  return texts.map((text) => ({ text, conf: 90 }));
}

test("expect mode says when `detected` was capped, and matching still uses everything", () => {
  // More distinct words than the report will show, with the needle deliberately last.
  const filler = Array.from({ length: MAX_REPORTED_ITEMS + 5 }, (_, i) => `filler${i}word`);
  const report = evaluateTextCheck({ mode: "expect", expect: ["needle phrase"], words: words(...filler, "needle", "phrase") });

  assert.equal(report.ok, true, "the needle is in the OCR text, so the gate passes");
  assert.deepEqual(report.matched, ["needle phrase"]);
  assert.equal(report.detected.length, MAX_REPORTED_ITEMS, "the reported list is capped");
  assert.ok(report.detectedTotal > report.detected.length);
  assert.equal(report.detectedTruncated, true);
  assert.ok(
    report.warnings.some((w) => /omitted from `detected`/.test(w) && /matching ran against all/.test(w)),
    "the report must say why a matched string is not in the list it shows"
  );
  // The self-contradiction the flag exists to explain.
  assert.ok(!report.detected.includes("needle"), "precondition: the needle really is outside the shown list");
});

test("an untruncated report says so, and reports its own count", () => {
  const report = evaluateTextCheck({ mode: "expect", expect: ["hello"], words: words("hello", "world") });
  assert.equal(report.detectedTruncated, false);
  assert.equal(report.detectedTotal, 2);
  assert.deepEqual(report.detected, ["hello", "world"]);
  assert.deepEqual(report.warnings, []);
});

test("a genuinely absent string is still reported missing", () => {
  const report = evaluateTextCheck({ mode: "expect", expect: ["purple giraffe"], words: words("hello", "world") });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ["purple giraffe"]);
});

test("expect_none reports the same counts", () => {
  const clean = evaluateTextCheck({ mode: "expect_none", words: words("a", "b") });
  assert.equal(clean.ok, true);
  assert.equal(clean.detectedTotal, 0);
  assert.equal(clean.detectedTruncated, false);

  const leaked = evaluateTextCheck({ mode: "expect_none", words: words("Moisturizer", "Serum") });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.detectedTotal, 2);
});
