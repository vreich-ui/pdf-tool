import { sha256Hex } from "./artifact-core/index.js";
import type { ArtifactJobRecord } from "./agent-artifact-jobs.js";
import { generateImageArtifactBytes, type GeneratedImageBytes, type ImageGenerationClient } from "./agent-image-generation.js";
import { editImageArtifactBytes, readSourceArtifactBytes, contentTypeForImageOutputFormat, type ImageEditingClient } from "./agent-image-editing.js";

export interface AgentArtifactWorkflowOptions {
  imageClient?: ImageGenerationClient & ImageEditingClient;
  apiKey?: string;
  agentSdk?: AgentSdkModule;
}

export type ImageOutputFormat = "png" | "jpeg" | "webp";

export interface AgentArtifactWorkflowResult extends GeneratedImageBytes {
  workflowExecuted: true;
  toolInvoked: "generate_image_artifact" | "edit_image_artifact";
}

type AgentSdkModule = {
  Agent?: new (input: Record<string, unknown>) => unknown;
  Runner?: new () => { run?: (agent: unknown, input: string) => Promise<unknown> };
  tool?: (input: Record<string, unknown>) => unknown;
};


export function imageOutputFormatFromFilename(filename: string): ImageOutputFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  return "png";
}

async function loadAgentSdk(provided?: AgentSdkModule): Promise<AgentSdkModule> {
  if (provided) return provided;
  if (process.env.AGENT_ARTIFACT_TEST_AGENT_SDK === "1") {
    return {};
  }
  return await import("@openai/agents") as AgentSdkModule;
}

function createImageGenerationTool(agents: AgentSdkModule, toolHandler: () => Promise<{ ok: true; contentType: GeneratedImageBytes["contentType"]; size: number; sha256Preview: string }>): unknown {
  const definition = {
    name: "generate_image_artifact",
    description: "Generate one image artifact and return server-side byte metadata only. Never pass bytes through MCP.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    execute: toolHandler
  };

  return typeof agents.tool === "function" ? agents.tool(definition) : definition;
}

async function runAgentSdkWorkflow(job: ArtifactJobRecord, agents: AgentSdkModule, imageTool: unknown): Promise<void> {
  if (!agents.Agent || !agents.Runner) {
    return;
  }

  const agent = new agents.Agent({
    name: "Artifact Generation Agent",
    instructions: "Use the generate_image_artifact tool exactly once for image artifacts. Do not handle article content or pass bytes through MCP.",
    tools: [imageTool]
  });
  const runner = new agents.Runner();
  if (typeof runner.run === "function") {
    await runner.run(agent, `Generate image artifact ${job.filename} for request ${job.requestId}.`);
  }
}

export async function executeAgentArtifactWorkflow(job: ArtifactJobRecord, options: AgentArtifactWorkflowOptions = {}): Promise<AgentArtifactWorkflowResult> {
  if (job.artifactKind !== "image") {
    throw new Error("Only image artifact generation is currently supported; PDF artifacts are not enabled yet");
  }

  const agents = await loadAgentSdk(options.agentSdk);
  let generated: GeneratedImageBytes | undefined;
  const toolHandler = async () => {
    if ((job.operation ?? "generate") === "edit") {
      if (!job.sourceArtifact || !job.editMode) throw new Error("Image edit jobs require sourceArtifact and editMode");
      const source = await readSourceArtifactBytes(job.projectId, job.sourceArtifact);
      const outputFormat = job.requirements?.image?.outputFormat ?? imageOutputFormatFromFilename(job.filename);
      const outputContentType = contentTypeForImageOutputFormat(outputFormat);
      if (job.editMode === "deterministic_transform" && source.reference.contentType !== outputContentType) {
        throw new Error("deterministic_transform format conversion is not supported without an image transform backend");
      }
      const mask = job.maskRef ? await readSourceArtifactBytes(job.projectId, { artifactReference: job.maskRef.artifactReference, expectedSha256: job.maskRef.artifactReference.sha256 }) : undefined;
      generated = await editImageArtifactBytes({
        mode: job.editMode as import("./agent-artifact-jobs.js").ImageEditMode,
        sourceBytes: source.bytes,
        maskBytes: mask?.bytes,
        instructions: job.editInstructions,
        client: options.imageClient,
        apiKey: options.apiKey,
        size: job.requirements?.image?.size,
        outputFormat,
        maxBytes: job.requirements?.maxBytes,
        model: job.selectedModel
      });
    } else {
      if (!job.prompt) throw new Error("Image generation jobs require prompt");
      generated = await generateImageArtifactBytes({
      prompt: job.prompt,
      client: options.imageClient,
      apiKey: options.apiKey,
      size: job.requirements?.image?.size,
      outputFormat: job.requirements?.image?.outputFormat ?? imageOutputFormatFromFilename(job.filename),
      maxBytes: job.requirements?.maxBytes,
      model: job.selectedModel
      });
    }
    return {
      ok: true as const,
      contentType: generated.contentType,
      size: generated.bytes.byteLength,
      sha256Preview: sha256Hex(generated.bytes).slice(0, 12)
    };
  };
  const imageTool = createImageGenerationTool(agents, toolHandler);
  await runAgentSdkWorkflow(job, agents, imageTool);

  if (!generated) {
    await toolHandler();
  }

  if (!generated) {
    throw new Error("Image artifact generation did not produce bytes");
  }

  return {
    ...generated,
    workflowExecuted: true,
    toolInvoked: (job.operation ?? "generate") === "edit" ? "edit_image_artifact" : "generate_image_artifact"
  };
}
