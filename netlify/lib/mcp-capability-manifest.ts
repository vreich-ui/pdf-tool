import { MCP_TOOL_SCHEMAS, type McpToolName } from "./mcp-tool-schemas.js";

/**
 * S4: the machine-readable capability manifest (§ "prior-plan sweep — highest-value
 * addition"). CMS-Agent's R-8 finding: `article_body`'s `requiredPdfToolCapabilities` enum
 * was generalized away, leaving a 14-tool allow-list hand-kept with nothing declaring what
 * is actually required — "exactly the condition that caused the original pdf-tool
 * regression." pdf-tool is the only party that can fix that at the root by publishing what
 * it offers; a caller then diffs its own allow-list against this instead of hand-maintaining
 * one from memory. The `health` MCP tool is this manifest's natural home (see mcp.ts).
 *
 * Each capability names the tools a caller needs to exercise one coherent flow end to end
 * (requiredTools) plus tools that round it out but aren't load-bearing (optionalTools).
 * `advisories` calls out KNOWN allow-list gaps flagged in the S4 roadmap section so a caller
 * diffing against this manifest sees them explicitly rather than discovering them by
 * failure — this is flagged TO CMS-Agent, not fixed here (it's a client-side allow-list
 * edit, not a pdf-tool bug).
 */

export interface McpCapability {
  id: string;
  description: string;
  requiredTools: McpToolName[];
  optionalTools: McpToolName[];
}

export const MCP_CAPABILITY_MANIFEST_VERSION = "capability-manifest-v1";

export const MCP_CAPABILITIES: McpCapability[] = [
  {
    id: "artifact_generation_image",
    description: "Generate or edit an image artifact and retrieve it once complete.",
    requiredTools: ["create_agent_artifact_job", "get_agent_artifact_job_status", "get_agent_artifact_by_slot", "get_agent_artifact_by_filename"],
    // shrink_artifact (S4b, not yet landed) belongs here once it ships.
    optionalTools: ["verify_agent_artifact", "resume_agent_artifact_job", "get_image_model_policy", "set_image_model_policy"]
  },
  {
    id: "artifact_generation_pdf",
    description: "Render a PDF artifact from a stored template and retrieve it once complete.",
    requiredTools: ["create_agent_artifact_job", "get_agent_artifact_job_status", "get_pdf_template", "list_pdf_templates"],
    optionalTools: ["verify_agent_artifact", "resume_agent_artifact_job", "get_agent_artifact_by_slot", "get_agent_artifact_by_filename"]
  },
  {
    id: "template_lifecycle",
    description: "Author, validate, publish, and version PDF templates.",
    requiredTools: ["create_pdf_template", "get_pdf_template", "list_pdf_templates", "publish_pdf_template"],
    optionalTools: ["validate_pdf_template", "get_pdf_template_validation"]
  },
  {
    id: "image_sourcing",
    description: "Search, import, and curate a per-request bank of candidate images.",
    requiredTools: ["search_images", "get_image_search_job_status", "get_image_search_bank", "update_image_search_candidate"],
    optionalTools: ["import_image_from_url", "import_images_from_url", "get_image_search_policy", "set_image_search_policy"]
  },
  {
    id: "site_capture",
    description: "Crawl a policy-bounded site into a snapshot.v1 + screenshots artifact set (T12.8 capture plane; drafts only, never publish/release/deploy).",
    requiredTools: ["create_capture_job", "get_capture_job_status"],
    optionalTools: ["get_agent_artifact_by_filename", "verify_agent_artifact"]
  },
  {
    id: "operator_approval",
    description: "Resume a job that is blocked awaiting human approval before it generates.",
    requiredTools: ["resume_agent_artifact_job"],
    optionalTools: ["create_agent_artifact_job", "get_agent_artifact_job_status"]
  },
  {
    id: "session_grant",
    description: "Attach a storage grant to the MCP session once instead of on every call.",
    requiredTools: ["set_storage_grant"],
    optionalTools: []
  },
  {
    id: "diagnostics",
    description: "Confirm the server is reachable and discover its capabilities before relying on it.",
    requiredTools: ["health"],
    optionalTools: []
  }
];

export interface McpCapabilityAdvisory {
  tool: McpToolName;
  message: string;
}

/** Known caller-side allow-list gaps (S4 roadmap, prior-plan sweep, CMS-Agent R-8). These
 * are NOT pdf-tool bugs — they are edits a caller needs to make to its own allow-list — but
 * surfacing them here is what stops them from recurring silently the way R-8 did. */
export const MCP_CAPABILITY_ADVISORIES: McpCapabilityAdvisory[] = [
  {
    tool: "resume_agent_artifact_job",
    message: "Commonly missing from caller allow-lists even though create_agent_artifact_job is present. Without it, a job that blocks awaiting operator approval (requireApproval) cannot be resumed — allow this tool wherever create_agent_artifact_job is allowed."
  },
  {
    tool: "get_image_model_policy",
    message: "Commonly missing from caller allow-lists even though model routing reads from it. Without it, callers can't discover which model an image job will actually route to before creating it."
  }
];

export function listMcpToolNames(): McpToolName[] {
  return Object.keys(MCP_TOOL_SCHEMAS) as McpToolName[];
}

export interface McpCapabilityManifest {
  manifestVersion: string;
  server: { name: string; version: string };
  tools: McpToolName[];
  capabilities: McpCapability[];
  advisories: McpCapabilityAdvisory[];
}

export function buildCapabilityManifest(server: { name: string; version: string }): McpCapabilityManifest {
  return {
    manifestVersion: MCP_CAPABILITY_MANIFEST_VERSION,
    server,
    tools: listMcpToolNames(),
    capabilities: MCP_CAPABILITIES,
    advisories: MCP_CAPABILITY_ADVISORIES
  };
}
