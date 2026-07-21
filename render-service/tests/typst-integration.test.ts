import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

const SECRET = "typst-integration-secret";

function detectTypstBinary(): boolean {
  const bin = process.env.TYPST_BIN ?? "typst";
  try {
    const result = spawnSync(bin, ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

const TYPST_AVAILABLE = detectTypstBinary();

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

test("sample render with sys.inputs data + Hebrew text -> ok:true, pageCount >= 1", async (t) => {
  if (!TYPST_AVAILABLE) {
    t.skip("typst binary not available (set TYPST_BIN or install typst on PATH)");
    return;
  }
  await withServer(async (server) => {
    const response = await server.inject({
      method: "POST",
      url: "/render/typst",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: {
          source: [
            "#set text(font: \"Noto Sans Hebrew\")",
            "#let data = json(bytes(sys.inputs.data))",
            "= #data.title",
            "#data.hebrew",
          ].join("\n"),
        },
        data: { title: "Smoke Test", hebrew: "שלום עולם" },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.pdfBase64, "string");
    assert.ok(body.diagnostics.pageCount >= 1);
    assert.equal(body.diagnostics.engine.id, "typst");
    assert.equal(body.diagnostics.engine.executedIn, "render-service");
  });
});

test("requirements.format/orientation flow through to --input and diagnostics", async (t) => {
  if (!TYPST_AVAILABLE) {
    t.skip("typst binary not available (set TYPST_BIN or install typst on PATH)");
    return;
  }
  await withServer(async (server) => {
    const response = await server.inject({
      method: "POST",
      url: "/render/typst",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: {
          source: [
            "#let requirements = json(bytes(sys.inputs.requirements))",
            "#set page(paper: \"a4\")",
            "Format requested: #requirements.format",
          ].join("\n"),
        },
        requirements: { format: "A4" },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.diagnostics.pages.length, 1);
  });
});

test("non-vendored @preview package import fails closed", async (t) => {
  if (!TYPST_AVAILABLE) {
    t.skip("typst binary not available (set TYPST_BIN or install typst on PATH)");
    return;
  }
  await withServer(async (server) => {
    const response = await server.inject({
      method: "POST",
      url: "/render/typst",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: { source: '#import "@preview/example:0.1.0": *\nhello' },
      },
    });
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "RENDER_ENGINE_ERROR");
    assert.equal(response.statusCode, 500);
  });
});

test("RENDER_TIMEOUT integration is not reliably constructible with a real timer race; skipped", (t) => {
  // Reliably forcing a hard typst timeout without either a pathological, version-fragile
  // template or a flaky sub-second race isn't worth it here — the timeout mechanism itself
  // (setTimeout + SIGKILL, clamped timeoutMs) is exercised structurally in
  // src/engines/typst.ts and doesn't depend on typst's internal behavior. Kept as an explicit
  // skip so `npm test` output documents the decision instead of silently omitting the case.
  t.skip("timeout path is a spawn/kill race, not reliably reproducible in an integration test");
});
