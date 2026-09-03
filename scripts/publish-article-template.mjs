#!/usr/bin/env node
/**
 * D2: create -> validate -> poll -> publish `templates/article_brochure_v1.json`
 * (the generic chromium article template) for one tenant, over pdf-tool's MCP endpoint
 * (netlify/functions/mcp.ts — a session-aware JSON-RPC 2.0 / Streamable-HTTP surface).
 * This is the W7 config-session script named in BRIEF.md 3.6/D2: it is meant to be run once
 * per tenant when that tenant's pdf-tool instance is provisioned (and safely re-run any
 * time the fixture in templates/article_brochure_v1.json changes).
 *
 * Usage:
 *   node scripts/publish-article-template.mjs --tenant <slug> [--dry-run] [--project-id <id>]
 *
 * Required environment (a caller-supplied Netlify Blobs storage grant — pdf-tool holds no
 * storage credentials of its own, see storage-grant.ts / the STORAGE_GRANT_SCHEMA in mcp.ts):
 *   PDF_TOOL_MCP_URL          Full URL to the deployed /mcp endpoint
 *                             (e.g. https://<tenant-site>.netlify.app/mcp). Falls back to
 *                             `${PDF_TOOL_BASE_URL}/mcp` when only PDF_TOOL_BASE_URL is set.
 *   PDF_TOOL_AGENT_RUN_TOKEN  Bearer token accepted by isAuthorized() (AGENT_RUN_TOKEN on
 *                             the server side).
 *   PDF_TOOL_STORAGE_SITE_ID  Netlify siteId owning the tenant's Blob stores.
 *   PDF_TOOL_STORAGE_TOKEN    Netlify Blobs token for that site.
 * Optional:
 *   PDF_TOOL_STORAGE_GRANT_TYPE  Defaults to "netlify-pat" (the only grantType pdf-tool
 *                                 implements today).
 *   --project-id <id>            Overrides the projectId sent with every call; defaults to
 *                                 the --tenant slug (the common case: tenant slug === project
 *                                 id). Use this when a tenant's pdf-tool projectId differs
 *                                 from its human-readable slug.
 *
 * --dry-run prints the request bodies this script WOULD send (create/validate/publish) and
 * exits 0 without making any network call — useful for reviewing the exact payload, or for
 * environments (like this one) with no deployed pdf-tool instance to talk to.
 *
 * Idempotency ("safe to re-run"): before creating a new template version, the script fetches
 * the tenant's current latest version (if any) of templateId "article_brochure_v1" and
 * deep-compares its stored templateJson/renderDataSchema/sampleData against the fixture on
 * disk. If they already match, it skips straight to publish_pdf_template (itself a no-op
 * publish when that version is already the active one) instead of minting a pointless new
 * version on every run. Only a genuine content change (this file was edited) creates a new
 * version, which then goes through validate -> poll -> publish like a first run.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TEMPLATE_ID = "article_brochure_v1";
const FIXTURE_PATH = path.join(REPO_ROOT, "templates", `${TEMPLATE_ID}.json`);

const VALIDATION_POLL_INTERVAL_MS = 2000;
const VALIDATION_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { tenant: undefined, projectId: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tenant") {
      args.tenant = argv[++i];
    } else if (arg === "--project-id") {
      args.projectId = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/publish-article-template.mjs --tenant <slug> [--dry-run] [--project-id <id>]",
      "",
      "Creates/updates and publishes the article_brochure_v1 chromium PDF template for one tenant.",
      "See the header comment in this file for the required environment variables.",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function loadFixture() {
  let raw;
  try {
    raw = readFileSync(FIXTURE_PATH, "utf8");
  } catch (error) {
    throw new Error(`Could not read template fixture at ${FIXTURE_PATH}: ${error.message}`);
  }
  const parsed = JSON.parse(raw);
  for (const field of ["templateId", "kind", "label", "tags", "renderer", "templateJson", "renderDataSchema", "sampleData", "sampleAssets"]) {
    if (!(field in parsed)) throw new Error(`Template fixture is missing required field "${field}"`);
  }
  if (parsed.templateId !== TEMPLATE_ID) {
    throw new Error(`Template fixture templateId is "${parsed.templateId}", expected "${TEMPLATE_ID}"`);
  }
  return parsed;
}

// deep, key-order-independent structural equality for plain JSON values
function jsonEquals(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => jsonEquals(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(args) {
  if (!args.tenant) throw new Error("--tenant <slug> is required");

  const mcpUrl = process.env.PDF_TOOL_MCP_URL || (process.env.PDF_TOOL_BASE_URL ? `${process.env.PDF_TOOL_BASE_URL.replace(/\/+$/, "")}/mcp` : undefined);
  const authToken = process.env.PDF_TOOL_AGENT_RUN_TOKEN;
  const siteId = process.env.PDF_TOOL_STORAGE_SITE_ID;
  const blobsToken = process.env.PDF_TOOL_STORAGE_TOKEN;
  const grantType = process.env.PDF_TOOL_STORAGE_GRANT_TYPE || "netlify-pat";

  const missing = [];
  if (!mcpUrl) missing.push("PDF_TOOL_MCP_URL (or PDF_TOOL_BASE_URL)");
  if (!authToken) missing.push("PDF_TOOL_AGENT_RUN_TOKEN");
  if (!siteId) missing.push("PDF_TOOL_STORAGE_SITE_ID");
  if (!blobsToken) missing.push("PDF_TOOL_STORAGE_TOKEN");
  if (missing.length > 0 && !args.dryRun) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")} (run with --dry-run to inspect the payload without them)`);
  }

  const projectId = args.projectId || args.tenant;

  return {
    tenant: args.tenant,
    projectId,
    mcpUrl,
    authToken,
    storage: { grantType, projectId, siteId, token: blobsToken },
  };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC client
// ---------------------------------------------------------------------------

class McpClient {
  constructor({ mcpUrl, authToken }) {
    this.mcpUrl = mcpUrl;
    this.authToken = authToken;
    this.sessionId = undefined;
    this.nextId = 1;
  }

  async initialize() {
    const response = await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "publish-article-template", version: "1.0.0" } },
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize did not return an Mcp-Session-Id header");
    this.sessionId = sessionId;
    const body = await response.json();
    if (body.error) throw new Error(`MCP initialize failed: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async callTool(name, args) {
    if (!this.sessionId) throw new Error("callTool before initialize()");
    const response = await this.#post(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } },
      { "mcp-session-id": this.sessionId }
    );
    const body = await response.json();
    if (body.error) throw new Error(`MCP transport error calling ${name}: ${JSON.stringify(body.error)}`);
    const result = body.result;
    if (result?.isError) {
      const text = result.content?.[0]?.text;
      throw new Error(`Tool ${name} returned an error: ${text ?? JSON.stringify(result)}`);
    }
    // Prefer structuredContent (what every arm in mcp.ts's callTool sets); fall back to
    // parsing the first text content block for older/alternate shapes.
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }
    return result;
  }

  async close() {
    if (!this.sessionId) return;
    await fetch(this.mcpUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.authToken}`, "mcp-session-id": this.sessionId },
    }).catch(() => {});
  }

  async #post(body, extraHeaders = {}) {
    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.authToken}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 200) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP endpoint returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return response;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function findExistingTemplate(client, config) {
  const list = await client.callTool("list_pdf_templates", {
    projectId: config.projectId,
    storage: config.storage,
    includeArchived: true,
  });
  const entry = (list.templates ?? []).find((t) => t.templateId === TEMPLATE_ID);
  if (!entry) return undefined;
  const record = await client.callTool("get_pdf_template", {
    projectId: config.projectId,
    templateId: TEMPLATE_ID,
    version: entry.latestVersion,
    storage: config.storage,
  });
  return record;
}

function contentUnchanged(existingRecord, fixture) {
  if (!existingRecord) return false;
  if (!jsonEquals(existingRecord.templateJson, fixture.templateJson)) return false;
  // Pre-D1 deployments never stored renderDataSchema/sampleData on the record at all (see
  // the create_pdf_template fallback above) -- don't treat that absence as "changed" on
  // every single re-run, or this script would mint a pointless new version every time it
  // runs against such a deployment. Once a deployment DOES report these fields, hold it to
  // matching them exactly.
  if ("renderDataSchema" in existingRecord && !jsonEquals(existingRecord.renderDataSchema, fixture.renderDataSchema)) return false;
  if ("sampleData" in existingRecord && !jsonEquals(existingRecord.sampleData, fixture.sampleData)) return false;
  if ("sampleAssets" in existingRecord && !jsonEquals(existingRecord.sampleAssets, fixture.sampleAssets)) return false;
  return true;
}

const BASE_TEMPLATE_FIELDS = ["projectId", "templateId", "templateJson", "renderer", "label", "tags", "storage"];
const EXTRA_TEMPLATE_FIELDS = ["kind", "renderDataSchema", "sampleData", "sampleAssets"];

/** True for the specific zod .strict() rejection an MCP tool schema raises when it does not
 * yet recognize a key -- i.e. exactly the shape create_pdf_template returns today, before D1
 * (concurrent) adds kind/renderDataSchema/sampleData/sampleAssets to its schema. Any OTHER error (auth,
 * storage, a genuine validation problem in templateJson itself, ...) is not swallowed. */
function isUnrecognizedKeyError(error, keys) {
  const message = error instanceof Error ? error.message : String(error);
  return /Unrecognized key\(s\)/.test(message) && keys.some((key) => message.includes(`'${key}'`));
}

async function createTemplate(client, config, fixture) {
  const fullArgs = {
    projectId: config.projectId,
    templateId: fixture.templateId,
    templateJson: fixture.templateJson,
    renderer: fixture.renderer,
    label: fixture.label,
    tags: fixture.tags,
    // kind/renderDataSchema/sampleData/sampleAssets are template-record fields D1 (concurrent, same
    // wave) is adding to create_pdf_template's schema -- see BRIEF.md 3.6. Send them
    // optimistically so a run AFTER D1 lands attaches them in one call; a run BEFORE it
    // lands (this container today) falls back below rather than failing outright, so this
    // script works regardless of merge order and stays safe to re-run either way.
    kind: fixture.kind,
    renderDataSchema: fixture.renderDataSchema,
    sampleData: fixture.sampleData,
    // The images sampleData references. Without them the publish-time thumbnail worker has
    // nothing to resolve `coverImage` / `brand.logo` / section figures against and the
    // stored preview renders with broken images.
    sampleAssets: fixture.sampleAssets,
    storage: config.storage,
  };
  try {
    const result = await client.callTool("create_pdf_template", fullArgs);
    console.log(`created ${TEMPLATE_ID} v${result.version} (renderer=${result.renderer}, rendererSource=${result.rendererSource ?? "n/a"}, kind/renderDataSchema/sampleData/sampleAssets attached)`);
    return result;
  } catch (error) {
    if (!isUnrecognizedKeyError(error, EXTRA_TEMPLATE_FIELDS)) throw error;
    console.warn(
      `create_pdf_template does not yet accept kind/renderDataSchema/sampleData/sampleAssets on this deployment (D1 not merged here yet) -- ` +
        `retrying with only ${BASE_TEMPLATE_FIELDS.join(", ")}. Re-run this script after D1 ships to attach them.`
    );
    const baseArgs = Object.fromEntries(Object.entries(fullArgs).filter(([key]) => BASE_TEMPLATE_FIELDS.includes(key)));
    const result = await client.callTool("create_pdf_template", baseArgs);
    console.log(`created ${TEMPLATE_ID} v${result.version} (renderer=${result.renderer}, rendererSource=${result.rendererSource ?? "n/a"}, kind/renderDataSchema/sampleData/sampleAssets NOT attached)`);
    return result;
  }
}

async function runValidation(client, config, version, fixture) {
  const started = await client.callTool("validate_pdf_template", {
    projectId: config.projectId,
    templateId: TEMPLATE_ID,
    version,
    data: fixture.sampleData,
    requirements: { format: "A4" },
    storage: config.storage,
  });
  console.log(`validation started: ${started.validationId} (status=${started.status})`);

  const deadline = Date.now() + VALIDATION_POLL_TIMEOUT_MS;
  for (;;) {
    const report = await client.callTool("get_pdf_template_validation", {
      projectId: config.projectId,
      templateId: TEMPLATE_ID,
      version,
      storage: config.storage,
    });
    if (report.status === "passed") {
      console.log(`validation passed (dataSha256=${report.dataSha256 ?? "n/a"})`);
      return report;
    }
    if (report.status === "failed") {
      throw new Error(`validation FAILED for v${version}: ${JSON.stringify(report.requirementFailures ?? report.error ?? report)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`validation for v${version} did not finish within ${VALIDATION_POLL_TIMEOUT_MS}ms (last status: ${report.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, VALIDATION_POLL_INTERVAL_MS));
  }
}

async function publishTemplate(client, config, version) {
  const result = await client.callTool("publish_pdf_template", {
    projectId: config.projectId,
    templateId: TEMPLATE_ID,
    version,
    storage: config.storage,
  });
  console.log(`published ${TEMPLATE_ID} v${result.version} (status=${result.status})`);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const fixture = loadFixture();
  const config = loadConfig(args);

  if (args.dryRun) {
    console.log("--dry-run: no network calls will be made. Payloads that WOULD be sent:\n");
    console.log(
      "create_pdf_template:",
      JSON.stringify(
        { projectId: config.projectId, templateId: fixture.templateId, renderer: fixture.renderer, kind: fixture.kind, label: fixture.label, tags: fixture.tags },
        null,
        2
      )
    );
    console.log("\nvalidate_pdf_template.data === sampleData (", Object.keys(fixture.sampleData).length, "top-level keys )");
    console.log("\nrenderDataSchema $id:", fixture.renderDataSchema.$id);
    return;
  }

  const client = new McpClient(config);
  try {
    await client.initialize();
    console.log(`initialized MCP session for tenant "${config.tenant}" (projectId=${config.projectId})`);

    const existing = await findExistingTemplate(client, config);
    if (contentUnchanged(existing, fixture)) {
      console.log(`${TEMPLATE_ID} v${existing.version} already matches the fixture on disk; skipping create.`);
      if (existing.status === "active") {
        console.log(`${TEMPLATE_ID} v${existing.version} is already active; nothing to do.`);
        return;
      }
      // Chromium has a HARD publish gate: publishing requires a PASSED validation report
      // for this EXACT version (pdf-template-store.ts). "Unchanged" only means we can skip
      // re-creating the version -- it does NOT mean a passed report already exists (the
      // template may have been created but never validated, or a previous validation may
      // have failed/errored, e.g. transiently). Check before deciding to skip validation.
      const existingReport = await client
        .callTool("get_pdf_template_validation", { projectId: config.projectId, templateId: TEMPLATE_ID, version: existing.version, storage: config.storage })
        .catch(() => undefined);
      if (existingReport?.status === "passed") {
        console.log(`${TEMPLATE_ID} v${existing.version} already has a passed validation report; skipping straight to publish.`);
        await publishTemplate(client, config, existing.version);
      } else {
        console.log(`${TEMPLATE_ID} v${existing.version} has no passed validation report (status: ${existingReport?.status ?? "none"}); (re-)validating.`);
        await runValidation(client, config, existing.version, fixture);
        await publishTemplate(client, config, existing.version);
      }
      return;
    }

    const created = await createTemplate(client, config, fixture);
    await runValidation(client, config, created.version, fixture);
    await publishTemplate(client, config, created.version);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`publish-article-template failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
