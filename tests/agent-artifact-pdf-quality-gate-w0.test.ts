/**
 * W0 acceptance anchor for the PDF pipeline fortification wave (plan §0, 2026-09-03).
 *
 * Part A is a CHARACTERIZATION test: it reproduces, from committed fixtures, exactly what
 * the drlurie moisturizer job did on 2026-09-03 — `[object Object]` twice, four blank
 * content pages, three image slots the render service cannot resolve. It renders the real
 * template through the same LiquidJS configuration the chromium engine uses in
 * `mode:"final"` today (strictVariables:false), so it is green on the pre-wave tree and
 * documents the defect precisely.
 *
 * Part B is RED until W1 lands. It asserts the two gates the wave introduces:
 *   T1.2 — final-mode renders run with strictVariables on, so a missing slot is a
 *          DATA_BINDING_ERROR instead of silently empty output.
 *   T1.4 — `evaluateQualityGate` in netlify/lib/pdf-render/quality-gate.ts reports the
 *          three defect classes as findings (warn mode: passed:false, job still completes).
 *
 * Do not delete Part A when Part B goes green. Part A is the regression proof that the
 * fixture still expresses the original defect.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Liquid } from "liquidjs";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "pdf");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as T;
}

interface TemplateFixture {
  templateId: string;
  renderer: string;
  templateJson: { html: string; css: string };
  thumbnailKey: string | null;
  renderDataSchema?: unknown;
  sampleData?: unknown;
}

interface JobFixture {
  expectedDefects: { objectObjectTokens: number; blankContentPages: number[]; unresolvedImages: string[] };
  job: { data: Record<string, unknown>; templateId: string; renderer: string };
}

const template = loadFixture<TemplateFixture>("moisturizer-brochure-template.json");
const fixture = loadFixture<JobFixture>("moisturizer-bad-job.json");

/** Mirrors buildLiquidEngine() in render-service/src/engines/chromium.ts. */
function buildEngine(strictVariables: boolean): Liquid {
  return new Liquid({
    outputEscape: "escape",
    strictVariables,
    strictFilters: true,
    relativeReference: false,
    ownPropertyOnly: true,
    templates: {},
    globals: fixture.job.data,
    parseLimit: 16_000_000,
    renderLimit: 10_000,
    memoryLimit: 20_000_000,
  });
}

/** Split the rendered brochure into its five `.page` blocks and strip tags, as text extraction would. */
function pageTexts(html: string): { index: number; text: string }[] {
  return html
    .split(/(?=<div class="page">)/)
    .filter((chunk) => chunk.includes('class="page"'))
    .map((chunk, i) => ({
      index: i + 1,
      text: chunk
        .replace(/<[^>]*>/g, " ")
        .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    }));
}


/**
 * Loaded through a non-literal specifier on purpose: the module does not exist before T1.4,
 * and a static import would fail `tsc -p tsconfig.test.json` for the WHOLE suite, blocking
 * every other task in the wave. This way only these two tests go red.
 */
const QUALITY_GATE_MODULE = "../netlify/lib/pdf-render/quality-gate.js";

interface QualityGateModule {
  evaluateQualityGate: (input: {
    pages: { index: number; text: string }[];
    engineWarnings?: string[];
    coverPageIndex?: number;
    minTextChars?: number;
  }) => { passed: boolean; findings: { code: string; page?: number; detail: string }[] };
}

async function loadQualityGate(): Promise<QualityGateModule> {
  const specifier: string = QUALITY_GATE_MODULE;
  try {
    return (await import(specifier)) as QualityGateModule;
  } catch (error) {
    assert.fail(
      `T1.4 not landed yet: ${QUALITY_GATE_MODULE} must export evaluateQualityGate() — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Part A — characterization of the 2026-09-03 failure (green before and after W1)
// ---------------------------------------------------------------------------

test("W0/A: the fixture template has no render-data contract at all", () => {
  assert.equal(template.renderer, "chromium");
  assert.equal(template.renderDataSchema, undefined, "template must have no renderDataSchema — that is the defect");
  assert.equal(template.sampleData, undefined, "template must have no sampleData — that is the defect");
  assert.equal(template.thumbnailKey, null, "thumbnail generation failed silently on every drlurie template");
});

test("W0/A: lenient final-mode rendering produces [object Object] and blank content pages", async () => {
  const html = await buildEngine(false).parseAndRender(template.templateJson.html, fixture.job.data);
  const pages = pageTexts(html);

  assert.equal(pages.length, 5, "brochure renders five pages");

  const objectObjectCount = html.split("[object Object]").length - 1;
  assert.equal(
    objectObjectCount,
    fixture.expectedDefects.objectObjectTokens,
    "brand is injected as an object but slotted as a string, on the cover and on p5",
  );

  for (const pageNumber of fixture.expectedDefects.blankContentPages) {
    const page = pages.find((p) => p.index === pageNumber);
    assert.ok(page, `page ${pageNumber} exists`);
    // The baked-in kicker ("The philosophy" / "Daytime" / "Nighttime") is the only text left.
    assert.ok(
      page.text.length < 40,
      `page ${pageNumber} carries fewer than 40 characters — all pN Title/Body slots were undefined (got ${page.text.length}: ${JSON.stringify(page.text)})`,
    );
  }
});

test("W0/A: every image slot holds a site-relative /img/ path the render service cannot fetch", () => {
  const imgSlots = [...template.templateJson.html.matchAll(/src="\{\{\s*(\w+)\s*\}\}"/g)].map((m) => m[1]);
  assert.deepEqual(
    imgSlots.sort(),
    [...fixture.expectedDefects.unresolvedImages].sort(),
    "the template binds images with raw {{slot}} src, never through render.assets.invalid/",
  );
  for (const slot of imgSlots) {
    const value = fixture.job.data[slot];
    assert.equal(typeof value, "string");
    assert.ok(
      (value as string).startsWith("/img/"),
      `${slot} is a site-relative path; the render service aborts it and records an engineWarning`,
    );
  }
  assert.equal(
    Object.keys((fixture.job as unknown as { assets?: Record<string, unknown> }).assets ?? {}).length,
    0,
    "no job assets were supplied, so nothing could have resolved",
  );
});

// ---------------------------------------------------------------------------
// Part B — RED until W1 lands
// ---------------------------------------------------------------------------

test("W0/B (T1.2): the chromium engine no longer restricts strictVariables to validation mode", async () => {
  // Proof-of-premise first: with strict on, this exact payload is rejected rather than
  // silently emitting blanks. (Liquid-level; the engine-level behaviour is asserted below.)
  await assert.rejects(
    () => buildEngine(true).parseAndRender(template.templateJson.html, fixture.job.data),
    /p2Title|undefined variable|not defined/i,
    "with strictVariables on, the missing pN slots must throw",
  );

  // render-service is a separate package with its own tsconfig and test runner, so the
  // behavioural acceptance test for T1.2 lives in render-service/tests/. What this suite
  // pins is the contract that mode alone must stop deciding strictness.
  const engineSource = readFileSync(
    path.join(process.cwd(), "render-service", "src", "engines", "chromium.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    engineSource,
    /strictVariables:\s*mode === "validation"/,
    'strictVariables must not be tied to mode === "validation" — final renders bind strictly too, with an explicit per-job `lenient` opt-out',
  );
  assert.match(
    engineSource,
    /lenient/,
    "the per-job lenient opt-out must be threaded into the engine",
  );
});

test("W0/B (T1.4): the quality gate reports all three defect classes in warn mode", async () => {
  const { evaluateQualityGate } = await loadQualityGate();

  const html = await buildEngine(false).parseAndRender(template.templateJson.html, fixture.job.data);
  const report = evaluateQualityGate({
    pages: pageTexts(html),
    engineWarnings: fixture.expectedDefects.unresolvedImages.map(
      (slot) => `blocked request: ${fixture.job.data[slot] as string} (${slot})`,
    ),
  });

  assert.equal(report.passed, false, "warn mode still reports passed:false; the job itself completes");

  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has("UNRENDERED_TOKEN"), "must flag the [object Object] tokens");
  assert.ok(codes.has("BLANK_PAGE"), "must flag the four blank content pages");
  assert.ok(codes.has("UNRESOLVED_IMAGE"), "must flag the three unfetchable images");

  const blankPages = report.findings.filter((f) => f.code === "BLANK_PAGE").map((f) => f.page).sort();
  assert.deepEqual(blankPages, fixture.expectedDefects.blankContentPages, "cover page is exempt; pages 2-5 are not");
});

test("W0/B (T1.4): a clean render passes the gate", async () => {
  const { evaluateQualityGate } = await loadQualityGate();

  const report = evaluateQualityGate({
    pages: [
      { index: 1, text: "What moisturizers actually do — Dr. Lurie" },
      { index: 2, text: "Humectants draw water into the stratum corneum, and they keep drawing it for as long as the surface stays occluded." },
      { index: 3, text: "Emollients sit between corneocytes and smooth the surface, which is what people feel as softness within minutes." },
    ],
    engineWarnings: [],
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
});
