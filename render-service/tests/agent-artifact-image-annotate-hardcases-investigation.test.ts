/**
 * KI-30 — the task's own "hard cases" table, measured against REAL Chromium.
 *
 * For each case this renders the bare string with NO explicit width (`display: inline-block;
 * white-space: nowrap`, so the box sizes to its own content — the ground truth: what
 * Chromium's real text layout actually measures for this string, independent of any
 * predicted box), and prints predicted-OLD (ADVANCE_RATIO heuristic) vs predicted-NEW
 * (font-metrics-data.ts's exact glyph advances) vs MEASURED (real Chromium) side by side.
 *
 * This is a permanent, deliberate console.log — like
 * agent-artifact-image-annotate-png-golden.test.ts's "option (c) investigation" test, the
 * point is to put real, current-Chromium numbers where a human reading the T-report can
 * check them, not to assert a specific verdict for every case (the Hebrew case in
 * particular is a FINDING, not a pass/fail — see its own assertions below).
 *
 * The `illiliilli` / `MMMWWW` cases are NOT rendered with an explicit predicted-box width
 * (unlike the "NAC" regression test): neither one actually WRAPS at either width (the old
 * heuristic just produces a box that is too wide or too narrow, not a wrap-vs-no-wrap
 * defect), so the meaningful ground truth is the string's own natural content width, not
 * whether some particular candidate box's height doubled.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";

if (!process.env.CHROMIUM_EXECUTABLE_PATH) {
  process.env.CHROMIUM_EXECUTABLE_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
}

let CHROMIUM_AVAILABLE = false;
const HERE = dirname(fileURLToPath(import.meta.url));

before(async () => {
  const probe = await chromiumAvailable();
  CHROMIUM_AVAILABLE = probe.available;
});

after(async () => {
  await closeChromiumForTests();
});

const SECRET = "image-annotate-hardcases-secret";

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

const FONT_SIZE_PX = 24;
const ADVANCE_RATIO_NORMAL = 0.52; // resolve.ts's ADVANCE_RATIO.normal — duplicated as a literal
// for the same test/service decoupling reason documented in agent-artifact-image-annotate-
// nac-regression.test.ts's header.

interface CodepointAdvances {
  unitsPerEm: number;
  advances: Record<string, number>;
}

// The exact NotoSans-Regular / NotoSansHebrew-Regular advance widths this investigation
// needs, read straight out of the generated table at test-file-load time via a plain JSON
// read of the SAME source-of-truth bytes font-metrics-data.ts was generated from would
// require re-parsing the TTF here (out of scope for a test) — instead these are copied
// literals, one line per codepoint used below, each individually reproducible with:
//   node --experimental-strip-types -e 'import("./netlify/lib/image-annotate/font-metrics-data.ts").then(m=>console.log(m.FONT_METRICS_TABLE["<face>"].advances["<codepoint>"]))'
// and cross-checked against fontTools in the T-report. Freshness for the REAL table (not
// this investigation's copy) is enforced by tests/agent-artifact-font-metrics-freshness.test.ts.
const NOTO_SANS_REGULAR: CodepointAdvances = {
  unitsPerEm: 1000,
  advances: {
    "105": 258, // i
    "108": 258, // l
    "77": 907, // M
    "87": 930, // W
    "84": 556, // T
    "104": 618, // h
    "101": 564, // e
    "113": 615, // q
    "117": 618, // u
    "99": 480, // c
    "107": 534, // k
    "98": 615, // b
    "114": 413, // r
    "111": 605, // o
    "119": 786, // w
    "110": 618, // n
    "102": 344, // f
    "120": 529, // x
    "106": 258, // j
    "109": 935, // m
    "112": 615, // p
    "115": 479, // s
    "32": 260, // space
  },
};

test("hard-cases literals match the generated font-metrics-data.ts table (guards the hand-copy above)", async () => {
  const mod = (await import("../../netlify/lib/image-annotate/font-metrics-data.js")) as typeof import("../../netlify/lib/image-annotate/font-metrics-data.js");
  const real = mod.FONT_METRICS_TABLE["NotoSans-Regular"];
  assert.equal(real.unitsPerEm, NOTO_SANS_REGULAR.unitsPerEm);
  for (const [cp, expected] of Object.entries(NOTO_SANS_REGULAR.advances)) {
    assert.equal(real.advances[cp], expected, `codepoint ${cp} (${String.fromCodePoint(Number(cp))}): hand-copied literal ${expected} != generated table ${real.advances[cp]}`);
  }
});

function exactWidth(text: string, table: CodepointAdvances, fontSizePx: number): number {
  let total = 0;
  for (const ch of text) {
    const advance = table.advances[String(ch.codePointAt(0))];
    if (advance === undefined) throw new Error(`no advance for codepoint ${ch.codePointAt(0)} ("${ch}") in the hand-copied literal table`);
    total += advance;
  }
  return (total / table.unitsPerEm) * fontSizePx;
}

function heuristicWidth(text: string, fontSizePx: number): number {
  return text.length * fontSizePx * ADVANCE_RATIO_NORMAL;
}

async function measureNaturalWidth(server: FastifyInstance, text: string, opts: { fontFamily: string; fonts?: Array<{ family: string; weight: "normal" | "bold"; bytesBase64: string }> }): Promise<{ w: number; h: number }> {
  const css = [
    `.ann-x {`,
    `  display: inline-block;`,
    `  white-space: nowrap;`,
    `  font-family: ${opts.fontFamily};`,
    `  font-size: ${FONT_SIZE_PX.toFixed(2)}px;`,
    `  font-weight: 400;`,
    `  margin: 0;`,
    `}`,
  ].join("\n");
  const html = `<div class="ann-x">${text}</div>`;
  const response = await server.inject({
    method: "POST",
    url: "/render/image",
    headers: { "x-render-secret": SECRET },
    payload: {
      template: { html, css },
      canvas: { w: 800, h: 200 },
      ...(opts.fonts ? { fonts: opts.fonts } : {}),
      options: { measure: [".ann-x"] },
    },
  });
  const body = JSON.parse(response.body) as { ok: boolean; diagnostics?: { measurements?: Array<{ selector: string; found: boolean; w: number; h: number }> } };
  assert.equal(response.statusCode, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  const measurement = body.diagnostics?.measurements?.find((m) => m.selector === ".ann-x");
  assert.ok(measurement?.found, `.ann-x must be found (text=${JSON.stringify(text)})`);
  return { w: measurement!.w, h: measurement!.h };
}

test("hard-cases table: all-narrow, all-wide and mixed-sentence strings, predicted vs measured on real Chromium", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  const CASES = [
    { label: "all-narrow (illiliilli)", text: "illiliilli" },
    { label: "all-wide (MMMWWW)", text: "MMMWWW" },
    { label: "mixed sentence", text: "The quick brown fox jumps" },
  ];
  const results: Array<Record<string, unknown>> = [];
  await withServer(async (server) => {
    for (const { label, text } of CASES) {
      const predictedOld = heuristicWidth(text, FONT_SIZE_PX);
      const predictedNew = exactWidth(text, NOTO_SANS_REGULAR, FONT_SIZE_PX);
      const measured = await measureNaturalWidth(server, text, { fontFamily: "sans-serif" });
      results.push({
        label,
        text,
        predictedOld_heuristic: Number(predictedOld.toFixed(3)),
        predictedNew_metrics: Number(predictedNew.toFixed(3)),
        measured_realChromium: measured.w,
        oldErrorPx: Number((predictedOld - measured.w).toFixed(3)),
        oldErrorPct: `${(((predictedOld - measured.w) / measured.w) * 100).toFixed(1)}%`,
        newErrorPx: Number((predictedNew - measured.w).toFixed(3)),
        newErrorPct: `${(((predictedNew - measured.w) / measured.w) * 100).toFixed(1)}%`,
      });
    }
  });

  console.log(`[KI-30 hard-cases table: narrow/wide/mixed]\n${JSON.stringify(results, null, 2)}`);

  for (const r of results as Array<{ label: string; text: string; newErrorPx: number }>) {
    // The exact table's own error must be small — this is the whole point of the fix — but
    // NOT asserted at sub-pixel precision for ordinary prose: this investigation's OWN run
    // found Chromium's default `font-kerning: auto` measurably contracting "The quick brown
    // fox jumps" (~1.4px / 0.5% at 24px) relative to a pure sum-of-advances prediction —
    // confirmed by re-measuring with `font-kerning: none`, which lands back within 0.01px of
    // the prediction. See resolve.ts's defaultMeasureText scope note for the full write-up;
    // this is exactly the honest "say so rather than papering over it" case the task asked
    // for, not a bug in the table or the harness. The single-glyph-class strings
    // (all-narrow, all-wide) show no such effect — kerning is a PAIR property, and repeating
    // one glyph class has few or no defined kern pairs in this font — so they keep the tight
    // sub-pixel bound.
    const tolerancePx = r.text.includes(" ") && /[a-z]/.test(r.text) ? 2 : 1; // prose gets kerning headroom; monotone strings do not
    assert.ok(Math.abs(r.newErrorPx) < tolerancePx, `${r.label}: exact-metrics prediction should match real Chromium within ${tolerancePx}px, got ${r.newErrorPx}px off`);
  }
});

test("Hebrew finding: sum-of-advances (no shaping/bidi) against real Chromium, NotoSansHebrew forced via an uploaded per-request font", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  // NotoSansHebrew is NOT reachable through this feature's own font-family CSS resolution
  // today (see resolve.ts's resolveBundledFace doc: render-service/src/fonts.ts's
  // bundledFallbackFamily only ever returns NotoSans/NotoSerif) — a template naming
  // "NotoSansHebrew" gets rewritten to NotoSans, which likely lacks Hebrew coverage. To test
  // the ACTUAL question here (does sum-of-advances predict Hebrew width correctly) rather
  // than that unrelated routing gap, this uploads the real NotoSansHebrew-Regular.ttf bytes
  // as a per-request font under a family name the render service is GUARANTEED to honor
  // (uploaded fonts are matched by name before any bundled-face fallback — see
  // render-service/src/engines/chromium.ts's resolveFontFamilyForRequest).
  const fontPath = path.join(HERE, "..", "fonts", "NotoSansHebrew-Regular.ttf");
  const fontBytes = readFileSync(fontPath);
  const fontFamily = "TestHebrewInvestigation";

  const HEBREW_ADVANCES: CodepointAdvances = {
    unitsPerEm: 1000,
    advances: { "1513": 730, "1500": 522, "1493": 301, "1501": 684, "32": 270, "1506": 593 },
  };
  // Guard the hand-copy the same way as the Latin table above.
  {
    const mod = (await import("../../netlify/lib/image-annotate/font-metrics-data.js")) as typeof import("../../netlify/lib/image-annotate/font-metrics-data.js");
    const real = mod.FONT_METRICS_TABLE["NotoSansHebrew-Regular"];
    for (const [cp, expected] of Object.entries(HEBREW_ADVANCES.advances)) {
      assert.equal(real.advances[cp], expected, `Hebrew codepoint ${cp}: hand-copied literal ${expected} != generated table ${real.advances[cp]}`);
    }
  }

  // "שלום עולם" — "shalom olam" ("hello world"), a plain two-word RTL string with a space,
  // no niqqud, no ligatures expected in this script.
  const text = "שלום עולם";
  const predicted = exactWidth(text, HEBREW_ADVANCES, FONT_SIZE_PX);

  await withServer(async (server) => {
    const measured = await measureNaturalWidth(server, text, {
      fontFamily,
      fonts: [{ family: fontFamily, weight: "normal", bytesBase64: fontBytes.toString("base64") }],
    });
    const errorPx = predicted - measured.w;
    const errorPct = (errorPx / measured.w) * 100;
    console.log(
      `[KI-30 Hebrew finding] text=${JSON.stringify(text)} predicted(sum-of-advances)=${predicted.toFixed(3)}px measured(real Chromium, real NotoSansHebrew)=${measured.w}px ` +
        `errorPx=${errorPx.toFixed(3)} errorPct=${errorPct.toFixed(2)}%`
    );
    // This is the FINDING, not a hard pass/fail: total advance-width sum does not depend on
    // visual (bidi-reordered) glyph order, only on which glyphs are drawn, so for a script
    // with NO contextual shaping (Hebrew square script has none, unlike Arabic) the
    // prediction is expected to hold. Asserted loosely (5px / ~5%) so a genuine shaping
    // surprise fails loudly rather than being asserted away; report the number either way.
    assert.ok(Math.abs(errorPx) < Math.max(5, measured.w * 0.05), `Hebrew sum-of-advances prediction ${predicted.toFixed(3)}px vs measured ${measured.w}px differs by more than 5px/5% — see this file's console output for the exact numbers; this would be a genuine shaping/bidi finding, not a bug in the harness`);
  });
});
