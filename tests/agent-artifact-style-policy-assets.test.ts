/**
 * D4 (BRIEF 3.4 + 3.10): the `style` override channel on create_agent_artifact_job (unknown
 * keys rejected by zod, styleSource/style echoed on the job response), `contexts` on
 * get_image_model_policy, and the assets.images[] blobKey resolution path (BRIEF 3.10) — a
 * blobKey asset resolves to base64 for the render service, and a missing blobKey (with no
 * dataUri fallback) is a typed rejection, never a silent skip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores, projectBlobStore } from "../netlify/lib/blob-store.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { resolveJobAssetsForService } from "../netlify/lib/pdf-render/job-assets.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";
import { deriveLocalStyleSource } from "../netlify/lib/agent-artifact-mcp.js";
import { DEFAULT_IMAGE_MODEL_POLICY } from "../netlify/lib/image-routing/policy.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.URL = "https://example.netlify.app";
  process.env.WORKER_ORIGIN_ALLOWLIST = "example.netlify.app,example.test,example.com";
  delete process.env.DEPLOY_PRIME_URL;
}

const AUTH = { authorization: "Bearer test-token" };
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" }
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  return mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) })
  });
}

async function withFetchStub<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- style: unknown keys rejected by zod ---

test("create_agent_artifact_job rejects an unknown key inside style", async () => {
  const response = await mcpRpc("tools/call", {
    name: "create_agent_artifact_job",
    arguments: {
      storage: STORAGE,
      projectId: "dr-lurie",
      requestId: "req-style-unknown",
      artifactKind: "image",
      prompt: "hero image",
      filename: "hero-shot.png",
      style: { visualStandardId: "vis_dr-lurie", bogusField: true }
    }
  });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, true);
  const structured = result.structuredContent;
  assert.ok(
    JSON.stringify(structured).includes("style"),
    `expected the rejection to name the offending "style" field: ${JSON.stringify(structured)}`
  );
});

// --- style: known-shape variants are accepted and echoed back ---

test("create_agent_artifact_job with style.override echoes style + styleSource:'override'", async () => {
  await withFetchStub(async () => {
    const response = await mcpRpc("tools/call", {
      name: "create_agent_artifact_job",
      arguments: {
        storage: STORAGE,
        projectId: "dr-lurie",
        requestId: "req-style-override",
        artifactKind: "image",
        prompt: "hero image",
        filename: "hero-shot.png",
        style: { override: { palette: ["#112233"] }, note: "the palette, not the subject" }
      }
    });
    assert.equal(response.statusCode, 200);
    const result = JSON.parse(response.body).result.structuredContent;
    assert.deepEqual(result.style, { override: { palette: ["#112233"] }, note: "the palette, not the subject" });
    assert.equal(result.styleSource, "override");
  });
});

test("create_agent_artifact_job with style.visualStandardId echoes styleSource:'visual_standard'", async () => {
  await withFetchStub(async () => {
    const response = await mcpRpc("tools/call", {
      name: "create_agent_artifact_job",
      arguments: {
        storage: STORAGE,
        projectId: "dr-lurie",
        requestId: "req-style-vsid",
        artifactKind: "image",
        prompt: "hero image",
        filename: "hero-shot.png",
        style: { visualStandardId: "vis_dr-lurie" }
      }
    });
    const result = JSON.parse(response.body).result.structuredContent;
    assert.equal(result.style.visualStandardId, "vis_dr-lurie");
    assert.equal(result.styleSource, "visual_standard");
  });
});

test("a job with no style at all carries neither style nor styleSource on its response", async () => {
  await withFetchStub(async () => {
    const response = await mcpRpc("tools/call", {
      name: "create_agent_artifact_job",
      arguments: { storage: STORAGE, projectId: "dr-lurie", requestId: "req-style-none", artifactKind: "image", prompt: "hero image", filename: "hero-shot.png" }
    });
    const result = JSON.parse(response.body).result.structuredContent;
    assert.equal("style" in result, false);
    assert.equal("styleSource" in result, false);
  });
});

test("get_agent_artifact_job_status echoes the same style/styleSource the job was created with", async () => {
  await withFetchStub(async () => {
    const createRes = await mcpRpc("tools/call", {
      name: "create_agent_artifact_job",
      arguments: { storage: STORAGE, projectId: "dr-lurie", requestId: "req-style-status", artifactKind: "image", prompt: "hero image", filename: "hero-shot.png", style: { visualStandardId: "vis_dr-lurie" } }
    });
    const jobId = JSON.parse(createRes.body).result.structuredContent.jobId;
    const statusRes = await mcpRpc("tools/call", { name: "get_agent_artifact_job_status", arguments: { storage: STORAGE, projectId: "dr-lurie", jobId } });
    const status = JSON.parse(statusRes.body).result.structuredContent;
    assert.equal(status.style.visualStandardId, "vis_dr-lurie");
    assert.equal(status.styleSource, "visual_standard");
  });
});

// --- deriveLocalStyleSource unit coverage ---

test("deriveLocalStyleSource: override wins over visualStandardId when both are present", () => {
  assert.equal(deriveLocalStyleSource({ override: {}, visualStandardId: "vis_x" }), "override");
});

test("deriveLocalStyleSource: undefined when style is absent, or present with only a note", () => {
  assert.equal(deriveLocalStyleSource(undefined), undefined);
  assert.equal(deriveLocalStyleSource({ note: "just a note" }), undefined);
});

// --- get_image_model_policy: contexts ---

test("get_image_model_policy returns contexts = keys of byUsageContext, including defaults", async () => {
  const response = await mcpRpc("tools/call", { name: "get_image_model_policy", arguments: { storage: STORAGE, projectId: "dr-lurie" } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.deepEqual(new Set(result.contexts), new Set(Object.keys(DEFAULT_IMAGE_MODEL_POLICY.byUsageContext)));
  assert.deepEqual(new Set(result.contexts), new Set(Object.keys(result.policy.byUsageContext)));
});

test("get_image_model_policy: a project override adds its usageContext to contexts", async () => {
  await mcpRpc("tools/call", {
    name: "set_image_model_policy",
    arguments: { storage: STORAGE, projectId: "dr-lurie", policy: { byUsageContext: { newsletter: { model: "fal-ai/flux-2/klein/9b" } } } }
  });
  const response = await mcpRpc("tools/call", { name: "get_image_model_policy", arguments: { storage: STORAGE, projectId: "dr-lurie" } });
  const result = JSON.parse(response.body).result.structuredContent;
  assert.ok(result.contexts.includes("newsletter"));
  assert.ok(result.contexts.includes("article_header"), "default contexts must still be present alongside the override");
});

// --- BRIEF 3.10: assets.images[] blobKey -> base64 resolution ---

test("job-assets: a blobKey asset resolves to base64, ready for the virtual-origin binding", async () => {
  const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bytes = Buffer.from(TINY_PNG_B64, "base64");
  const store = await projectBlobStore("artifacts");
  await store.set("images/header-shot.png", bytes);

  const resolved = await resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "header-shot", blobKey: "images/header-shot.png" }] });
  assert.equal(resolved.length, 1);
  // name is what the render service's virtual host (https://render.assets.invalid/<name>)
  // keys its asset map by — see job-assets.ts's F3 binding-convention docstring.
  assert.equal(resolved[0].name, "header-shot");
  assert.equal(resolved[0].bytesBase64, bytes.toString("base64"));
  assert.equal(resolved[0].contentType, "image/png");
});

test("job-assets: a blobKey that does not resolve to a stored blob is a typed ASSET_NOT_FOUND rejection", async () => {
  await assert.rejects(
    () => resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "missing-asset", blobKey: "images/does-not-exist.png" }] }),
    (err: unknown) => err instanceof RenderError && err.code === "ASSET_NOT_FOUND"
  );
});

// W3/BRIEF §1: this error is copied verbatim onto the failed job record (`error` +
// `errorDetail`) and echoed to agents by get_agent_artifact_job_status, so the blobKey must
// not appear in either. The assetId — which the caller supplied — must, so the finding is
// still actionable. Sanitizing this downstream (as T1.4/T1.7 each did in their own copy) is
// defence in depth; the source must be clean.
test("job-assets: ASSET_NOT_FOUND names the assetId and never the blobKey (message or detail)", async () => {
  await assert.rejects(
    () => resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "missing-asset", blobKey: "pdf/req_secret_tenant_path/c90a53be.png" }] }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      const error = err as RenderError;
      assert.equal(error.code, "ASSET_NOT_FOUND");
      assert.match(error.message, /missing-asset/);
      assert.ok(!error.message.includes("req_secret_tenant_path"), `blobKey leaked into the message: ${error.message}`);
      assert.ok(!error.message.includes("c90a53be"), `blobKey leaked into the message: ${error.message}`);
      assert.equal((error.detail as Record<string, unknown> | undefined)?.blobKey, undefined, "blobKey leaked into errorDetail");
      assert.equal(JSON.stringify(error.detail ?? {}).includes("req_secret_tenant_path"), false, "blobKey leaked into errorDetail");
      return true;
    }
  );
});

test("job-assets: an entry with neither dataUri nor blobKey is a typed ASSET_SOURCE_MISSING rejection, not a silent skip", async () => {
  await assert.rejects(
    () => resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "no-source" }] }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "ASSET_SOURCE_MISSING");
      assert.match((err as RenderError).message, /no-source/);
      return true;
    }
  );
});

test("job-assets: an entry with no id at all is skipped (nothing to name), unlike a named entry with no source", async () => {
  const resolved = await resolveJobAssetsForService("dr-lurie", { images: [{ dataUri: undefined, blobKey: undefined }] });
  assert.deepEqual(resolved, []);
});

/**
 * REVIEW: the counterpart to ASSET_SOURCE_MISSING above. A named entry whose `dataUri` is
 * not a data URI at all (no "," between header and payload) used to be dropped silently —
 * putting it in exactly the position the typed error exists to rule out: an asset the
 * template still references by id, resolving to nothing, surfacing as a broken image inside
 * an otherwise-successful render instead of a named failure. Empty strings and bare
 * base64-looking blobs both land here.
 */
for (const dataUri of ["", "not-a-data-uri", "data:image/png;base64"]) {
  test(`job-assets: a dataUri with no payload separator (${JSON.stringify(dataUri)}) is a typed rejection, not a silent skip`, async () => {
    await assert.rejects(
      () => resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "bad-datauri", dataUri }] }),
      (err: unknown) => {
        assert.ok(err instanceof RenderError, `expected a RenderError, got ${String(err)}`);
        assert.equal((err as RenderError).code, "ASSET_SOURCE_MISSING");
        assert.match((err as RenderError).message, /bad-datauri/);
        return true;
      }
    );
  });
}

test("job-assets: a well-formed dataUri still resolves (the guard above is not over-broad)", async () => {
  const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const resolved = await resolveJobAssetsForService("dr-lurie", {
    images: [{ assetId: "inline-shot", dataUri: `data:image/png;base64,${TINY_PNG_B64}` }],
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, "inline-shot");
  assert.equal(resolved[0].contentType, "image/png");
  assert.equal(resolved[0].bytesBase64, TINY_PNG_B64);
});

// --- REVIEW: single-validator rule for every field this wave added ---

/**
 * mcp.ts derives the advertised `inputSchema` AND the pre-dispatch enforcement from the same
 * MCP_TOOL_SCHEMAS zod object, so the two cannot drift by construction. This pins that for
 * the fields the wave actually added, from the outside: each one must be ADVERTISED on
 * tools/list and ENFORCED on tools/call. A field advertised but not enforced (or enforced but
 * not advertised) means someone reintroduced a second schema somewhere.
 */
const WAVE_FIELDS: Array<{ tool: string; field: string; bad: unknown; baseArgs: Record<string, unknown> }> = [
  {
    tool: "create_agent_artifact_job",
    field: "style",
    bad: "not-an-object",
    baseArgs: { storage: STORAGE, projectId: "dr-lurie", requestId: "req-drift", artifactKind: "image", prompt: "hero image", filename: "hero-shot.png" }
  },
  {
    tool: "create_pdf_template",
    field: "kind",
    bad: 17,
    baseArgs: { storage: STORAGE, projectId: "dr-lurie", templateId: "drift-probe", templateJson: { html: "<p>x</p>" } }
  },
  {
    tool: "create_pdf_template",
    field: "sampleAssets",
    bad: "not-an-object",
    baseArgs: { storage: STORAGE, projectId: "dr-lurie", templateId: "drift-probe", templateJson: { html: "<p>x</p>" } }
  }
];

test("every field this wave added is BOTH advertised on tools/list and enforced on tools/call", async () => {
  const listed = await mcpRpc("tools/list");
  const tools = JSON.parse(listed.body).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Advertised.
  for (const field of ["renderDataSchema", "sampleData", "kind", "sampleAssets"]) {
    assert.ok(byName.get("create_pdf_template")!.inputSchema.properties[field], `create_pdf_template must advertise ${field}`);
  }
  const style = byName.get("create_agent_artifact_job")!.inputSchema.properties.style as {
    type?: string;
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.ok(style, "create_agent_artifact_job must advertise style");
  assert.equal(style.type, "object");
  assert.deepEqual(Object.keys(style.properties ?? {}).sort(), ["note", "override", "visualStandardId"]);
  // A strict client must see the same strictness the server enforces (the .strict() below).
  assert.equal(style.additionalProperties, false);

  // Enforced.
  for (const { tool, field, bad, baseArgs } of WAVE_FIELDS) {
    const response = await mcpRpc("tools/call", { name: tool, arguments: { ...baseArgs, [field]: bad } });
    const result = JSON.parse(response.body).result;
    assert.equal(result.isError, true, `${tool}.${field} is advertised but a malformed value was accepted`);
    assert.ok(
      JSON.stringify(result.structuredContent).includes(field),
      `${tool}.${field} rejection must name the field: ${JSON.stringify(result.structuredContent)}`
    );
  }
});

/**
 * REVIEW: the one way pdf-tool's `styleSource` could contradict the platform's is by
 * claiming a value only the platform can know. 'site', 'derived' and 'site_locked' (BRIEF
 * 3.4) all require site-level context — the site's brandImagery, its visual_standard
 * objects, and the brandImageryOverrides guardrail — that pdf-tool does not have and must
 * never guess at. Pin the emitted vocabulary to the two request-local values across every
 * shape `style` can take, so a later "helpful" widening fails here instead of shipping a
 * second, disagreeing authority on the same field name.
 */
const PLATFORM_ONLY_STYLE_SOURCES = ["site", "derived", "site_locked"];

test("pdf-tool's styleSource vocabulary never overlaps the platform-only values", () => {
  const shapes: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { note: "n" },
    { visualStandardId: "vis_x" },
    { override: {} },
    { override: { palette: ["#000"] }, note: "n" },
    { visualStandardId: "vis_x", note: "n" },
    { visualStandardId: "vis_x", override: {} },
    { visualStandardId: "vis_x", override: {}, note: "n" }
  ];
  for (const shape of shapes) {
    const source = deriveLocalStyleSource(shape as never);
    assert.ok(
      source === undefined || source === "override" || source === "visual_standard",
      `styleSource for ${JSON.stringify(shape)} was ${String(source)}`
    );
    assert.ok(!PLATFORM_ONLY_STYLE_SOURCES.includes(String(source)), `pdf-tool must never claim a platform-only styleSource (${String(source)})`);
  }
});

test("a locked/ignored style is not something pdf-tool can invent: with no style there is no styleSource", async () => {
  // R5 says a locked site means the PLATFORM drops `style` before it ever reaches here. What
  // pdf-tool must guarantee is the other half: given no style, it says nothing at all rather
  // than filling in a site-level answer it cannot have.
  await withFetchStub(async () => {
    const response = await mcpRpc("tools/call", {
      name: "create_agent_artifact_job",
      arguments: { storage: STORAGE, projectId: "dr-lurie", requestId: "req-style-locked", artifactKind: "image", prompt: "hero image", filename: "hero-shot.png" }
    });
    const result = JSON.parse(response.body).result.structuredContent;
    assert.equal("styleSource" in result, false);
    assert.equal("style" in result, false);
  });
});
