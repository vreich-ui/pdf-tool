/**
 * T6 — the ONE Chromium-dependent golden in image.annotate's determinism suite, plus the
 * option (c) text-width investigation the T6 task asked for real numbers on.
 *
 * WHY THIS LIVES HERE, NOT IN tests/: BRIEF.md §3 finding 3 — byte-identical PNG output only
 * holds for a pinned render-service container (this exact Chromium build + its bundled Noto
 * fonts), and CI runs no tests at all in this repo, so a Chromium-dependent golden must (a)
 * live next to the render-service integration tests that already know how to probe for a
 * browser, and (b) SKIP LOUDLY (t.skip, never a silent pass) when none is found — exactly
 * like every other browser-dependent test in render-service/tests. A green run of the rest
 * of `npm run test:service` never depends on this file finding a browser.
 *
 * WHAT IS PINNED, AND WHY SHA256 ALONE IS THE WRONG GOLDEN TO LEAN ON:
 *   - `pngSha256` + `chromiumVersion` + `widthPx`/`heightPx`: a coarse whole-image
 *     fingerprint. It WILL break on the next Chromium point release, a font-hinting change,
 *     or a different host's subpixel AA — none of which are layout regressions. It is pinned
 *     anyway because "nothing at all changed" is still a cheap, useful signal between two
 *     runs of the SAME pinned container, and BRIEF.md explicitly asks for it. A mismatch here
 *     against a DIFFERENT chromiumVersion is reported as exactly that, not as a failure to
 *     chase.
 *   - `elementMeasurements`: per-element `getBoundingClientRect()`-derived boxes
 *     (`diagnostics.measurements`, the same `options.measure` mechanism render.ts's own
 *     MEASURED_BOX_DRIFT check reads). THIS is the golden that should stay green across a
 *     Chromium/font update that changes antialiasing but not layout — identical box sizes
 *     mean the thing this feature actually promises (predictable geometry) still holds, with
 *     no PNG bytes involved at all.
 *
 * THE BASE PHOTO IS DELIBERATELY NOT SUPPLIED. The shared document golden
 * (tests/fixtures/image-annotate/document/adversarial__busy.txt, produced by
 * tests/agent-artifact-image-annotate-goldens.test.ts) references the base image as a virtual
 * asset URL; reproducing the SAME synthetic base image bytes here would mean either
 * committing a binary fixture (house rule: no binary fixtures) or cross-package-importing
 * netlify's sharp-based generator into a render-service test (a coupling this test/service
 * split exists specifically to avoid — render-service's own package.json carries no `sharp`
 * dependency). An unresolved `<img>` is itself deterministic and already warned about
 * (`engineWarnings` includes "unresolved job asset"); this golden therefore pins the OVERLAY
 * layer (text/badge/box/scrim/arrow) only, which is the layer this feature's own layout logic
 * controls — the photo underneath is Chromium's `object-fit: cover` on whatever bytes a real
 * caller supplies, and is out of scope for a layout determinism golden either way.
 *
 * THE DOCUMENTED PER-PIXEL TOLERANCE PATH (not wired by default): this service deliberately
 * ships no image decoder (see image-render.test.ts's own note on that), and this feature adds
 * no new dependency, so there is no default pixel-level compare here. If `elementMeasurements`
 * ever isn't enough to catch a real visual regression (say, a color/gradient/arrow rendering
 * bug that happens to leave every box's SIZE unchanged), the recipe is: decode both PNGs (via
 * `sharp` — already a ROOT dependency of this repo, reachable from render-service through
 * Node's ordinary node_modules parent-directory resolution; deliberately not added to
 * render-service/package.json, since this is a one-off local A/B tool, never part of the
 * default gated run) into raw RGB buffers of equal dimensions, then assert per pixel that
 * `Math.abs(a[i] - b[i]) <= 2` (out of 255) holds for at least 99.5% of pixels — loose enough
 * to absorb antialiasing/font-hinting drift, tight enough to catch a real color or position
 * change. That recipe is documented rather than implemented because it needs a second,
 * DELIBERATELY committed reference PNG to diff against, which is a real decision for whoever
 * next re-pins this golden, not a default this file should make silently.
 *
 * REGENERATING: `npm run goldens:image-annotate:png:update` (also documented in BRIEF.md §5).
 * Requires the same CHROMIUM_EXECUTABLE_PATH fallback every other render-service integration
 * test in this directory uses.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";

// Same fallback as every other render-service integration test (chromium-integration.test.ts,
// image-render.test.ts, ...): a browser is expected at PLAYWRIGHT_BROWSERS_PATH, but the
// installed `playwright` package may not auto-discover it there.
if (!process.env.CHROMIUM_EXECUTABLE_PATH) {
  process.env.CHROMIUM_EXECUTABLE_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
}

let CHROMIUM_AVAILABLE = false;
let CHROMIUM_VERSION = "unknown";

before(async () => {
  const probe = await chromiumAvailable();
  CHROMIUM_AVAILABLE = probe.available;
  CHROMIUM_VERSION = probe.version ?? "unknown";
});

after(async () => {
  await closeChromiumForTests();
});

const SECRET = "image-annotate-png-golden-secret";
const HERE = dirname(fileURLToPath(import.meta.url));
/** The image-annotate fixture tree is SHARED with the pure-function goldens in
 * tests/agent-artifact-image-annotate-goldens.test.ts — one canonical fixtures/ directory,
 * read here by plain relative path (no cross-package TS import). */
const FIXTURE_ROOT = path.join(HERE, "..", "..", "tests", "fixtures", "image-annotate");
const UPDATE = process.env.UPDATE_IMAGE_ANNOTATE_PNG_GOLDEN === "1";

async function withServer<T>(fn: (server: FastifyInstance) => Promise<T>): Promise<T> {
  process.env.RENDER_SERVICE_SECRET = SECRET;
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function renderImage(server: FastifyInstance, payload: Record<string, unknown>) {
  const response = await server.inject({ method: "POST", url: "/render/image", headers: { "x-render-secret": SECRET }, payload });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

/** Parses the `=== html ===` / `=== css ===` text golden buildAnnotationDocument's own test
 * file writes (see assertDocumentGolden there) back into a `{html, css}` template. */
function readDocumentGolden(relPath: string): { html: string; css: string } {
  const raw = readFileSync(path.join(FIXTURE_ROOT, relPath), "utf8");
  const htmlMarker = "=== html ===\n";
  const cssMarker = "\n\n=== css ===\n";
  const htmlStart = raw.indexOf(htmlMarker) + htmlMarker.length;
  const cssIndex = raw.indexOf(cssMarker);
  if (htmlStart < htmlMarker.length || cssIndex < 0) {
    throw new Error(`${relPath} does not look like a document golden (missing === html === / === css === markers)`);
  }
  const html = raw.slice(htmlStart, cssIndex);
  const css = raw.slice(cssIndex + cssMarker.length).replace(/\n$/, "");
  return { html, css };
}

/** Every class selector the document actually defines, in the order CSS rules appear —
 * measuring them ALL is what makes elementMeasurements a full-coverage golden rather than a
 * hand-picked subset that could silently stop covering a new element type. */
function selectorsFromCss(css: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of css.matchAll(/\.([A-Za-z0-9_-]+)\s*\{/g)) {
    const selector = `.${match[1]}`;
    if (seen.has(selector)) continue;
    seen.add(selector);
    found.push(selector);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. the primary golden — overlay layer only, real Chromium
// ---------------------------------------------------------------------------

test("image.annotate PNG golden: the adversarial fixture's overlay layer, rendered by real Chromium", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH) — this golden is SKIPPED, not passed");
    return;
  }
  const { html, css } = readDocumentGolden(path.join("document", "adversarial__busy.txt"));
  const selectors = selectorsFromCss(css);
  assert.ok(selectors.length > 0, "the adversarial document golden must define at least one measurable element");

  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: { html, css },
      canvas: { w: 640, h: 480 },
      options: { measure: selectors },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));

    const png = Buffer.from(String(body.pngBase64), "base64");
    const diagnostics = body.diagnostics as {
      widthPx: number;
      heightPx: number;
      measurements?: Array<Record<string, unknown>>;
      engineWarnings?: string[];
    };

    // The base photo asset is deliberately not supplied (see this file's header) — exactly
    // one, always-the-same engineWarning is therefore expected, never a surprise.
    assert.ok(
      (diagnostics.engineWarnings ?? []).some((warning) => warning.includes("unresolved job asset")),
      `expected an unresolved-asset warning for the deliberately-omitted base image, got ${JSON.stringify(diagnostics.engineWarnings)}`
    );

    const golden = {
      chromiumVersion: CHROMIUM_VERSION,
      widthPx: diagnostics.widthPx,
      heightPx: diagnostics.heightPx,
      pngSha256: createHash("sha256").update(png).digest("hex"),
      elementMeasurements: diagnostics.measurements,
    };

    const file = path.join(FIXTURE_ROOT, "png-golden.json");
    if (UPDATE) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
      return;
    }
    if (!existsSync(file)) {
      assert.fail(`missing golden tests/fixtures/image-annotate/png-golden.json — generate it with: npm run goldens:image-annotate:png:update`);
    }
    const expected = JSON.parse(readFileSync(file, "utf8")) as typeof golden;

    if (expected.chromiumVersion !== CHROMIUM_VERSION) {
      assert.fail(
        `png-golden.json was pinned against Chromium "${expected.chromiumVersion}", this run used "${CHROMIUM_VERSION}". ` +
          `Per BRIEF.md §3 finding 3, byte-identical output holds only for a pinned container — this is an environment ` +
          `mismatch, not necessarily a regression. Regenerate with: npm run goldens:image-annotate:png:update`
      );
    }
    // The robust half: real per-element geometry. Any change here is a real layout change.
    assert.deepEqual(golden.elementMeasurements, expected.elementMeasurements, "rendered element geometry drifted from the pinned golden — a real layout change");
    // The blunt half: whole-image bytes, only meaningful pinned against the SAME chromiumVersion.
    assert.equal(golden.pngSha256, expected.pngSha256, "rendered PNG bytes drifted from the pinned golden on the SAME Chromium version — see this file's header for the per-pixel-tolerance escape hatch");
  });
});

// ---------------------------------------------------------------------------
// 2. option (c) investigation — real numbers, on the adversarial fixture
// ---------------------------------------------------------------------------

/**
 * T3's render.ts sets a text block's CSS `width` to the RESOLVER'S OWN predicted `box.w` —
 * the same shrink-wrapped number the anchor math and collision push-out used (see render.ts's
 * module doc, "TEXT FITTING"). Its documented failure mode: an UNDER-measured string (the
 * offline heuristic guessed narrower than the real glyphs) is forced to wrap inside a box
 * that is already too narrow, adding one whole extra line rather than spilling gracefully.
 *
 * Option (c): set the CSS `width` to `el.maxWidth * canvas.w` — the full width budget the
 * spec author actually allowed — instead of the tighter predicted `box.w`. An under-measured
 * string then has real slack before it is forced to wrap.
 *
 * This measures BOTH variants, on THIS repo's adversarial golden fixture (the ALL-CAPS label
 * and the long wrapping paragraph — the two elements most likely to trip the heuristic), via
 * the actual bundled Chromium build, and logs the numbers. It asserts nothing about which
 * variant is "better" — see this repo's T6 report for the decision and why.
 */
test("option (c) investigation: CSS width = predicted box.w (current) vs maxWidth*canvas.w (alternative)", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }

  const resolveGoldenPath = path.join(FIXTURE_ROOT, "resolve", "adversarial__busy.json");
  if (!existsSync(resolveGoldenPath)) {
    assert.fail(`missing resolve golden ${resolveGoldenPath} — run: npm run goldens:image-annotate:update first`);
  }
  const report = JSON.parse(readFileSync(resolveGoldenPath, "utf8")) as {
    placements: Array<{ id: string; box: { x: number; y: number; w: number; h: number }; fontSizePx: number; weight: string; lines: string[]; align: string; color: string; type: string }>;
  };
  const canvasW = 640;

  // maxWidth fractions as authored in specAdversarial (tests/agent-artifact-image-annotate-
  // goldens.test.ts). TextPlacement carries no maxWidth field (only the resolved box), so
  // these two numbers are pinned here by hand, matched to that spec — see this file's header.
  const CASES: Array<{ id: string; maxWidth: number; note: string }> = [
    { id: "shout", maxWidth: 0.3, note: "ALL-CAPS — render.ts's own documented worst case" },
    { id: "para", maxWidth: 0.35, note: "long wrapping paragraph" },
  ];

  const results: Array<Record<string, unknown>> = [];

  await withServer(async (server) => {
    const measureVariant = async (widthPx: number, placement: (typeof report.placements)[number]) => {
      const doc = {
        html: `<div class="ann-x">${placement.lines.map((line) => `<div class="ann-line">${line}</div>`).join("")}</div>`,
        css: [
          `.ann-x {`,
          `  position: absolute; left: 0; top: 0;`,
          `  width: ${widthPx.toFixed(2)}px;`,
          `  margin: 0;`,
          `  font-family: sans-serif;`,
          `  font-size: ${placement.fontSizePx.toFixed(2)}px;`,
          `  font-weight: ${placement.weight === "bold" ? 700 : 400};`,
          `  line-height: 1.25;`,
          `  color: ${placement.color};`,
          `  text-align: ${placement.align};`,
          `  white-space: pre-wrap;`,
          `  overflow-wrap: break-word;`,
          `  overflow: visible;`,
          `}`,
        ].join("\n"),
      };
      const { status, body } = await renderImage(server, {
        template: doc,
        canvas: { w: canvasW, h: 480 },
        options: { measure: [".ann-x"] },
      });
      assert.equal(status, 200, JSON.stringify(body));
      const measurements = (body.diagnostics as { measurements?: Array<{ w: number; h: number; found: boolean }> }).measurements ?? [];
      const measurement = measurements[0];
      assert.ok(measurement?.found, `.ann-x must be found in the rendered document (width=${widthPx})`);
      return measurement;
    };

    for (const { id, maxWidth, note } of CASES) {
      const placement = report.placements.find((p) => p.id === id && p.type === "text");
      assert.ok(placement, `resolve golden must contain a text placement "${id}"`);
      if (!placement) continue;

      const alternativeWidthPx = maxWidth * canvasW;
      const measuredA = await measureVariant(placement.box.w, placement); // current
      const measuredC = await measureVariant(alternativeWidthPx, placement); // option (c)

      const lineHeightPx = placement.fontSizePx * 1.25;
      const extraLines = (measuredH: number) => Math.round((measuredH - placement.box.h) / lineHeightPx);

      results.push({
        id,
        note,
        predicted: { boxW: placement.box.w, boxH: placement.box.h, lines: placement.lines.length },
        variantA_currentWidth: { widthPx: placement.box.w, measuredW: measuredA.w, measuredH: measuredA.h, extraLinesVsPredicted: extraLines(measuredA.h) },
        variantC_maxWidth: { widthPx: alternativeWidthPx, measuredW: measuredC.w, measuredH: measuredC.h, extraLinesVsPredicted: extraLines(measuredC.h) },
        deltaExtraLines: extraLines(measuredA.h) - extraLines(measuredC.h),
      });
    }
  });

  // Deliberate, permanent console.log — not debug noise. The whole point of this test is to
  // put real, current-Chromium numbers where a human reading T6's report can check them; see
  // BRIEF.md's T6 report for the resulting decision.
  console.log(`[option (c) investigation]\n${JSON.stringify(results, null, 2)}`);

  for (const result of results as Array<{ id: string; variantA_currentWidth: { measuredH: number }; variantC_maxWidth: { measuredH: number } }>) {
    assert.ok(Number.isFinite(result.variantA_currentWidth.measuredH), `${result.id}: variant A must have a real measured height`);
    assert.ok(Number.isFinite(result.variantC_maxWidth.measuredH), `${result.id}: variant C must have a real measured height`);
  }
});
