/**
 * `--ignore-system-fonts` is deliberate: a render must not silently pick up whatever the
 * container happens to have. The consequence is that a typst template naming any other family
 * got typst's bare `unknown font family: liberation sans` — which says what is missing and
 * never what is available, so it reads as a broken renderer rather than a template asking for
 * a face this sandbox does not carry. Observed live on site_platform, 2026-09-07.
 *
 * chromium templates never hit this: their font-family declarations are normalized down to a
 * bundled face before the page loads. typst source cannot be rewritten that way, so the honest
 * fix is to tell the author what they could have used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundledFontFamilies, resetBundledFontFamiliesCache } from "../src/fonts.js";
import { parseWarnings } from "../src/engines/typst.js";

test("the bundled family list is read from what is actually shipped, not hard-coded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "typst-fonts-"));
  try {
    await writeFile(path.join(dir, "NotoSans-Regular.ttf"), "x");
    await writeFile(path.join(dir, "NotoSans-Bold.ttf"), "x");
    await writeFile(path.join(dir, "NotoSansHebrew-Regular.ttf"), "x");
    await writeFile(path.join(dir, "PlainFace.otf"), "x");
    await writeFile(path.join(dir, "OFL.txt"), "licence, not a font");

    process.env.RENDER_SERVICE_FONT_DIR = dir;
    resetBundledFontFamiliesCache();

    // Weight suffixes collapse to one family; a face with no suffix keeps its stem; the
    // licence file is not a font.
    assert.deepEqual(bundledFontFamilies(), ["NotoSans", "NotoSansHebrew", "PlainFace"]);
  } finally {
    delete process.env.RENDER_SERVICE_FONT_DIR;
    resetBundledFontFamiliesCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable font directory degrades to an empty list, never a failed render", async () => {
  process.env.RENDER_SERVICE_FONT_DIR = path.join(tmpdir(), "definitely-not-a-real-font-dir-9f3a1c");
  resetBundledFontFamiliesCache();
  try {
    assert.deepEqual(bundledFontFamilies(), []);
  } finally {
    delete process.env.RENDER_SERVICE_FONT_DIR;
    resetBundledFontFamiliesCache();
  }
});

test("the repo's own bundled fonts are discovered", () => {
  resetBundledFontFamiliesCache();
  const families = bundledFontFamilies();
  for (const expected of ["NotoSans", "NotoSansHebrew", "NotoSerif"]) {
    assert.ok(families.includes(expected), `expected ${expected} in ${JSON.stringify(families)}`);
  }
});

test("an unknown-font warning is rewritten to name what WAS available", () => {
  const stderr = [
    'warning: unknown font family: liberation sans',
    'warning: something else entirely',
  ].join("\n");

  const [fontWarning, otherWarning] = parseWarnings(stderr, ["NotoSans", "NotoSerif"]);

  // typst's own text is kept verbatim — it names the family the template asked for.
  assert.match(String(fontWarning), /unknown font family: liberation sans/);
  // ...and is then made actionable.
  assert.match(String(fontWarning), /Available families: NotoSans, NotoSerif/);
  assert.match(String(fontWarning), /System fonts are deliberately ignored/);

  // Every other warning passes through untouched.
  assert.equal(otherWarning, "warning: something else entirely");
});

test("with nothing to offer, the warning is left exactly as typst wrote it", () => {
  // An unreadable font dir must not turn one bad warning into a misleading one.
  assert.deepEqual(parseWarnings("warning: unknown font family: liberation sans", []), [
    "warning: unknown font family: liberation sans",
  ]);
});

test("non-warning stderr noise is still dropped", () => {
  assert.deepEqual(parseWarnings("some progress chatter\nwarning: real one", ["NotoSans"]), ["warning: real one"]);
});
