import { createAgentArtifactJob, getAgentArtifactByFilename, getAgentArtifactBySlot, getAgentArtifactJobStatus, type CreateAgentArtifactJobInput } from "../lib/agent-artifact-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };
type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolName = "create_agent_artifact_job" | "get_agent_artifact_job_status" | "get_agent_artifact_by_slot" | "get_agent_artifact_by_filename";

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

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return jsonResponse(200, { jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown, statusCode = 200) {
  return jsonResponse(statusCode, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function emptyResponse(statusCode = 204) {
  return { statusCode, headers: { "content-type": "application/json" }, body: "" };
}

function hasRequestId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
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
    default:
      return undefined;
  }
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return rpcError(null, -32600, "MCP endpoint requires POST", undefined, 405);
  const request = parseJsonBody<JsonRpcRequest>(event.body);
  if (!request || typeof request !== "object") return rpcError(null, -32700, "Parse error", undefined, 400);
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return rpcError(request.id, -32001, "Unauthorized", undefined, 401);

  if (request.method === "initialize") {
    return rpcResult(request.id, { protocolVersion: "2024-11-05", serverInfo: { name: "pdf-tool-agent-artifacts", version: "0.1.0" }, capabilities: { tools: {} } });
  }
  if (request.method === "notifications/initialized") {
    return hasRequestId(request) ? rpcResult(request.id, {}) : emptyResponse();
  }
  if (request.method === "ping") return rpcResult(request.id, {});
  if (request.method === "tools/list") return rpcResult(request.id, { tools });
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const result = await callTool(typeof params.name === "string" ? params.name : undefined, params.arguments ?? {}, event);
    if (!result) return rpcError(request.id, -32602, "Unknown tool", { tool: params.name });
    return rpcResult(request.id, result);
  }
  return rpcError(request.id, -32601, "Method not found", { method: request.method });
}
