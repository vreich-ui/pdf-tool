import { createAgentArtifactJob, getAgentArtifactByFilename, getAgentArtifactBySlot, getAgentArtifactJobStatus, type CreateAgentArtifactJobInput } from "../lib/agent-artifact-mcp.js";
import { createPdfTemplate, getPdfTemplateRecord, listPdfTemplatesResult, publishPdfTemplateRecord, type CreatePdfTemplateInput, type GetPdfTemplateInput, type ListPdfTemplatesInput, type PublishPdfTemplateInput } from "../lib/pdf-template-mcp.js";
import { createImageImportJob, createImageSearchJob, getImageSearchBank, getImageSearchJobStatus, getImageSearchPolicy, importImageFromUrl, setImageSearchPolicy, updateImageSearchCandidate } from "../lib/agent-image-search-mcp.js";
import { getHeader, isAuthorized, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { createMcpSession, deleteMcpSession, negotiateMcpProtocolVersion, readMcpSession, touchMcpSession, type McpSessionRecord } from "../lib/mcp-session.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null; queryStringParameters?: Record<string, string | undefined> | null; path?: string; rawUrl?: string };
type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolName = "create_agent_artifact_job" | "get_agent_artifact_job_status" | "get_agent_artifact_by_slot" | "get_agent_artifact_by_filename" | "create_pdf_template" | "get_pdf_template" | "list_pdf_templates" | "publish_pdf_template" | "search_images" | "get_image_search_job_status" | "get_image_search_bank" | "update_image_search_candidate" | "get_image_search_policy" | "set_image_search_policy" | "import_image_from_url" | "import_images_from_url";

const tools = [
  {
    name: "create_agent_artifact_job",
    description: "Create a server-side artifact generation job. Returns metadata and polling instructions only; never returns image/PDF bytes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "requestId", "artifactKind", "filename"],
      properties: {
        projectId: { type: "string" },
        requestId: { type: "string" },
        artifactKind: { type: "string", enum: ["image", "pdf"] },
        operation: { type: "string", enum: ["generate", "edit"] },
        sourceArtifact: { type: "object", additionalProperties: false, required: ["artifactReference", "expectedSha256"], properties: { artifactReference: { type: "object", additionalProperties: true }, expectedSha256: { type: "string" } } },
        editMode: { type: "string", enum: ["deterministic_transform", "masked_edit", "image_variation", "template_data_patch", "pdf_overlay", "pdf_transform"] },
        baseDataRef: { type: "object", additionalProperties: false, required: ["blobKey"], properties: { storeName: { type: "string" }, blobKey: { type: "string" }, version: { type: "number" } } },
        currentData: { type: "object" },
        dataPatch: { type: "array", items: { type: "object", additionalProperties: true, required: ["op", "path"], properties: { op: { type: "string", enum: ["add", "replace", "remove"] }, path: { type: "string" }, value: {} } } },
        overlayInstructions: { type: "array", items: { type: "object", additionalProperties: true } },
        transformInstructions: { type: "object", additionalProperties: true },
        preservation: { type: "object", additionalProperties: true },
        maskRef: { type: "object", additionalProperties: false, required: ["artifactReference"], properties: { artifactReference: { type: "object", additionalProperties: true } } },
        editInstructions: { type: "object", additionalProperties: false, properties: { change: { type: "string" }, preserve: { type: "array", items: { type: "string" } }, negativeInstructions: { type: "array", items: { type: "string" } } } },
        prompt: { type: "string" },
        filename: { type: "string" },
        templateId: { type: "string" },
        templateRef: {
          type: "object",
          additionalProperties: false,
          properties: {
            storeName: { type: "string" },
            blobKey: { type: "string" },
            version: { type: "number" }
          },
          required: ["blobKey"]
        },
        data: { type: "object" },
        assets: {
          type: "object",
          additionalProperties: false,
          properties: {
            images: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true
              }
            }
          }
        },
        slot: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        label: { type: "string" },
        agentName: { type: "string" },
        promptId: { type: "string" },
        model: { type: "string" },
        requirements: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxBytes: { type: "number" },
            pageCount: {
              type: "object",
              additionalProperties: false,
              properties: {
                min: { type: "number" },
                max: { type: "number" }
              }
            },
            format: {
              type: "string",
              enum: ["A4", "Letter"]
            },
            orientation: {
              type: "string",
              enum: ["portrait", "landscape"]
            },
            margins: {
              type: "object",
              additionalProperties: false,
              properties: {
                top: { type: "string" },
                right: { type: "string" },
                bottom: { type: "string" },
                left: { type: "string" }
              }
            },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                size: { type: "string", enum: ["1024x1024"] },
                outputFormat: { type: "string", enum: ["png", "webp"] },
                role: { type: "string", enum: ["featured"] },
                usageContext: { type: "string", enum: ["article_header", "article_body", "category_page", "newsletter", "open_graph", "search_preview", "instagram_story", "ad_platform"] }
              }
            },
            pdf: {
              type: "object",
              additionalProperties: false,
              properties: {
                pageCount: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    min: { type: "number" },
                    max: { type: "number" }
                  }
                },
                format: {
                  type: "string",
                  enum: ["A4", "Letter"]
                },
                orientation: {
                  type: "string",
                  enum: ["portrait", "landscape"]
                },
                margins: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    top: { type: "string" },
                    right: { type: "string" },
                    bottom: { type: "string" },
                    left: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  {
    name: "get_agent_artifact_job_status",
    description: "Get pending/running/complete/failed status for an artifact job. Completed jobs include the project-native artifactReference metadata only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "jobId"], properties: { projectId: { type: "string" }, jobId: { type: "string" } } }
  },
  {
    name: "get_agent_artifact_by_slot",
    description: "Look up a completed artifact reference by project, request, and slot. Returns metadata only, never binary bytes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "requestId", "slot"], properties: { projectId: { type: "string" }, requestId: { type: "string" }, slot: { type: "string" } } }
  },
  {
    name: "get_agent_artifact_by_filename",
    description: "Look up a completed artifact reference by project, request, and filename. Returns metadata only, never binary bytes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "requestId", "filename"], properties: { projectId: { type: "string" }, requestId: { type: "string" }, filename: { type: "string" } } }
  },
  {
    name: "create_pdf_template",
    description: "Create and store a versioned pdfme PDF template definition. Status starts as draft; use publish_pdf_template to make it active.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "templateJson"],
      properties: {
        projectId: { type: "string" },
        templateId: { type: "string", description: "Stable identifier for this template; auto-generated if omitted" },
        templateJson: { type: "object", additionalProperties: true, description: "pdfme template: must contain basePdf and schemas array" },
        renderer: { type: "string", enum: ["pdfme"] },
        label: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "get_pdf_template",
    description: "Retrieve a stored pdfme PDF template definition. Defaults to the latest active version; pass version to retrieve a specific version.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "templateId"],
      properties: {
        projectId: { type: "string" },
        templateId: { type: "string" },
        version: { type: "number", description: "Specific version number; omit to get the latest active version" }
      }
    }
  },
  {
    name: "list_pdf_templates",
    description: "List all pdfme PDF templates stored for a project, with their latest version, active version, and status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: {
        projectId: { type: "string" }
      }
    }
  },
  {
    name: "publish_pdf_template",
    description: "Publish a pdfme PDF template version, making it the active version used for PDF generation. Defaults to the latest draft version if version is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "templateId"],
      properties: {
        projectId: { type: "string" },
        templateId: { type: "string" },
        version: { type: "number", description: "Specific version to publish; omit to publish the latest version" }
      }
    }
  },
  {
    name: "search_images",
    description: "Start a least-cost image sourcing job: searches the project media library first, then online providers by ascending cost tier, and banks up to five scored candidates per request. Returns job metadata and polling instructions only; never returns image bytes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "requestId", "query"],
      properties: {
        projectId: { type: "string" },
        requestId: { type: "string" },
        query: { type: "string", description: "Search prompt describing the desired image" },
        count: { type: "number", description: "Desired number of new candidates (1-5); defaults to the policy candidateTarget" },
        tags: { type: "array", items: { type: "string" } },
        label: { type: "string" },
        policyOverrides: { type: "object", additionalProperties: true, description: "Partial image sourcing policy merged over the stored project policy for this search only" }
      }
    }
  },
  {
    name: "get_image_search_job_status",
    description: "Get pending/running/complete/failed status for an image search job. Completed jobs include the banked candidate metadata (artifact references, scores, licenses); never image bytes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "jobId"], properties: { projectId: { type: "string" }, jobId: { type: "string" } } }
  },
  {
    name: "get_image_search_bank",
    description: "Read the per-request image selection bank: all candidates across searches with states, scores, licenses, and artifact references. Metadata only, never image bytes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "requestId"], properties: { projectId: { type: "string" }, requestId: { type: "string" } } }
  },
  {
    name: "update_image_search_candidate",
    description: "Update a banked candidate's state: selected (agent's choice), kept, pending_review, or discarded. Discarding with deleteArtifact=true also deletes the imported blob bytes; library-origin artifacts are never deleted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "requestId", "candidateId", "state"],
      properties: {
        projectId: { type: "string" },
        requestId: { type: "string" },
        candidateId: { type: "string" },
        state: { type: "string", enum: ["kept", "pending_review", "selected", "discarded"] },
        reason: { type: "string" },
        deleteArtifact: { type: "boolean" }
      }
    }
  },
  {
    name: "import_image_from_url",
    description: "Import a single image from an https URL into the project artifact Blob store, bank it as a url_import candidate, and synchronously return its ArtifactReference plus candidateId. Non-native formats (gif, tiff, avif, ...) are converted to png/jpeg. For zip archives, folder pages, or multiple URLs use import_images_from_url. Never returns image bytes; rights clearance for direct imports is the caller's responsibility.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "requestId", "url"],
      properties: {
        projectId: { type: "string" },
        requestId: { type: "string" },
        url: { type: "string", description: "https URL of the image to import" },
        filename: { type: "string", description: "Optional target filename; derived from the URL if omitted" },
        slot: { type: "string", description: "Optional safe slot so the artifact is retrievable via get_agent_artifact_by_slot" },
        tags: { type: "array", items: { type: "string" } },
        label: { type: "string" },
        license: {
          type: "object",
          additionalProperties: false,
          description: "Caller-asserted license recorded in artifact metadata; defaults to unknown",
          properties: {
            class: { type: "string", enum: ["public-domain", "permissive", "paid", "unknown"] },
            name: { type: "string" },
            url: { type: "string" },
            attribution: { type: "string" },
            commercialUse: { type: ["boolean", "string"] }
          }
        },
        maxBytes: { type: "number", description: "Optional byte cap for the stored image (max 5000000)" }
      }
    }
  },
  {
    name: "import_images_from_url",
    description: "Start a batch url-import job: each source URL may be a direct image, a zip archive of images, or an https folder/index page (same-host images are collected). Every imported image is saved to the project artifact Blob store and banked as a url_import candidate; bounded by policy quotas (default 20 per batch, 50 per request). Returns job metadata and polling instructions; results include ArtifactReferences, never bytes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "requestId", "urls"],
      properties: {
        projectId: { type: "string" },
        requestId: { type: "string" },
        urls: { type: "array", items: { type: "string" }, description: "https URLs: direct images, zip archives, or folder/index pages (max 50)" },
        tags: { type: "array", items: { type: "string" } },
        label: { type: "string" },
        license: {
          type: "object",
          additionalProperties: false,
          description: "Caller-asserted license applied to all imported images; defaults to unknown",
          properties: {
            class: { type: "string", enum: ["public-domain", "permissive", "paid", "unknown"] },
            name: { type: "string" },
            url: { type: "string" },
            attribution: { type: "string" },
            commercialUse: { type: ["boolean", "string"] }
          }
        },
        policyOverrides: { type: "object", additionalProperties: true, description: "Partial image sourcing policy (e.g. quotas.maxUrlImportsPerBatch) merged for this job only" }
      }
    }
  },
  {
    name: "get_image_search_policy",
    description: "Read the project's effective image sourcing policy JSON (stored policy merged over defaults): candidate targets, provider tiers, license rules, scoring weights, budgets, and quotas.",
    inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } }
  },
  {
    name: "set_image_search_policy",
    description: "Replace the project's stored image sourcing policy with the given partial policy (validated, merged over defaults). Candidate caps are clamped to five per request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "policy"],
      properties: {
        projectId: { type: "string" },
        policy: { type: "object", additionalProperties: true, description: "Partial ImageSourcingPolicy JSON" }
      }
    }
  }
] as const;

function requestBaseUrl(event: FunctionEvent): string | undefined {
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;
  if (process.env.URL) return process.env.URL;
  const origin = getHeader(event.headers, "origin");
  if (origin) return origin;
  const host = getHeader(event.headers, "host");
  return host ? `https://${host}` : undefined;
}

// CORS enables browser-based MCP clients (e.g. MCP Inspector); auth is still enforced.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id"
} as const;

function mcpJsonResponse(statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...CORS_HEADERS, ...extraHeaders };
  return { statusCode, headers, body: JSON.stringify(body) };
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown, statusCode = 200, extraHeaders: Record<string, string> = {}) {
  return mcpJsonResponse(statusCode, { jsonrpc: "2.0", id: id ?? null, result }, extraHeaders);
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown, statusCode = 200) {
  return mcpJsonResponse(statusCode, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function emptyResponse(statusCode = 204, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...CORS_HEADERS, ...extraHeaders };
  return { statusCode, headers, body: "" };
}

function hasRequestId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

const CONNECTOR_KEY_PATH_PATTERN = /^\/(?:\.netlify\/functions\/)?mcp\/(.+?)\/?$/;

/** The connector key may arrive as a `?key=` query param or as a path suffix — the
 * `/mcp/<key>` alias rewrites to `/.netlify/functions/mcp/<key>`, and depending on the
 * routing layer the function may see either the rewritten or the original path. */
export function connectorKeyFromEvent(event: FunctionEvent): string | undefined {
  const queryKey = event.queryStringParameters?.key;
  if (queryKey) return queryKey;
  for (const candidate of [event.path, event.rawUrl ? safePathname(event.rawUrl) : undefined]) {
    const match = candidate?.match(CONNECTOR_KEY_PATH_PATTERN);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return undefined;
}

function safePathname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return undefined;
  }
}

/** Bearer token (Authorization header) or the URL connector key, for clients like
 * claude.ai custom connectors that cannot send custom headers. The connector key is a
 * separate secret from AGENT_RUN_TOKEN so it can be rotated alone, and is inert unless
 * MCP_CONNECTOR_KEY is configured. */
function isAuthorizedMcpRequest(event: FunctionEvent): boolean {
  if (isAuthorized(getHeader(event.headers, "authorization"))) return true;
  const connectorKey = connectorKeyFromEvent(event);
  if (connectorKey && process.env.MCP_CONNECTOR_KEY) {
    return isAuthorized(`Bearer ${connectorKey}`, process.env.MCP_CONNECTOR_KEY);
  }
  return false;
}

const SERVER_INSTRUCTIONS = "Session-aware Netlify Streamable-HTTP MCP endpoint for server-side artifact generation (images, PDFs, templates, image search/import). On initialize the server issues an Mcp-Session-Id header; send it on every subsequent request and send an HTTP DELETE with it to end the session. All tool results are metadata-only ArtifactReferences; binary bytes never travel through MCP.";

type SessionCheck = { ok: true; session?: McpSessionRecord } | { ok: false; response: ReturnType<typeof rpcError> };

async function checkSession(event: FunctionEvent, request: JsonRpcRequest): Promise<SessionCheck> {
  const sessionId = getHeader(event.headers, "mcp-session-id");
  if (!sessionId) {
    if (process.env.MCP_REQUIRE_SESSION === "1") {
      return { ok: false, response: rpcError(request.id, -32000, "Mcp-Session-Id header is required; call initialize first", undefined, 400) };
    }
    return { ok: true };
  }
  const session = await readMcpSession(sessionId);
  if (!session) {
    // 404 tells Streamable-HTTP clients the session expired: start a new one via initialize.
    return { ok: false, response: rpcError(request.id, -32001, "Session not found or expired; re-initialize", undefined, 404) };
  }
  // Best-effort idle-timer refresh; a transient store failure must not fail the request.
  try {
    await touchMcpSession(session);
  } catch (error) {
    console.error("MCP session refresh failed; proceeding:", error instanceof Error ? error.message : error);
  }
  return { ok: true, session };
}

function toolContent(structuredContent: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

async function callTool(name: string | undefined, args: unknown, event: FunctionEvent) {
  switch (name as ToolName) {
    case "create_agent_artifact_job": {
      const result = await createAgentArtifactJob(args as CreateAgentArtifactJobInput, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "get_agent_artifact_job_status": {
      const result = await getAgentArtifactJobStatus(args as never);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "get_agent_artifact_by_slot": {
      const result = await getAgentArtifactBySlot(args as never);
      const { statusCode: _statusCode, ok, artifact, ...body } = result;
      const structured = ok ? { ...body, artifactReference: artifact } : body;
      return ok ? toolContent(structured) : { isError: true, ...toolContent(structured) };
    }
    case "get_agent_artifact_by_filename": {
      const result = await getAgentArtifactByFilename(args as never);
      const { statusCode: _statusCode, ok, artifact, ...body } = result;
      const structured = ok ? { ...body, artifactReference: artifact } : body;
      return ok ? toolContent(structured) : { isError: true, ...toolContent(structured) };
    }
    case "create_pdf_template": {
      const result = await createPdfTemplate(args as CreatePdfTemplateInput);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "get_pdf_template": {
      const result = await getPdfTemplateRecord(args as GetPdfTemplateInput);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "list_pdf_templates": {
      const result = await listPdfTemplatesResult(args as ListPdfTemplatesInput);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "publish_pdf_template": {
      const result = await publishPdfTemplateRecord(args as PublishPdfTemplateInput);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "search_images": {
      const result = await createImageSearchJob(args, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "get_image_search_job_status": {
      const result = await getImageSearchJobStatus(args as never);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "get_image_search_bank": {
      const result = await getImageSearchBank(args as never);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "update_image_search_candidate": {
      const result = await updateImageSearchCandidate(args as never);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "import_image_from_url": {
      const result = await importImageFromUrl(args);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "import_images_from_url": {
      const result = await createImageImportJob(args, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "get_image_search_policy": {
      const result = await getImageSearchPolicy(args as never);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    case "set_image_search_policy": {
      const result = await setImageSearchPolicy(args as never);
      const { statusCode: _statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : { isError: true, ...toolContent(body) };
    }
    default:
      return undefined;
  }
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod === "OPTIONS") return emptyResponse(204);

  if (event.httpMethod === "DELETE") {
    if (!isAuthorizedMcpRequest(event)) return rpcError(null, -32001, "Unauthorized", undefined, 401);
    const sessionId = getHeader(event.headers, "mcp-session-id");
    if (!sessionId) return rpcError(null, -32000, "Mcp-Session-Id header is required to end a session", undefined, 400);
    const deleted = await deleteMcpSession(sessionId);
    if (!deleted) return rpcError(null, -32001, "Session not found or expired", undefined, 404);
    return emptyResponse(204);
  }

  if (event.httpMethod !== "POST") {
    // No standalone SSE stream is offered; per Streamable-HTTP, GET gets 405 + Allow.
    return mcpJsonResponse(405, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP endpoint requires POST" } }, { allow: "POST, DELETE, OPTIONS" });
  }

  const request = parseJsonBody<JsonRpcRequest>(event.body);
  if (!request || typeof request !== "object") return rpcError(null, -32700, "Parse error", undefined, 400);
  if (!isAuthorizedMcpRequest(event)) return rpcError(request.id, -32001, "Unauthorized", undefined, 401);

  if (request.method === "initialize") {
    const params = request.params ?? {};
    const protocolVersion = negotiateMcpProtocolVersion(params.protocolVersion);
    const clientInfo = params.clientInfo && typeof params.clientInfo === "object" ? params.clientInfo as { name?: string; version?: string } : undefined;
    // Session persistence is an enhancement, not a hard dependency: if the session store is
    // unavailable (e.g. Blobs misconfigured), degrade to a stateless session rather than
    // failing the whole connection with a 502. The endpoint already supports sessionless use.
    let sessionHeaders: Record<string, string> = {};
    try {
      const session = await createMcpSession(protocolVersion, clientInfo);
      sessionHeaders = { "mcp-session-id": session.sessionId };
    } catch (error) {
      console.error("MCP session creation failed; continuing statelessly:", error instanceof Error ? error.message : error);
    }
    return rpcResult(request.id, {
      protocolVersion,
      serverInfo: { name: "pdf-tool-agent-artifacts", version: "0.2.0" },
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS
    }, 200, sessionHeaders);
  }

  const sessionCheck = await checkSession(event, request);
  if (!sessionCheck.ok) return sessionCheck.response;

  if (request.method === "ping") return rpcResult(request.id, {});
  if (request.method === "notifications/initialized") {
    return hasRequestId(request) ? rpcResult(request.id, {}) : emptyResponse();
  }
  if (typeof request.method === "string" && request.method.startsWith("notifications/") && !hasRequestId(request)) {
    // Tolerate unknown notifications (cancelled, progress, ...) instead of erroring.
    return emptyResponse();
  }
  if (request.method === "tools/list") return rpcResult(request.id, { tools });
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const result = await callTool(typeof params.name === "string" ? params.name : undefined, params.arguments ?? {}, event);
    if (!result) return rpcError(request.id, -32602, "Unknown tool", { tool: params.name });
    return rpcResult(request.id, result);
  }
  return rpcError(request.id, -32601, "Method not found", { method: request.method });
}
