/**
 * T4 — pure matching-policy tests for `check_image_text` (image-annotate/text-match.ts). No
 * I/O, no network, no render service: every test here is plain string comparison against
 * hand-built OCR-shaped `words[]` arrays.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTextCheck, foldConfusables, normalizeForMatch } from "../netlify/lib/image-annotate/text-match.js";

function word(text: string, conf = 90): { text: string; conf: number } {
  return { text, conf };
}

// ---------------------------------------------------------------------------------------
// normalizeForMatch / foldConfusables
// ---------------------------------------------------------------------------------------

test("normalizeForMatch: case-folds and collapses whitespace (including newlines) to a single space", () => {
  assert.equal(normalizeForMatch("  Hello   World  "), "hello world");
  assert.equal(normalizeForMatch("Hello\nWorld"), "hello world");
  assert.equal(normalizeForMatch("HELLO"), "hello");
});

test("foldConfusables: '0'/'o' fold together, '1'/'l'/'i' fold together, nothing else changes", () => {
  assert.equal(foldConfusables("n0"), "no");
  assert.equal(foldConfusables("gl0w"), "glow");
  assert.equal(foldConfusables("1etre"), "letre");
  assert.equal(foldConfusables("ill"), "lll");
  assert.equal(foldConfusables("sugar"), "sugar");
});

test("normalizeForMatch: '0' and 'O', and '1'/'l'/'I', compare equal after case-folding + confusable-folding", () => {
  assert.equal(normalizeForMatch("N0"), normalizeForMatch("No"));
  assert.equal(normalizeForMatch("NAC-1"), normalizeForMatch("NAC-l"));
  assert.equal(normalizeForMatch("Illinois"), normalizeForMatch("lllin0is"));
});

test("normalizeForMatch: a genuinely different letter (outside the confusable set) does NOT fold away", () => {
  assert.notEqual(normalizeForMatch("Cysteine"), normalizeForMatch("Custeine"), "y vs u is a real misspelling, not a confusable pair");
  assert.notEqual(normalizeForMatch("Glutathione"), normalizeForMatch("Glutathoine"), "transposed letters are a real misspelling");
});

// ---------------------------------------------------------------------------------------
// expect_none
// ---------------------------------------------------------------------------------------

test("expect_none: no words at all passes cleanly", () => {
  const report = evaluateTextCheck({ mode: "expect_none", words: [] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.detected, []);
  assert.deepEqual(report.warnings, []);
});

test("expect_none: a single stray character (OCR noise) is NOT flagged", () => {
  const report = evaluateTextCheck({ mode: "expect_none", words: [word("l"), word("-"), word(".")] });
  assert.equal(report.ok, true, "single-character / punctuation-only reads are below the noise floor");
  assert.deepEqual(report.detected, []);
});

test("expect_none: real leaked text (the NAC/cysteine/glutathione failure) IS flagged", () => {
  const report = evaluateTextCheck({ mode: "expect_none", words: [word("NAC"), word("Cysteine")] });
  assert.equal(report.ok, false);
  assert.deepEqual(report.detected, ["NAC", "Cysteine"]);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0], /NAC/);
  assert.match(report.warnings[0], /expect_none/);
});

test("expect_none: low-confidence words are STILL flagged — no confidence floor, only a length floor", () => {
  const report = evaluateTextCheck({ mode: "expect_none", words: [word("Serum", 12)] });
  assert.equal(report.ok, false, "a faint/low-confidence leaked word is still a leak worth flagging");
  assert.deepEqual(report.detected, ["Serum"]);
});

test("expect_none: duplicate words (case/confusable-equivalent) are deduplicated in `detected`", () => {
  const report = evaluateTextCheck({ mode: "expect_none", words: [word("N0"), word("no"), word("N0")] });
  assert.equal(report.detected.length, 1, "N0/no/N0 all normalize to the same fragment");
});

// ---------------------------------------------------------------------------------------
// expect
// ---------------------------------------------------------------------------------------

test("expect: every requested string found -> ok true, matched lists all of them, missing is empty", () => {
  const report = evaluateTextCheck({
    mode: "expect",
    expect: ["Glutathione", "Support"],
    words: [word("Glutathione"), word("Support")],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.matched, ["Glutathione", "Support"]);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.warnings, []);
});

test("expect: a missing string -> ok false, named in missing[] and in a warning", () => {
  const report = evaluateTextCheck({
    mode: "expect",
    expect: ["Glutathione", "Antioxidant"],
    words: [word("Glutathione")],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.matched, ["Glutathione"]);
  assert.deepEqual(report.missing, ["Antioxidant"]);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /Antioxidant/);
});

test("expect: matching is case-insensitive and whitespace-collapsed", () => {
  const report = evaluateTextCheck({
    mode: "expect",
    expect: ["free radical support"],
    words: [word("FREE"), word("RADICAL"), word("SUPPORT")],
  });
  assert.equal(report.ok, true, "multi-word phrase matches across separately OCR'd words, case-insensitively");
});

test("expect: the 0/O and 1/l/I confusable pairs are tolerated in BOTH directions", () => {
  const foundWithZero = evaluateTextCheck({ mode: "expect", expect: ["Vitamin B12"], words: [word("Vitamin"), word("Bl2")] });
  assert.equal(foundWithZero.ok, true, 'expect "B12" matches OCR reading it as "Bl2" (1 read as l)');

  const foundWithLetterO = evaluateTextCheck({ mode: "expect", expect: ["N0-Rinse"], words: [word("No-Rinse")] });
  assert.equal(foundWithLetterO.ok, true, 'expect written with a zero matches OCR reading a letter O');
});

test("expect: a genuine misspelling in `expect` is NOT satisfied by the correctly-spelled detected text", () => {
  const report = evaluateTextCheck({ mode: "expect", expect: ["Glutathoine"], words: [word("Glutathione")] });
  assert.equal(report.ok, false, "the policy must be strict enough that a real misspelling still fails");
  assert.deepEqual(report.missing, ["Glutathoine"]);
});

test("expect: order matters — two words that both appear but in the wrong order do not satisfy a phrase", () => {
  const report = evaluateTextCheck({ mode: "expect", expect: ["Radical Free"], words: [word("Free"), word("Radical")] });
  assert.equal(report.ok, false, '"Radical Free" is not a substring of "free radical" — reading order is preserved, not relaxed into a bag of words');
});

test("expect: low-confidence recognitions still count toward a match (no confidence floor for expect either)", () => {
  const report = evaluateTextCheck({ mode: "expect", expect: ["Cysteine"], words: [word("Cysteine", 3)] });
  assert.equal(report.ok, true, "a faint but correctly-read word should not be treated as absent");
});
