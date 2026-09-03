/**
 * T1.4 (BRIEF §2, ruling D-A) — the PDF content quality gate, and the engine diagnostics
 * that used to be thrown away.
 *
 * Two halves, both traced back to the 2026-09-03 drlurie moisturizer brochure:
 *
 *   1. `agent-artifact-worker-background.ts` persisted only `renderMetadata` and
 *      `validationResults`. Every `engineWarnings` entry the chromium engine had already
 *      computed — the aborted asset fetches that made every image in that brochure a
 *      broken-image box — vanished at that line. They now land on the job record's existing
 *      `warnings[]`, appended after the size warning, and echoed on
 *      get_agent_artifact_job_status.
 *   2. Nothing looked at what was ON the pages. `evaluateQualityGate` does: blank pages,
 *      unresolved images, unrendered tokens.
 *
 * The gate WARNS. A job with findings reaches `status: "complete"` carrying
 * `qualityGate: { passed: false, findings }`; only `failOnQualityGate: true` turns that into
 * a typed PDF_QUALITY_GATE failure. The tests below assert both directions explicitly,
 * because inverting this ruling is the easy mistake.
 *
 * The W0 anchor (tests/agent-artifact-pdf-quality-gate-w0.test.ts) pins the gate's behaviour
 * on the committed fixture; this file covers everything around it, and in particular the
 * false-positive policy: a full-bleed cover, an image plate, a page whose glyphs cannot be
 * read back, and prose that legitimately contains the word "undefined" must all stay quiet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { createArtifactJob, readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { createAgentArtifactJob, getAgentArtifactJobStatus } from "../netlify/lib/agent-artifact-mcp.js";
import { writePdfTemplateValidation } from "../netlify/lib/pdf-template-store.js";
import { inspectPdf } from "../netlify/lib/pdf-render/inspect.js";
import {
  evaluateQualityGate,
  evaluateRenderQualityGate,
  sanitizeDiagnosticText,
  type QualityFinding,
} from "../netlify/lib/pdf-render/quality-gate.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
}

const AUTH = { authorization: "Bearer test-token" };
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// ---------------------------------------------------------------------------
// Unit level — evaluateQualityGate (the contract pinned in BRIEF §2)
// ---------------------------------------------------------------------------

const codesOf = (findings: QualityFinding[]) => new Set(findings.map((finding) => finding.code));
const pagesOf = (findings: QualityFinding[], code: string) =>
  findings.filter((finding) => finding.code === code).map((finding) => finding.page);

test("quality gate: reports blank pages, unrendered tokens and unresolved images together, and passes a clean render", () => {
  const failing = evaluateQualityGate({
    pages: [
      { index: 1, text: "Skin science — What moisturizers actually do — Three jobs, one product." },
      { index: 2, text: "The philosophy" },
      { index: 3, text: "Daytime" },
      { index: 4, text: "Nighttime" },
      { index: 5, text: "[object Object] Educational content. Not medical advice." },
    ],
    engineWarnings: [
      'unresolved job asset: no asset named "coverImage" was supplied for https://render.assets.invalid/coverImage',
    ],
  });
  assert.equal(failing.passed, false);
  assert.deepEqual(codesOf(failing.findings), new Set(["BLANK_PAGE", "UNRENDERED_TOKEN", "UNRESOLVED_IMAGE"]));
  assert.deepEqual(pagesOf(failing.findings, "BLANK_PAGE"), [2, 3, 4], "page 5 is 56 chars: the token rule catches it, not the length rule");
  assert.deepEqual(pagesOf(failing.findings, "UNRENDERED_TOKEN"), [5]);

  const clean = evaluateQualityGate({
    pages: [
      { index: 1, text: "What moisturizers actually do — Dr. Lurie" },
      { index: 2, text: "Humectants draw water into the stratum corneum, and keep drawing while the surface stays occluded." },
      { index: 3, text: "Emollients sit between corneocytes and smooth the surface, which people feel as softness." },
    ],
    engineWarnings: [],
  });
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.findings, []);
});

test("quality gate: the cover page is exempt from BLANK_PAGE, and coverPageIndex moves the exemption", () => {
  const pages = [
    { index: 1, text: "Dr. Lurie" },
    { index: 2, text: "Moisturizers" },
  ];
  assert.deepEqual(pagesOf(evaluateQualityGate({ pages }).findings, "BLANK_PAGE"), [2]);
  assert.deepEqual(pagesOf(evaluateQualityGate({ pages, coverPageIndex: 2 }).findings, "BLANK_PAGE"), [1]);
  // A page-count threshold caller can also loosen the length rule without touching the code.
  assert.deepEqual(evaluateQualityGate({ pages, minTextChars: 5 }).findings, []);
});

/**
 * BRIEF §2 pins this rule as `\bundefined\b` — word boundaries only, "treat a hit as a
 * finding, not an error". The boundary is what the pin buys: prose containing the word as a
 * SUBSTRING stays quiet. A hit at a word boundary is reported, wherever in the sentence it
 * falls, because that is where a leaked binding lands.
 *
 * W3 regression anchor: T1.4 shipped a prose heuristic on top of the pin (drop a lone hit
 * followed by a lowercase word, or preceded by a copula). Every string in `midSentenceLeaks`
 * below passed silently under it — they are `Reviewed by {{author}} on {{date}}` with
 * `author` unbound, which is the exact defect the gate exists for.
 */
test("quality gate: the pinned \\bundefined\\b rule — substrings stay quiet, word-boundary hits are findings", () => {
  const substringProse = [
    "Barrier repair is a well-defined process, and redefined guidance follows each review.",
    "Read more at dr-lurie.example/glossary/undefinedness-in-dermatology for the full note.",
  ];
  for (const text of substringProse) {
    const report = evaluateQualityGate({ pages: [{ index: 1, text: "cover" }, { index: 2, text }] });
    assert.deepEqual(
      report.findings.filter((finding) => finding.code === "UNRENDERED_TOKEN"),
      [],
      `a substring must not trip the token rule: ${JSON.stringify(text)}`
    );
  }

  const midSentenceLeaks = [
    "Reviewed by undefined on 3 September 2026 for the Dr. Lurie editorial desk.",
    "Prepared for undefined by the Dr. Lurie team, with more words to clear the floor.",
    "Author: undefined. Reviewed by the Dr. Lurie editorial desk before publication today.",
    "Written by undefined, published undefined, in the undefined section of the site archive.",
  ];
  for (const text of midSentenceLeaks) {
    const report = evaluateQualityGate({ pages: [{ index: 1, text: "cover" }, { index: 2, text }] });
    assert.ok(
      codesOf(report.findings).has("UNRENDERED_TOKEN"),
      `a leaked value must trip the token rule wherever it sits in the sentence: ${JSON.stringify(text)}`
    );
  }

  // The known, accepted cost of honouring the pin: a page whose prose genuinely uses the
  // word is warned about. Asserted rather than left implicit, so the trade-off is visible
  // and a future change to it is a deliberate one.
  const prose = evaluateQualityGate({
    pages: [{ index: 1, text: "cover" }, { index: 2, text: "The mechanism by which occlusives slow water loss is undefined in the current literature." }],
  });
  assert.ok(
    codesOf(prose.findings).has("UNRENDERED_TOKEN"),
    "the pinned rule reports prose too; the gate warns and never blocks (ruling D-A), so a reader dismisses it"
  );
});

test("quality gate: [object Object] is caught through uppercasing and letter-spacing; {{ }} only when contiguous", () => {
  // Real chromium output for the committed fixture: CSS text-transform uppercases the token,
  // and letter-spacing can put whitespace between every glyph in an extractor's reading.
  for (const text of ["[OBJECT OBJECT]", "[ O B J E C T   O B J E C T ]", "prefix [object Object] suffix"]) {
    const report = evaluateQualityGate({ pages: [{ index: 1, text: `${text} plus enough words to clear the blank-page floor entirely` }] });
    assert.ok(codesOf(report.findings).has("UNRENDERED_TOKEN"), `must flag ${JSON.stringify(text)}`);
  }
  const survived = evaluateQualityGate({ pages: [{ index: 1, text: "Heading {{title}} and a long enough tail of words to clear the floor" }] });
  assert.ok(codesOf(survived.findings).has("UNRENDERED_TOKEN"), "a surviving Liquid delimiter is a finding");
  // A PDF that legitimately prints JSON or code has braces with whitespace between them; the
  // delimiter rule stays strict so that is not mistaken for an unrendered placeholder.
  const json = evaluateQualityGate({ pages: [{ index: 1, text: 'Example payload: { "brand": { "accent": "#c9a96a" } } as stored on the record' }] });
  assert.deepEqual(json.findings, [], `spaced braces must not be read as a template token: ${JSON.stringify(json.findings)}`);
});

test("quality gate: an UNRESOLVED_IMAGE finding names only the asset id or the host, never the path it came from", () => {
  const tenantPath = "/img/req_plugin_moisturizer_functions_20260903_01/d913a7c895e13d5909afe43dbfdfaddbffd62b19b783a61202102f241685cd5a.webp";
  const report = evaluateQualityGate({
    pages: [{ index: 1, text: "Cover" }],
    engineWarnings: [
      `blocked request: ${tenantPath} (coverImage)`,
      'unresolved job asset: no asset named "morningImage" was supplied for https://render.assets.invalid/morningImage',
      "blocked network request: https://cdn.example.com/assets/hero-9f2b.png",
      // Not image problems: these must not become UNRESOLVED_IMAGE findings.
      "overflow diagnostics unavailable: page evaluation timed out",
      "first-page thumbnail capture failed: context closed",
    ],
  });
  const images = report.findings.filter((finding) => finding.code === "UNRESOLVED_IMAGE");
  assert.equal(images.length, 3, `expected exactly the three image warnings, got ${JSON.stringify(report.findings)}`);
  assert.ok(images[0].detail.includes('"coverImage"'));
  assert.ok(images[1].detail.includes('"morningImage"'));
  assert.ok(images[2].detail.includes('"cdn.example.com"'));
  for (const finding of report.findings) {
    assert.ok(!finding.detail.includes("req_plugin_moisturizer"), `finding leaks a tenant path: ${finding.detail}`);
    assert.ok(!finding.detail.includes("d913a7c8"), `finding leaks a content sha: ${finding.detail}`);
    assert.ok(!finding.detail.includes("/img/"), `finding leaks a storage path: ${finding.detail}`);
  }
  // Repeats of the same reference collapse into one finding rather than flooding the report.
  const repeated = evaluateQualityGate({
    pages: [],
    engineWarnings: ["blocked request: https://render.assets.invalid/logo", "blocked request: https://render.assets.invalid/logo"],
  });
  assert.equal(repeated.findings.length, 1);
});

test("sanitizeDiagnosticText: keeps asset ids and hosts, redacts tenant paths out of engine warnings", () => {
  assert.equal(
    sanitizeDiagnosticText('unresolved job asset: no asset named "logo" was supplied for https://render.assets.invalid/logo'),
    'unresolved job asset: no asset named "logo" was supplied for asset "logo"'
  );
  const redacted = sanitizeDiagnosticText(
    "blocked network request: https://drlurie.example.com/img/req_plugin_moisturizer_functions_20260903_01/d913a7c8.webp"
  );
  assert.ok(redacted.includes("drlurie.example.com"), `host is useful and stays: ${redacted}`);
  assert.ok(!redacted.includes("req_plugin_moisturizer"), `request path must be redacted: ${redacted}`);
  const barePath = sanitizeDiagnosticText("blocked request: /img/req_plugin_x/c90a53be0852336d.webp (coverImage)");
  assert.ok(!barePath.includes("c90a53be"), `blob sha must be redacted: ${barePath}`);
  assert.ok(barePath.includes("(coverImage)"), `the slot name is safe and useful: ${barePath}`);
  assert.ok(sanitizeDiagnosticText("x".repeat(500)).length <= 300);
});

test("evaluateRenderQualityGate: an image page is not blank, and a page whose glyphs cannot be read is not judged", () => {
  // A full-bleed section divider: almost no text, but it draws a picture. Flagging it is the
  // noise the gate must not make.
  const withImage = evaluateRenderQualityGate({
    pages: [
      { index: 1, text: "Cover", hasImage: true },
      { index: 2, text: "Evening", hasImage: true },
      { index: 3, text: "Morning", hasImage: false },
    ],
  });
  assert.deepEqual(pagesOf(withImage.findings, "BLANK_PAGE"), [3], "only the wordless, pictureless page is blank");

  // ...but an image page still gets the token rules.
  const tokenOnImagePage = evaluateRenderQualityGate({
    pages: [{ index: 1, text: "Cover" }, { index: 2, text: "[object Object]", hasImage: true }],
  });
  assert.deepEqual(codesOf(tokenOnImagePage.findings), new Set(["UNRENDERED_TOKEN"]));

  // text: undefined means "could not read", not "empty" — such a page is dropped entirely.
  const unreadable = evaluateRenderQualityGate({ pages: [{ index: 1, text: "Cover" }, { index: 2 }, { index: 3 }] });
  assert.deepEqual(unreadable.findings, []);
  assert.equal(unreadable.passed, true);
});

// ---------------------------------------------------------------------------
// inspectPdf(extractText) — the per-page text the gate actually runs on
// ---------------------------------------------------------------------------

interface StubFont { name: string }
interface StubPage { drawText(text: string, options: Record<string, unknown>): void }
interface StubDoc {
  embedFont(font: string): Promise<StubFont>;
  addPage(size: [number, number]): StubPage;
  save(): Promise<Uint8Array>;
}

const A4: [number, number] = [595.28, 841.89];

/** Builds a real PDF whose pages carry the given lines of text (empty array = a blank page). */
async function buildPdf(pages: string[][]): Promise<Buffer> {
  const pdfLib = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<StubDoc> };
    StandardFonts: { Helvetica: string };
  };
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage(A4);
    lines.forEach((line, index) => page.drawText(line, { x: 40, y: 780 - index * 20, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

test("inspectPdf(extractText): reads per-page text out of a real PDF without touching the requirements results", async () => {
  const bytes = await buildPdf([
    ["What moisturizers actually do", "Dr. Lurie"],
    [],
    ["[object Object]", "Educational content. Not medical advice."],
  ]);

  const plain = await inspectPdf(bytes);
  assert.equal(plain.pageCount, 3);
  assert.equal(plain.pages[0].text, undefined, "text extraction is opt-in; the requirements path pays nothing");

  const withText = await inspectPdf(bytes, { extractText: true });
  assert.equal(withText.pageCount, 3);
  assert.equal(withText.pages[0].text, "What moisturizers actually do Dr. Lurie");
  assert.equal(withText.pages[1].text, "", "a page with no text reads as empty, not as unreadable");
  assert.equal(withText.pages[2].text, "[object Object] Educational content. Not medical advice.");
  assert.equal(withText.pages[0].hasImage, undefined);

  const report = evaluateRenderQualityGate({
    pages: withText.pages.map((page, index) => ({ index: index + 1, text: page.text, hasImage: page.hasImage })),
  });
  assert.deepEqual(pagesOf(report.findings, "BLANK_PAGE"), [2]);
  assert.deepEqual(pagesOf(report.findings, "UNRENDERED_TOKEN"), [3]);
});

// ---------------------------------------------------------------------------
// End to end through the worker, against a mock render service
// ---------------------------------------------------------------------------

interface CapturedRequest { path: string; body: Record<string, unknown> }

async function startMockService(respond: () => { status: number; body?: unknown }) {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({ path: req.url ?? "", body });
      const response = respond();
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** chromium publishes behind a hard validation gate; this suite tests the gate, not gating. */
async function seedPassedValidation(templateId: string, version = 1) {
  const now = new Date().toISOString();
  await writePdfTemplateValidation("dr-lurie", {
    validationId: `seed-${templateId}-v${version}`,
    projectId: "dr-lurie",
    templateId,
    version,
    renderer: "chromium",
    status: "passed",
    dataSha256: "seeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
}

async function publishChromiumTemplate(templateId: string) {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId,
      templateJson: { html: "<h1>{{ title }}</h1>", css: "h1 { color: #222; }" },
      renderer: "chromium",
    }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await seedPassedValidation(templateId);
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);
}

/** The 2026-09-03 shape: a full cover, three near-empty content pages, a token on the last. */
const BAD_RENDER_PAGES = [
  ["Skin science", "What moisturizers actually do", "Three jobs, one product: draw water in, soften, slow what leaves."],
  ["The philosophy"],
  ["Daytime"],
  ["Nighttime"],
  ["[object Object]", "Educational content. Not medical advice."],
];

const CLEAN_RENDER_PAGES = [
  ["What moisturizers actually do", "Dr. Lurie"],
  ["Humectants draw water into the stratum corneum and keep drawing it while occluded."],
  ["Emollients sit between corneocytes and smooth what people feel as softness."],
];

const TENANT_WARNING =
  "blocked network request: https://drlurie.example.com/img/req_plugin_moisturizer_functions_20260903_01/d913a7c8.webp";

async function runWorkerAgainst(options: {
  templateId: string;
  requestId: string;
  pages: string[][];
  engineWarnings?: string[];
  failOnQualityGate?: boolean;
}) {
  const pdfBase64 = (await buildPdf(options.pages)).toString("base64");
  const mock = await startMockService(() => ({
    status: 200,
    body: {
      ok: true,
      pdfBase64,
      diagnostics: {
        pageCount: options.pages.length,
        sizeBytes: 1,
        pages: [],
        ...(options.engineWarnings ? { engineWarnings: options.engineWarnings } : {}),
        engine: { id: "chromium", executedIn: "render-service" },
      },
    },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "chromium-secret";
    await publishChromiumTemplate(options.templateId);
    const job = await createArtifactJob({
      projectId: "dr-lurie",
      requestId: options.requestId,
      artifactKind: "pdf",
      templateId: options.templateId,
      filename: "what-moisturizers-actually-do.pdf",
      data: { title: "What moisturizers actually do" },
      ...(options.failOnQualityGate ? { failOnQualityGate: true } : {}),
      tags: [],
      label: undefined,
    });
    const response = await workerHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId: job.jobId }),
    });
    const record = await readArtifactJob("dr-lurie", job.jobId);
    assert.ok(record, "job record must exist after the worker ran");
    return { response, body: JSON.parse(response.body) as Record<string, unknown>, record, jobId: job.jobId };
  } finally {
    await mock.close();
  }
}

test("worker (warn mode): a render that trips the gate still COMPLETES, carrying warnings[] and qualityGate", async () => {
  const { response, body, record, jobId } = await runWorkerAgainst({
    templateId: "gate-warn",
    requestId: "req-gate-warn",
    pages: BAD_RENDER_PAGES,
    engineWarnings: ['unresolved job asset: no asset named "coverImage" was supplied for https://render.assets.invalid/coverImage'],
  });

  assert.equal(response.statusCode, 200, `worker failed: ${response.body}`);
  assert.equal(body.status, "complete", "BRIEF D-A: the gate warns, it never blocks");
  assert.equal(record.status, "complete");
  assert.ok(record.artifactReference, "the artifact is stored anyway");
  assert.equal(record.errorCode, undefined);

  const gate = record.qualityGate;
  assert.ok(gate, "the job record must carry the quality gate report");
  assert.equal(gate.passed, false);
  assert.deepEqual(codesOf(gate.findings), new Set(["BLANK_PAGE", "UNRENDERED_TOKEN", "UNRESOLVED_IMAGE"]));
  assert.deepEqual(pagesOf(gate.findings, "BLANK_PAGE"), [2, 3, 4], "the cover is exempt; page 5 is caught by the token rule");

  // ...and it is visible to the agent that polls, not just on the stored record.
  const status = await getAgentArtifactJobStatus({ projectId: "dr-lurie", jobId });
  assert.equal(status.ok, true);
  const statusBody = status as unknown as { status: string; qualityGate?: { passed: boolean }; warnings?: string[] };
  assert.equal(statusBody.status, "complete");
  assert.equal(statusBody.qualityGate?.passed, false);
  assert.ok(statusBody.warnings?.some((warning) => /Quality gate reported/.test(warning)), `expected a gate summary in warnings: ${JSON.stringify(statusBody.warnings)}`);
});

test("worker: engineWarnings reach job.warnings, sanitized, with no tenant path riding along", async () => {
  const { body, record } = await runWorkerAgainst({
    templateId: "gate-warnings-only",
    requestId: "req-gate-warnings-only",
    pages: CLEAN_RENDER_PAGES,
    engineWarnings: [TENANT_WARNING, "overflow diagnostics unavailable: page evaluation timed out"],
  });

  assert.equal(body.status, "complete");
  // The pages themselves are clean: the only finding is the blocked image fetch, which is
  // precisely the diagnostic the worker used to discard.
  assert.deepEqual(codesOf(record.qualityGate?.findings ?? []), new Set(["UNRESOLVED_IMAGE"]));

  const warnings = record.warnings ?? [];
  assert.equal(warnings.length, 3, `expected both engine warnings plus the gate summary, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((warning) => warning.includes("drlurie.example.com")), "the host survives — it is what makes the warning actionable");
  assert.ok(warnings.some((warning) => warning.includes("overflow diagnostics unavailable")), "non-image diagnostics are kept too, and are not misreported as image findings");
  for (const warning of [...warnings, ...(record.qualityGate?.findings ?? []).map((finding) => finding.detail)]) {
    assert.ok(!warning.includes("req_plugin_moisturizer"), `agent-visible text must not carry a tenant path: ${warning}`);
    assert.ok(!warning.includes("d913a7c8"), `agent-visible text must not carry a blob sha: ${warning}`);
  }
  assert.deepEqual(body.warnings, warnings, "the worker response echoes the same list");
});

test("worker (failOnQualityGate): the same render FAILS the job with PDF_QUALITY_GATE and stores no artifact", async () => {
  const { response, body, record } = await runWorkerAgainst({
    templateId: "gate-hard",
    requestId: "req-gate-hard",
    pages: BAD_RENDER_PAGES,
    engineWarnings: ['unresolved job asset: no asset named "coverImage" was supplied for https://render.assets.invalid/coverImage'],
    failOnQualityGate: true,
  });

  assert.equal(response.statusCode, 500);
  assert.equal(body.status, "failed");
  assert.equal(body.errorCode, "PDF_QUALITY_GATE");
  assert.equal(record.status, "failed");
  assert.equal(record.errorCode, "PDF_QUALITY_GATE");
  assert.equal(record.artifactReference, undefined, "a hard-stopped job stores nothing");
  const detail = record.errorDetail as { qualityGate?: { passed: boolean; findings: QualityFinding[] } } | undefined;
  assert.equal(detail?.qualityGate?.passed, false);
  assert.ok((detail?.qualityGate?.findings.length ?? 0) > 0);
  assert.ok(!(record.error ?? "").includes("req_plugin"), "the failure message must stay free of tenant paths");

  // W3: the hard-stop message used to be built from summarizeQualityGate, so a job that
  // stored NOTHING told its caller "the artifact was stored anyway per the warn-only content
  // policy". On the one path where the reader most needs to know what was kept, it said the
  // opposite of the truth.
  const message = record.error ?? "";
  assert.ok(!/stored anyway/i.test(message), `a failed job must not claim its artifact was stored: ${message}`);
  assert.match(message, /NO artifact was stored/);
  assert.match(message, /failOnQualityGate/);
});

test("worker: a clean render with no engine warnings completes with neither warnings nor gate findings", async () => {
  const { body, record } = await runWorkerAgainst({
    templateId: "gate-clean",
    requestId: "req-gate-clean",
    pages: CLEAN_RENDER_PAGES,
  });
  assert.equal(body.status, "complete");
  assert.equal(record.warnings, undefined);
  assert.equal(record.qualityGate?.passed, true);
  assert.deepEqual(record.qualityGate?.findings, []);
  assert.equal(body.warnings, undefined);
});

test("create_agent_artifact_job: failOnQualityGate is accepted on the request and persisted on the job record", async () => {
  await publishChromiumTemplate("gate-flag");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  try {
    const result = (await createAgentArtifactJob(
      {
        projectId: "dr-lurie",
        requestId: "req-gate-flag",
        artifactKind: "pdf",
        templateId: "gate-flag",
        filename: "what-moisturizers-actually-do.pdf",
        data: { title: "What moisturizers actually do" },
        failOnQualityGate: true,
      },
      { baseUrl: "https://pdf-tool.test", token: "test-token" }
    )) as { ok: boolean; jobId?: string; error?: string };
    assert.equal(result.ok, true, `job creation rejected the flag: ${JSON.stringify(result)}`);
    const record = await readArtifactJob("dr-lurie", result.jobId!);
    assert.equal(record?.failOnQualityGate, true, "the flag must survive onto the record the worker reads");
  } finally {
    globalThis.fetch = realFetch;
  }
});
