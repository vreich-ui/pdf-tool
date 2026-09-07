import { sha256Hex } from "./artifact-core/index.js";
import { MAX_IMAGE_OUTPUT_BYTES, type ArtifactJobRecord } from "./agent-artifact-jobs.js";
import { generateImageArtifactBytes, buildAnnotatedGenerationPrompt, type GeneratedImageBytes, type ImageGenerationClient } from "./agent-image-generation.js";
import { editImageArtifactBytes, readSourceArtifactBytes, contentTypeForImageOutputFormat, type ImageEditingClient } from "./agent-image-editing.js";
import { resolveImageProvider } from "./image-providers/registry.js";
import { RenderError } from "./pdf-render/errors.js";
import { assertWorkerBudget, remainingWorkerBudgetMs, withRateLimitEtiquette, type WorkerDeadline } from "./worker-budget.js";
import { chargeGenerationBudget } from "./generation-budget.js";

/**
 * T5 / T4 integration point. T4's OCR gate plugs in here: pass a `checkImageTextLeak`
 * implementation that decodes `bytes` and reports whether the image still carries rendered
 * text. The production wiring is `createOcrImageTextLeakChecker`
 * (agent-artifact-image-text-leak-check.ts), passed in by the worker call site
 * (agent-artifact-worker-background.ts) — it OCRs the bytes directly against the render
 * service, in `expect_none` mode, on bytes that are not (and, on a leak-then-regenerate,
 * may never be) a stored artifact. Left undefined, the workflow falls back to
 * `noopImageTextLeakCheck` below, which always reports `{ leaking: false }` — so a caller
 * that omits it (e.g. every test in this file's own suite unless it injects its own mock)
 * still gets the prompt guard (this file's responsibility) but never a regenerate (that
 * decision is entirely this callback's, by design: no OCR logic belongs in the generate
 * workflow itself).
 */
export interface ImageTextLeakCheckInput {
  bytes: Buffer;
  contentType: GeneratedImageBytes["contentType"];
}

export interface ImageTextLeakCheckResult {
  leaking: boolean;
  /** Opaque to this file — T4's OCR gate can carry whatever detail (matched regions,
   * extracted strings, confidence) it wants here; only `leaking` drives control flow. */
  detail?: unknown;
}

export type ImageTextLeakChecker = (input: ImageTextLeakCheckInput) => Promise<ImageTextLeakCheckResult>;

/** Default `checkImageTextLeak`: never reports a leak, so annotate-mode jobs get the prompt
 * guard but no regenerate until a real checker is injected. */
export const noopImageTextLeakCheck: ImageTextLeakChecker = async () => ({ leaking: false });

export interface AgentArtifactWorkflowOptions {
  imageClient?: ImageGenerationClient & ImageEditingClient;
  apiKey?: string;
  agentSdk?: AgentSdkModule;
  /** Worker deadline: bounds provider timeouts and any honored Retry-After wait. */
  deadline?: WorkerDeadline;
  /** Injectable sleep for tests of the 429 etiquette; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** T4 integration point — see the doc comment on ImageTextLeakChecker above. Defaults to
   * noopImageTextLeakCheck. Only ever consulted for `requirements.image.annotate: true`
   * generate jobs. */
  checkImageTextLeak?: ImageTextLeakChecker;
}

/** Explicit provider timeout when no worker deadline is in scope (F9: no SDK default). */
const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_TIMEOUT_MS = 600_000;

function providerTimeoutMs(deadline: WorkerDeadline | undefined): number {
  const remaining = remainingWorkerBudgetMs(deadline);
  if (!Number.isFinite(remaining)) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.max(1, Math.min(remaining, MAX_PROVIDER_TIMEOUT_MS));
}

export type ImageOutputFormat = "png" | "jpeg" | "webp";

/** A malfunctioning checker (T4's OCR gate down, or anything it throws) must never fail an
 * otherwise-successful generate job — gates warn, they do not block (BRIEF §1). Treated as
 * "not confirmed leaking" so a checker outage skips the regenerate rather than forcing one,
 * and the failure itself is recorded as a warning so it stays visible. */
async function safeCheckImageTextLeak(checker: ImageTextLeakChecker, image: GeneratedImageBytes, warnings: string[]): Promise<ImageTextLeakCheckResult> {
  try {
    return await checker({ bytes: image.bytes, contentType: image.contentType });
  } catch (error) {
    warnings.push(`Text-leak check failed to run (${error instanceof Error ? error.message : String(error)}); proceeding as if no text was detected.`);
    return { leaking: false };
  }
}

export interface AgentArtifactWorkflowResult extends GeneratedImageBytes {
  workflowExecuted: true;
  toolInvoked: "generate_image_artifact" | "edit_image_artifact";
  /** T5: present only for `requirements.image.annotate: true` generate jobs where the
   * text-leak checker fired at least once. Human-readable, mirrors how sizeWarning's string
   * gets built in agent-artifact-worker-background.ts — folded into the job's `warnings[]`
   * there, never used to fail the job. */
  annotateGuardWarnings?: string[];
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
  // T5: populated only for annotate-mode generate jobs where the text-leak checker ran;
  // folded into AgentArtifactWorkflowResult.annotateGuardWarnings at the bottom of this
  // function, and from there into the job's warnings[] (agent-artifact-worker-background.ts,
  // same channel the size-budget warning already uses).
  const annotateGuardWarnings: string[] = [];
  const toolHandler = async () => {
    // Deadline-awareness: a job that cannot start its provider work before the platform
    // cap fails cleanly (WORKER_TIMEOUT_APPROACHING) instead of being killed silently.
    assertWorkerBudget(options.deadline, "image artifact execution");
    // F5: the image byte ceiling applies BY DEFAULT — a job that omits requirements.maxBytes
    // must not receive an unbounded artifact (mirrors the PDF ceiling).
    const maxBytes = job.requirements?.maxBytes ?? MAX_IMAGE_OUTPUT_BYTES;
    if ((job.operation ?? "generate") === "edit") {
      if (!job.sourceArtifact || !job.editMode) throw new Error("Image edit jobs require sourceArtifact and editMode");
      const source = await readSourceArtifactBytes(job.projectId, job.sourceArtifact);
      const outputFormat = job.requirements?.image?.outputFormat ?? imageOutputFormatFromFilename(job.filename);
      const mask = job.maskRef ? await readSourceArtifactBytes(job.projectId, { artifactReference: job.maskRef.artifactReference, expectedSha256: job.maskRef.artifactReference.sha256 }) : undefined;
      if (job.editMode === "deterministic_transform") {
        // Pure sharp transform — no model, no provider routing.
        generated = await editImageArtifactBytes({
          mode: job.editMode as import("./agent-artifact-jobs.js").ImageEditMode,
          sourceBytes: source.bytes,
          maskBytes: mask?.bytes,
          instructions: job.editInstructions,
          client: options.imageClient,
          apiKey: options.apiKey,
          size: job.requirements?.image?.size,
          outputFormat,
          maxBytes,
          model: job.selectedModel
        });
      } else {
        // Adapter dispatch with an EXPLICIT capability check: an edit mode the selected
        // model cannot perform fails loudly — never a silent fallback to another API.
        const { provider, model } = resolveImageProvider(job.selectedModel);
        const editFeature = job.editMode as "masked_edit" | "image_variation";
        if (!provider.supports(editFeature, model) || !provider.edit) {
          throw new RenderError("IMAGE_EDIT_MODE_UNSUPPORTED", `Model ${model} does not support ${job.editMode}`, {
            model,
            mode: job.editMode,
            provider: provider.id,
          });
        }
        // F9/429 etiquette: no blind retries; at most one wait honoring a provider
        // Retry-After that fits the remaining job budget, else a typed failure.
        generated = await withRateLimitEtiquette("image edit", () => provider.edit!({
          mode: editFeature,
          model,
          sourceBytes: source.bytes,
          maskBytes: mask?.bytes,
          instructions: job.editInstructions,
          prompt: job.prompt,
          client: options.imageClient,
          apiKey: options.apiKey,
          size: job.requirements?.image?.size,
          outputFormat,
          maxBytes,
          timeoutMs: providerTimeoutMs(options.deadline),
        }), { deadline: options.deadline, sleep: options.sleep });
      }
    } else {
      if (!job.prompt) throw new Error("Image generation jobs require prompt");
      const { provider, model } = resolveImageProvider(job.selectedModel);
      const outputFormat = job.requirements?.image?.outputFormat ?? imageOutputFormatFromFilename(job.filename);
      // T5: the prompt guard is generate-stage only (edit jobs above never reach here) and
      // opt-in via requirements.image.annotate — a job that omits/false's it gets job.prompt
      // completely untouched, byte for byte.
      const annotate = job.requirements?.image?.annotate === true;
      const effectivePrompt = annotate ? buildAnnotatedGenerationPrompt(job.prompt) : job.prompt;
      const runGenerate = () => withRateLimitEtiquette("image generation", () => provider.generate({
        prompt: effectivePrompt,
        model,
        client: options.imageClient,
        apiKey: options.apiKey,
        size: job.requirements?.image?.size,
        outputFormat,
        maxBytes,
        timeoutMs: providerTimeoutMs(options.deadline),
      }), { deadline: options.deadline, sleep: options.sleep });

      generated = await runGenerate();

      if (annotate) {
        const checkLeak = options.checkImageTextLeak ?? noopImageTextLeakCheck;
        const firstCheck = await safeCheckImageTextLeak(checkLeak, generated, annotateGuardWarnings);
        if (firstCheck.leaking) {
          // Exactly one automatic regenerate, charged and bounded like any other
          // generation — never a free extra provider call, never a third attempt, and
          // never a reason to fail an otherwise-successful job. Any failure of the charge,
          // the deadline check, or the regenerate call itself falls back to keeping the
          // first attempt with a warning, rather than propagating.
          let regenerated: GeneratedImageBytes | undefined;
          try {
            assertWorkerBudget(options.deadline, "image annotate text-leak regenerate");
            await chargeGenerationBudget({ projectId: job.projectId, requestId: job.requestId, receipt: job.costReceipt });
            regenerated = await runGenerate();
          } catch (error) {
            annotateGuardWarnings.push(
              `Automatic regenerate after the text-leak check flagged the first attempt could not run (${error instanceof Error ? error.message : String(error)}); keeping the first attempt, which may still contain rendered text.`
            );
          }
          if (regenerated) {
            generated = regenerated;
            const secondCheck = await safeCheckImageTextLeak(checkLeak, regenerated, annotateGuardWarnings);
            annotateGuardWarnings.push(
              secondCheck.leaking
                ? "Image regenerated once after the text-leak check flagged rendered text on the first attempt; the second attempt still appears to contain rendered text — keeping it rather than retrying a third time."
                : "Image regenerated once after the text-leak check flagged rendered text on the first attempt; the second attempt passed the text-leak check."
            );
          }
        }
      }
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
    toolInvoked: (job.operation ?? "generate") === "edit" ? "edit_image_artifact" : "generate_image_artifact",
    ...(annotateGuardWarnings.length ? { annotateGuardWarnings } : {})
  };
}
