import { sha256Hex } from "./artifact-core/index.js";
import type { ArtifactJobRecord } from "./agent-artifact-jobs.js";
import { generateImageArtifactBytes, type GeneratedImageBytes, type ImageGenerationClient } from "./agent-image-generation.js";

export interface AgentArtifactWorkflowOptions {
  imageClient?: ImageGenerationClient;
  apiKey?: string;
  agentSdk?: AgentSdkModule;
}

export interface AgentArtifactWorkflowResult extends GeneratedImageBytes {
  workflowExecuted: true;
  toolInvoked: "generate_image_artifact";
}

type AgentSdkModule = {
  Agent?: new (input: Record<string, unknown>) => unknown;
  Runner?: new () => { run?: (agent: unknown, input: string) => Promise<unknown> };
  tool?: (input: Record<string, unknown>) => unknown;
};

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
    model: "gpt-5.4",
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
    generated = await generateImageArtifactBytes({
      prompt: job.prompt,
      client: options.imageClient,
      apiKey: options.apiKey
    });
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
    toolInvoked: "generate_image_artifact"
  };
}
