// T15.22 — @font-face declarations and known-provider stylesheet links captured into
// snapshot.v1's `fonts[]`.
//
// Same rationale as capture-embeds.test.ts: EXTRACT_PAGE_MODEL_SCRIPT only ever runs
// inside page.evaluate(), so the only honest test is against a REAL DOM/CSSOM — a
// hand-built fake CSSStyleSheet would lie about exactly the browser behavior (cross-origin
// cssRules access, url()/format() serialization) this code depends on.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser } from "playwright";

import { EXTRACT_PAGE_MODEL_SCRIPT } from "../src/capture.js";

const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

type FontSource = {
  type: "url" | "local";
  rawUrl: string | null;
  url: string | null;
  format: string | null;
  tech: string | null;
  localName: string | null;
};

type FontEntry = {
  ordinal: number;
  kind: "face" | "provider-link";
  capturable: boolean;
  notCapturableReason: string | null;
  // face
  family?: string | null;
  weight?: { raw: string; min: number | null; max: number | null };
  style?: { raw: string; kind: string };
  unicodeRange?: string | null;
  stylesheetHref?: string | null;
  provider?: string | null;
  sources?: FontSource[];
  // provider-link
  href?: string | null;
  families?: string[];
};

// Self-hosted src() URLs are written absolute (not site-relative) because page.setContent()
// never navigates the page — document.baseURI stays "about:blank", against which the
// WHATWG URL parser cannot resolve a relative path at all (this would throw in production
// too if it ever happened, but a real capture always navigates a real URL first via
// page.goto(), so this is a fixture-only accommodation, not a production behavior gap).
const FONT_FACE_PAGE = `<!doctype html><html><head>
  <style>
    /* Declared out of alphabetical/weight order on purpose — proves the final array is
       explicitly sorted, not left in source/declaration order. */
    @font-face {
      font-family: "Body Sans";
      font-weight: 700;
      font-style: normal;
      src: url("https://site.example.com/fonts/body-sans-700.woff") format("woff"),
           url("https://site.example.com/fonts/body-sans-700.woff2") format("woff2");
    }
    @font-face {
      font-family: "Body Sans";
      font-weight: 400;
      font-style: normal;
      src: url("https://site.example.com/fonts/body-sans-400.woff2") format("woff2");
    }
    @font-face {
      font-family: "Local Only Serif";
      src: local("Georgia"), local("Times New Roman");
    }
    @font-face {
      font-family: "No Src Declared";
    }
    @media (min-width: 1px) {
      @font-face {
        font-family: "Variable Display";
        font-weight: 100 900;
        font-style: oblique 0deg 10deg;
        unicode-range: U+0-24F;
        src: url("https://cdn.example.com/fonts/variable-display.woff2") format("woff2-variations");
      }
    }
  </style>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&amp;family=Source+Serif+4&amp;display=swap">
</head><body><main><section style="min-height:80px">Hello</section></main></body></html>`;

async function extractFonts(html: string, launch: (browser: Browser) => Promise<void> = async () => {}): Promise<FontEntry[]> {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
  try {
    await launch(browser);
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("https://fonts.googleapis.com/")) {
        await route.fulfill({
          status: 200,
          contentType: "text/css",
          // Content is irrelevant — a plain cross-origin <link> load is opaque to CSSOM
          // regardless of what the response says, so this never gets read back as rules.
          body: "@font-face{font-family:'Playfair Display';src:url(https://fonts.gstatic.com/x.woff2) format('woff2');}",
        });
        return;
      }
      await route.abort();
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // Let the stylesheet link resolve (fulfilled response) before reading document.styleSheets.
    await page.waitForTimeout(50);
    const model = (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as { fonts: FontEntry[] };
    return model.fonts;
  } finally {
    await browser.close();
  }
}

const byFamily = (fonts: FontEntry[], family: string) => fonts.find((f) => f.family === family);

test("readable @font-face rules (inline <style>, including inside @media) are captured with family/weight/style/sources", async () => {
  const fonts = await extractFonts(FONT_FACE_PAGE);

  const bodySans700 = fonts.find((f) => f.family === "Body Sans" && f.weight?.raw === "700");
  assert.ok(bodySans700, "700-weight Body Sans face is present");
  assert.equal(bodySans700!.kind, "face");
  assert.equal(bodySans700!.weight!.min, 700);
  assert.equal(bodySans700!.weight!.max, 700);
  assert.equal(bodySans700!.style!.kind, "normal");
  assert.equal(bodySans700!.capturable, true);
  assert.equal(bodySans700!.notCapturableReason, null);
  assert.equal(bodySans700!.provider, null, "self-hosted relative-path font has no provider");
  assert.equal(bodySans700!.sources!.length, 2);
  // sources sorted by (format, url) — "woff" before "woff2"
  assert.equal(bodySans700!.sources![0].format, "woff");
  assert.equal(bodySans700!.sources![1].format, "woff2");
  assert.ok(bodySans700!.sources![0].url!.endsWith("/fonts/body-sans-700.woff"));

  const variable = byFamily(fonts, "Variable Display")!;
  assert.ok(variable, "@font-face nested inside @media is still found");
  assert.equal(variable.weight!.raw, "100 900");
  assert.equal(variable.weight!.min, 100);
  assert.equal(variable.weight!.max, 900);
  assert.equal(variable.style!.kind, "oblique");
  assert.equal(variable.unicodeRange, "U+0-24F");
  assert.equal(variable.sources![0].url, "https://cdn.example.com/fonts/variable-display.woff2");
});

test("fonts[] is deterministically sorted (family, then weight), not left in declaration order", async () => {
  const fonts = await extractFonts(FONT_FACE_PAGE);
  const bodySansEntries = fonts.filter((f) => f.family === "Body Sans");
  assert.equal(bodySansEntries.length, 2);
  // Declared 700 first, then 400 in source — sorted output must have 400 first.
  assert.equal(bodySansEntries[0].weight!.min, 400);
  assert.equal(bodySansEntries[1].weight!.min, 700);
  // ordinal reflects the sorted position, and is contiguous from 0.
  const ordinals = fonts.map((f) => f.ordinal);
  assert.deepEqual(ordinals, fonts.map((_, i) => i));
});

test("a font that cannot be captured is represented explicitly, never dropped", async () => {
  const fonts = await extractFonts(FONT_FACE_PAGE);

  const localOnly = byFamily(fonts, "Local Only Serif")!;
  assert.ok(localOnly, "local()-only face is still represented");
  assert.equal(localOnly.capturable, false);
  assert.equal(localOnly.notCapturableReason, "local-only");
  assert.equal(
    localOnly.sources!.every((s) => s.type === "local"),
    true
  );

  const noSrc = byFamily(fonts, "No Src Declared")!;
  assert.ok(noSrc, "face with no src descriptor at all is still represented");
  assert.equal(noSrc.capturable, false);
  assert.equal(noSrc.notCapturableReason, "no-src-declared");
  assert.deepEqual(noSrc.sources, []);
});

test("a known-provider stylesheet link the CSSOM refuses to expose is represented as a provider-link, families parsed from the URL", async () => {
  const fonts = await extractFonts(FONT_FACE_PAGE);
  const providerLinks = fonts.filter((f) => f.kind === "provider-link");
  assert.equal(providerLinks.length, 1, "exactly one provider-link for the googleapis <link>");

  const link = providerLinks[0];
  assert.equal(link.provider, "google-fonts");
  assert.equal(link.capturable, true);
  assert.equal(link.notCapturableReason, null);
  assert.ok(link.href!.startsWith("https://fonts.googleapis.com/css2?"));
  assert.deepEqual(link.families, ["Playfair Display", "Source Serif 4"], "families parsed + sorted from the family= query params");
});

test("a cross-origin stylesheet that is NOT a known font provider is not represented as a font (nothing honest to name)", async () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="https://cdn.example.com/vendor/unrelated.css">
  </head><body><main><section style="min-height:80px">Hi</section></main></body></html>`;
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://cdn.example.com/vendor/unrelated.css") {
        await route.fulfill({ status: 200, contentType: "text/css", body: "body{color:red}" });
        return;
      }
      await route.abort();
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(50);
    const model = (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as { fonts: FontEntry[] };
    assert.equal(model.fonts.length, 0);
  } finally {
    await browser.close();
  }
});

test("font extraction is bounded (FONT_MAX) so one page cannot inflate the snapshot", async () => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    const rules = Array.from(
      { length: 80 },
      (_, i) => `@font-face{font-family:"Face ${i}";src:url("/fonts/f${i}.woff2") format("woff2");}`
    ).join("\n");
    await page.setContent(
      `<!doctype html><html><head><style>${rules}</style></head><body><main><section style="min-height:80px">Hi</section></main></body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    const model = (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as { fonts: FontEntry[] };
    assert.equal(model.fonts.length, 60, "capped at FONT_MAX even though 80 @font-face rules are on the page");
  } finally {
    await browser.close();
  }
});
