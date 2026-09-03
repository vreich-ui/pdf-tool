/**
 * T1.6: chromium templates carry raw CSS `font-family` values. render-service only ever
 * bundles Noto faces (see render-service/fonts/), so a named brand/system font (Georgia,
 * 'Inter Variable', Helvetica Neue) resolved to whatever generic fallback Chromium had in the
 * container — observed as LiberationSerif in the drlurie moisturizer brochure. These are pure
 * unit tests against the normalization/mapping functions themselves (no browser needed): they
 * always run, never skip.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledFallbackFamily,
  classifyFontFamily,
  classifyFontFamilyStack,
  isCssWideKeyword,
  normalizeFontFamilyStack,
} from "../src/fonts.js";
import { resolveFontFamilyForRequest, rewriteFontFamilyCss } from "../src/engines/chromium.js";
import type { NormalizedFont } from "../src/contract.js";

// --- normalizeFontFamilyStack -----------------------------------------------------------

test("normalizeFontFamilyStack: strips quotes, takes first family, trims whitespace", () => {
  assert.equal(normalizeFontFamilyStack("'Inter Variable', system-ui, sans-serif"), "Inter Variable");
  assert.equal(normalizeFontFamilyStack("Georgia,'Times New Roman',serif"), "Georgia");
  assert.equal(normalizeFontFamilyStack('"Helvetica Neue", Arial, sans-serif'), "Helvetica Neue");
  assert.equal(normalizeFontFamilyStack("  Arial  "), "Arial");
  assert.equal(normalizeFontFamilyStack("sans-serif"), "sans-serif");
});

// --- classifyFontFamily / bundledFallbackFamily -----------------------------------------

test("classifyFontFamily + bundledFallbackFamily: named sans/serif families map onto the bundled Noto faces", () => {
  assert.equal(bundledFallbackFamily(classifyFontFamily("Inter Variable")), "NotoSans");
  assert.equal(bundledFallbackFamily(classifyFontFamily("Helvetica Neue")), "NotoSans");
  assert.equal(bundledFallbackFamily(classifyFontFamily("Arial")), "NotoSans");
  assert.equal(bundledFallbackFamily(classifyFontFamily("system-ui")), "NotoSans");
  assert.equal(bundledFallbackFamily(classifyFontFamily("Georgia")), "NotoSerif");
  assert.equal(bundledFallbackFamily(classifyFontFamily("Times New Roman")), "NotoSerif");
  assert.equal(bundledFallbackFamily(classifyFontFamily("serif")), "NotoSerif");
});

test("classifyFontFamily + bundledFallbackFamily: an unknown family falls back to the sans face without error", () => {
  assert.equal(classifyFontFamily("Comic Sans MS"), undefined);
  assert.doesNotThrow(() => bundledFallbackFamily(classifyFontFamily("Comic Sans MS")));
  assert.equal(bundledFallbackFamily(classifyFontFamily("Comic Sans MS")), "NotoSans");
});

test("classifyFontFamily + bundledFallbackFamily: monospace has no bundled face and folds into sans", () => {
  assert.equal(classifyFontFamily("monospace"), "mono");
  assert.equal(bundledFallbackFamily(classifyFontFamily("monospace")), "NotoSans");
  assert.equal(bundledFallbackFamily(classifyFontFamily("Courier New")), "NotoSans");
});

// --- resolveFontFamilyForRequest (bundled-vs-uploaded resolution) ----------------------

const noRequestFonts: NormalizedFont[] = [];

test("resolveFontFamilyForRequest: 'Inter Variable', system-ui, sans-serif normalizes to the bundled sans face", () => {
  assert.equal(resolveFontFamilyForRequest("'Inter Variable', system-ui, sans-serif", noRequestFonts), "NotoSans");
});

test("resolveFontFamilyForRequest: Georgia,'Times New Roman',serif normalizes to the bundled serif face", () => {
  assert.equal(resolveFontFamilyForRequest("Georgia,'Times New Roman',serif", noRequestFonts), "NotoSerif");
});

test("resolveFontFamilyForRequest: 'Helvetica Neue',Arial,sans-serif (the fixture template's kicker/brand font) normalizes to the bundled sans face", () => {
  assert.equal(resolveFontFamilyForRequest("'Helvetica Neue',Arial,sans-serif", noRequestFonts), "NotoSans");
});

test("resolveFontFamilyForRequest: an uploaded request font matching the template family wins over the bundled fallback", () => {
  const requestFonts: NormalizedFont[] = [{ family: "Inter Variable", weight: "normal", bytes: Buffer.from([]) }];
  assert.equal(resolveFontFamilyForRequest("'Inter Variable', system-ui, sans-serif", requestFonts), "Inter Variable");
});

test("resolveFontFamilyForRequest: matching against an uploaded font is case-insensitive", () => {
  const requestFonts: NormalizedFont[] = [{ family: "inter variable", weight: "normal", bytes: Buffer.from([]) }];
  assert.equal(resolveFontFamilyForRequest("'Inter Variable', system-ui, sans-serif", requestFonts), "inter variable");
});

test("resolveFontFamilyForRequest: an unknown family with no uploaded match and no role mapping falls back without error", () => {
  assert.doesNotThrow(() => resolveFontFamilyForRequest("Papyrus", noRequestFonts));
  assert.equal(resolveFontFamilyForRequest("Papyrus", noRequestFonts), "NotoSans");
});

// --- rewriteFontFamilyCss (the actual CSS surface Chromium receives) -------------------

test("rewriteFontFamilyCss: rewrites a raw stack to a single, plain, quoted resolved family", () => {
  const css = "body{font-family:Georgia,'Times New Roman',serif;color:#2e2a26}";
  const out = rewriteFontFamilyCss(css, (raw) => resolveFontFamilyForRequest(raw, noRequestFonts));
  assert.match(out, /font-family:\s*"NotoSerif"/);
  assert.doesNotMatch(out, /Georgia/);
  assert.doesNotMatch(out, /Times New Roman/);
});

test("rewriteFontFamilyCss: an already-quoted family is not double-quoted in the emitted CSS", () => {
  const css = ".kicker{font-family:'Helvetica Neue',Arial,sans-serif}";
  const out = rewriteFontFamilyCss(css, (raw) => resolveFontFamilyForRequest(raw, noRequestFonts));
  assert.match(out, /font-family:\s*"NotoSans"/);
  // No doubled quoting like `""NotoSans""` or a literal re-quoted `'Helvetica Neue'` surviving.
  assert.doesNotMatch(out, /""/);
  assert.doesNotMatch(out, /'/);
});

test("rewriteFontFamilyCss: leaves an @font-face block's own font-family (a face NAME, not a reference) untouched", () => {
  const css = '@font-face{font-family:"Custom Brand Face";src:url("https://render.assets.invalid/__fonts/req-0.ttf")} body{font-family:"Custom Brand Face",sans-serif}';
  const requestFonts: NormalizedFont[] = [{ family: "Custom Brand Face", weight: "normal", bytes: Buffer.from([]) }];
  const out = rewriteFontFamilyCss(css, (raw) => resolveFontFamilyForRequest(raw, requestFonts));
  assert.match(out, /@font-face\{font-family:"Custom Brand Face";/);
  assert.match(out, /body\{font-family:\s*"Custom Brand Face"\}/);
});

test("rewriteFontFamilyCss: the full fixture body/kicker declarations both resolve, none left as raw brand names", () => {
  const css =
    "body{font-family:Georgia,'Times New Roman',serif} .kicker{font-family:'Helvetica Neue',Arial,sans-serif}";
  const out = rewriteFontFamilyCss(css, (raw) => resolveFontFamilyForRequest(raw, noRequestFonts));
  assert.match(out, /body\{font-family:\s*"NotoSerif"\}/);
  assert.match(out, /\.kicker\{font-family:\s*"NotoSans"\}/);
});

// --- W3 -----------------------------------------------------------------------------------
//
// Two ways the T1.6 rewrite itself produced a wrong font — the symptom it was written to fix.

test("W3: a brand stack's generic INTENT is read from the whole stack, not just its head", () => {
  // A brand stack names its custom face first and its generic role last; that is what a stack
  // is for. Classifying only the head sent every unrecognized brand name to the sans fallback,
  // so serif body copy rendered in NotoSans.
  assert.equal(classifyFontFamilyStack('"Canela Deck", Georgia, serif'), "serif");
  assert.equal(classifyFontFamilyStack("BrandGrotesk, Helvetica, sans-serif"), "sans");
  assert.equal(resolveFontFamilyForRequest('"Canela Deck", Georgia, serif', noRequestFonts), "NotoSerif");
  assert.equal(resolveFontFamilyForRequest("SomeBrandFace, ui-serif, serif", noRequestFonts), "NotoSerif");
  // A recognized head still wins, so nothing that already resolved resolves differently.
  assert.equal(resolveFontFamilyForRequest("Georgia, Arial, sans-serif", noRequestFonts), "NotoSerif");
  // A stack with no recognizable entry anywhere still falls back, never throws.
  assert.equal(classifyFontFamilyStack("Papyrus, Zapfino"), undefined);
  assert.equal(resolveFontFamilyForRequest("Papyrus, Zapfino", noRequestFonts), "NotoSans");
});

test("W3: CSS-wide keywords are not family names and are left exactly as written", () => {
  for (const keyword of ["inherit", "initial", "unset", "revert"]) {
    assert.equal(isCssWideKeyword(keyword), true);
    const css = `.body-copy{font-family:${keyword}}`;
    assert.equal(rewriteFontFamilyCss(css, (raw) => resolveFontFamilyForRequest(raw, noRequestFonts)), css);
  }
  assert.equal(isCssWideKeyword("Inherit"), true, "CSS keywords are case-insensitive");
  assert.equal(isCssWideKeyword("Georgia"), false);

  // A real family in the same stylesheet is still rewritten — the guard is narrow.
  const mixed = "h1{font-family:Georgia,serif} h1 small{font-family:inherit}";
  const out = rewriteFontFamilyCss(mixed, (raw) => resolveFontFamilyForRequest(raw, noRequestFonts));
  assert.match(out, /h1\{font-family:\s*"NotoSerif"\}/);
  assert.match(out, /h1 small\{font-family:inherit\}/);
});
