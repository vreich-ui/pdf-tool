/**
 * T4 — the matching policy behind `check_image_text`'s two modes. Pure functions, no I/O:
 * takes the OCR words the render service reported (`pdf-render/ocr-client.ts`) and decides
 * `{ detected, ok, warnings }`. This module owns the ENTIRE definition of "found" — the tool
 * wiring (agent-artifact-image-text-check.ts) never compares strings itself.
 *
 * WARN, NOT BLOCK (BRIEF §1, same discipline as the PDF quality gate). `ok: false` here is
 * information for a caller to read, never a thrown failure — the tool wiring always returns
 * `ok: true` at the ArtifactReference/HTTP-envelope level (the CALL succeeded) with this
 * report's own `ok` nested underneath, exactly the way `qualityGate.passed` rides on a
 * `complete` job rather than failing it.
 *
 * ── Normalization: what "the same text" means here ──────────────────────────────────────
 *
 * OCR output is noisy in three specific, well-understood ways this policy corrects for, and
 * deliberately no others:
 *
 *   1. CASE. Tesseract's segmentation is case-sensitive in ways rendering is not (a caption's
 *      CSS can uppercase text the spec's `content` never did) — compared case-insensitively.
 *   2. WHITESPACE. Line breaks, multiple spaces from column/paragraph segmentation, and
 *      leading/trailing space are none of them meaningful to "did this string appear" —
 *      every run of whitespace collapses to one space before comparing.
 *   3. A NARROW, NAMED confusable set: '0'/'o' and '1'/'l'/'i' — the pairs BRIEF calls out
 *      by name, and the ones an OCR engine's own character classifier most often confuses at
 *      typical caption font sizes (a lowercase L, a digit one and a capital I are near-
 *      identical in most sans-serif fonts; a zero and a capital O differ only by an aspect
 *      ratio tesseract does not always resolve at small point sizes). Each character in a
 *      class is folded to that class's canonical form, so "N0" and "No" and "N0" all compare
 *      equal, and so do "1" / "l" / "I" wherever they appear.
 *
 * NOTHING ELSE IS FOLDED. There is no edit-distance/fuzzy match, no dropped punctuation
 * beyond whitespace, no stemming. This is the deliberate other half of the policy: a
 * genuinely MISSPELLED label — "Custeine" for "Cysteine", "Glutathoine" for "Glutathione" —
 * differs by a letter outside the confusable set and therefore does NOT match. A caller that
 * wants "close enough" fuzzy matching does not get it from this tool; `check_image_text`
 * proves a string is (or is not) LITERALLY present, modulo how an OCR engine reads glyphs,
 * not how a human might approximately reconstruct a word.
 *
 * SUBSTRING, NOT WHOLE-STRING. `expect` strings are checked as a normalized substring of the
 * normalized, space-joined detected text — not word-for-word tokenized — so a caller can
 * check for a phrase ("Free Radical Support") without needing it to be tesseract's own word
 * boundary, and a caller checking one word inside a longer detected phrase still matches.
 * Order is NOT relaxed: OCR preserves left-to-right reading order for text on one visual
 * line (the render service's TSV emits words in that order), so an `expect` string is
 * expected to appear in the same order it was written — this is what keeps two unrelated
 * words that both happen to appear somewhere in the image from counting as one phrase match.
 */

export type TextCheckMode = "expect_none" | "expect";

export interface TextCheckWord {
  text: string;
  /** 0-100, tesseract's own confidence for this word. */
  conf: number;
}

export interface TextCheckInput {
  mode: TextCheckMode;
  /** Required (non-empty) for `mode: "expect"`; ignored for `mode: "expect_none"`. */
  expect?: string[];
  words: TextCheckWord[];
}

export interface TextCheckReport {
  mode: TextCheckMode;
  /** The raw (un-normalized) text of every word this gate treated as SIGNIFICANT — see
   * MIN_SIGNIFICANT_CHARS below. Deduplicated by normalized form, original casing kept from
   * the first occurrence, capped at MAX_REPORTED_ITEMS so a genuinely text-heavy image (the
   * base image model itself is not a diagram of a poem) reports a pattern, not a flood. */
  detected: string[];
  /** How many distinct fragments were actually detected, before `detected` was capped at
   * MAX_REPORTED_ITEMS. Matching always runs against ALL of them, so without this a string
   * could appear in `matched` while being absent from the `detected` list shown — a report
   * that contradicts itself, and reads as proof the text is missing when it is not. */
  detectedTotal: number;
  /** True when `detected` shows fewer fragments than were found. */
  detectedTruncated: boolean;
  /** The gate's own verdict: for `expect_none`, true iff nothing significant was detected;
   * for `expect`, true iff every string in `expect` was found. */
  ok: boolean;
  warnings: string[];
  /** `mode: "expect"` only: which `expect` strings WERE found, in the order given. */
  matched?: string[];
  /** `mode: "expect"` only: which `expect` strings were NOT found, in the order given. */
  missing?: string[];
}

/** A word shorter than this (after normalization) is treated as OCR noise rather than
 * leaked/rendered text — a single stray "l" or "." misread off a fabric wrinkle or a JPEG
 * artifact is common and meaningless. NOT applied as a confidence floor: `expect_none`
 * deliberately stays sensitive to LOW-confidence recognitions too (a faint, half-legible
 * leaked word is still a leak worth flagging), trading a few extra noise warnings — which
 * cost nothing, this gate never blocks — for not missing a real one. */
const MIN_SIGNIFICANT_CHARS = 2;
const MAX_REPORTED_ITEMS = 20;

// ---------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------

/** '0'/'o' and '1'/'l'/'i' — see the module doc comment for why exactly these two classes
 * and no others. Each class folds to ONE canonical member so every character in it compares
 * equal after folding. Applied AFTER lowercasing, so only lowercase forms are listed. */
const CONFUSABLE_CLASSES: ReadonlyArray<{ canonical: string; members: readonly string[] }> = [
  { canonical: "o", members: ["0"] },
  { canonical: "l", members: ["1", "i"] },
];

const CONFUSABLE_FOLD: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_CLASSES.flatMap(({ canonical, members }) => members.map((member) => [member, canonical] as const))
);

/** Folds ONLY the characters in CONFUSABLE_CLASSES; every other character passes through
 * untouched — this is what keeps a genuine misspelling outside the confusable set failing
 * to match (see the module doc comment). */
export function foldConfusables(input: string): string {
  let out = "";
  for (const ch of input) out += CONFUSABLE_FOLD.get(ch) ?? ch;
  return out;
}

/** Case-fold, collapse all whitespace runs (including newlines) to one space, trim, then
 * fold the confusable set. The one function every comparison in this module goes through —
 * two strings are "the same" here iff this returns the same value for both. */
export function normalizeForMatch(input: string): string {
  const collapsed = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return foldConfusables(collapsed);
}

// ---------------------------------------------------------------------------------------
// Significant words (the expect_none noise floor)
// ---------------------------------------------------------------------------------------

interface SignificantWord {
  raw: string;
  normalized: string;
}

function significantWords(words: TextCheckWord[]): SignificantWord[] {
  const out: SignificantWord[] = [];
  for (const word of words) {
    const raw = word.text.trim();
    if (raw.length === 0) continue;
    const normalized = normalizeForMatch(raw);
    // Count only alphanumeric characters toward the length floor: a word that OCR read as
    // pure punctuation ("--", "..") is exactly the noise this floor exists to drop, even if
    // its raw character count clears MIN_SIGNIFICANT_CHARS.
    const alnumChars = normalized.replace(/[^a-z0-9]/g, "").length;
    if (alnumChars < MIN_SIGNIFICANT_CHARS) continue;
    out.push({ raw, normalized });
  }
  return out;
}

function dedupeCapped(items: SignificantWord[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item.normalized)) continue;
    seen.add(item.normalized);
    result.push(item.raw);
    if (result.length >= MAX_REPORTED_ITEMS) break;
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// The two modes
// ---------------------------------------------------------------------------------------

function evaluateExpectNone(words: TextCheckWord[]): TextCheckReport {
  const significant = significantWords(words);
  const detected = dedupeCapped(significant);
  const ok = detected.length === 0;
  const warnings = ok
    ? []
    : detected.map((text) => `Detected text "${text}" in a generated image expected to contain no text (expect_none)`);
  const detectedTotal = new Set(significant.map((word) => word.normalized)).size;
  if (detectedTotal > detected.length) {
    warnings.push(`${detectedTotal - detected.length} additional detected fragment(s) omitted (capped at ${MAX_REPORTED_ITEMS})`);
  }
  return { mode: "expect_none", detected, detectedTotal, detectedTruncated: detectedTotal > detected.length, ok, warnings };
}

function evaluateExpect(words: TextCheckWord[], expect: string[]): TextCheckReport {
  // ALL words, no confidence/length floor: a caller checking whether ITS OWN rendered text
  // appears wants every word tesseract found, including a faint or partial one — unlike
  // expect_none's leak-detection question, dropping "noise" here could hide a real, if
  // slightly under-confident, recognition of the caller's own text.
  const orderedRaw = words.map((w) => w.text.trim()).filter((t) => t.length > 0);
  const detected = dedupeCapped(orderedRaw.map((raw) => ({ raw, normalized: normalizeForMatch(raw) })));
  const haystack = normalizeForMatch(orderedRaw.join(" "));

  const matched: string[] = [];
  const missing: string[] = [];
  for (const needle of expect) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && haystack.includes(normalizedNeedle)) matched.push(needle);
    else missing.push(needle);
  }

  const ok = missing.length === 0;
  const warnings = missing.map((needle) => `Expected text "${needle}" was not found in the rendered output (expect)`);
  // The haystack above is built from EVERY word; `detected` is capped for readability. Saying
  // so is not cosmetic: without it a caller reads a short `detected` list as evidence that a
  // matched string is not really in the image.
  const detectedTotal = new Set(orderedRaw.map((raw) => normalizeForMatch(raw))).size;
  if (detectedTotal > detected.length) {
    warnings.push(`${detectedTotal - detected.length} additional detected fragment(s) omitted from \`detected\` (capped at ${MAX_REPORTED_ITEMS}); matching ran against all ${detectedTotal}`);
  }
  return { mode: "expect", detected, detectedTotal, detectedTruncated: detectedTotal > detected.length, ok, warnings, matched, missing };
}

/**
 * Evaluates the gate. `mode: "expect"` with an empty/missing `expect` is a caller error
 * (nothing was asked for), NOT evaluated here — the tool wiring validates that BEFORE OCR
 * even runs, so this function can assume `expect` is a non-empty array whenever mode is
 * "expect".
 */
export function evaluateTextCheck(input: TextCheckInput): TextCheckReport {
  if (input.mode === "expect_none") return evaluateExpectNone(input.words);
  return evaluateExpect(input.words, input.expect ?? []);
}

export { MIN_SIGNIFICANT_CHARS, MAX_REPORTED_ITEMS };
