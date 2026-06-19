import type { ArtifactJobRecord } from "./agent-artifact-jobs.js";
import { generateImageArtifactBytes, type GeneratedImageBytes, type ImageGenerationClient } from "./agent-image-generation.js";

export interface AgentArtifactWorkflowOptions {
  imageClient?: ImageGenerationClient;
  skipAgentSdkImport?: boolean;
}

export interface AgentArtifactWorkflowResult extends GeneratedImageBytes {
  workflowExecuted: true;
  toolInvoked: "generate_image_artifact";
}

async function runAgentSdkPlanningStep(job: ArtifactJobRecord, skipAgentSdkImport: boolean | undefined): Promise<void> {
  if (skipAgentSdkImport || process.env.AGENT_ARTIFACT_TEST_AGENT_SDK === "1") {
    return;
  }

  const agents = await import("@openai/agents");
  const AgentCtor = (agents as { Agent?: new (input: Record<string, unknown>) => unknown }).Agent;
  const RunnerCtor = (agents as { Runner?: new () => { run?: (agent: unknown, input: string) => Promise<unknown> } }).Runner;
  if (!AgentCtor || !RunnerCtor) {
    throw new Error("OpenAI Agent SDK is unavailable");
  }

  const agent = new AgentCtor({
    name: "Artifact Generation Agent",
    instructions: "Plan a single safe binary artifact generation call. Do not handle article content or pass bytes through MCP.",
    model: "gpt-5.4"
  });
  const runner = new RunnerCtor();
  if (typeof runner.run === "function") {
    await runner.run(agent, `Generate ${job.artifactKind} artifact ${job.filename} for request ${job.requestId}.`);
  }
}

export async function executeAgentArtifactWorkflow(job: ArtifactJobRecord, options: AgentArtifactWorkflowOptions = {}): Promise<AgentArtifactWorkflowResult> {
  if (job.artifactKind !== "image") {
    throw new Error("Only image artifact generation is currently supported; PDF artifacts are not enabled yet");
  }

  await runAgentSdkPlanningStep(job, options.skipAgentSdkImport);
  const generated = await generateImageArtifactBytes({
    prompt: job.prompt,
    client: options.imageClient
  });

  return {
    ...generated,
    workflowExecuted: true,
    toolInvoked: "generate_image_artifact"
  };
}
