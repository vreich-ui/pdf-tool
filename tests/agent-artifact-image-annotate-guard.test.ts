/**
 * T5: the generate-stage prompt guard for image.annotate.
 *
 * Covers the pure suffix builder (agent-image-generation.ts) and the workflow-level retry
 * (agent-artifact-workflow.ts): a job that opts in via `requirements.image.annotate` gets a
 * hard no-text/composition suffix appended to its prompt, and — through the injected
 * `checkImageTextLeak` callback (the T4 integration point; T4's real OCR gate is not built
 * yet, so these tests supply their own mock checkers) — regenerates at most once when the
 * first attempt still appears to contain rendered text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import {
  executeAgentArtifactWorkflow,
  noopImageTextLeakCheck,
  type ImageTextLeakChecker,
} from "../netlify/lib/agent-artifact-workflow.js";
import {
  buildAnnotatedGenerationPrompt,
  IMAGE_ANNOTATION_NO_TEXT_CLAUSE,
  IMAGE_ANNOTATION_NO_TEXT_CLAUSE_MINIMAL,
  IMAGE_ANNOTATION_COMPOSITION_CLAUSE,
  IMAGE_ANNOTATION_PROMPT_SUFFIX,
} from "../netlify/lib/agent-image-generation.js";
import { imageCostReceipt } from "../netlify/lib/cost-receipt.js";
import { readGenerationLedger } from "../netlify/lib/generation-budget.js";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==",
  "base64"
);

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.AGENT_ARTIFACT_TEST_IMAGE_B64;
  delete process.env.GENERATION_BUDGET_USD_PER_REQUEST;
  delete process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST;
}

test.beforeEach(() => {
  env();
  resetMemoryBlobStores();
});

/** A tracking imageClient: records every prompt sent to the "provider" and every call, and
 * returns pngBytes every time regardless of which attempt it is. */
function trackingImageClient() {
  const prompts: string[] = [];
  return {
    prompts,
    calls: () => prompts.length,
    client: {
      images: {
        generate: async (input: Record<string, unknown>) => {
          prompts.push(String(input.prompt));
          return { data: [{ b64_json: pngBytes.toString("base64") }] };
        },
      },
    },
  };
}

/** Reports `leaking: true` on its first invocation and `leaking: false` on every one after. */
function leakThenClean(): ImageTextLeakChecker {
  let calls = 0;
  return async () => {
    calls += 1;
    return { leaking: calls === 1 };
  };
}

/** Always reports `leaking: true`. */
function alwaysLeaking(): ImageTextLeakChecker {
  return async () => ({ leaking: true });
}

async function annotateJob(overrides: { annotate?: boolean; prompt?: string; requestId: string } = { requestId: "req" }) {
  return createArtifactJob({
    projectId: "dr-lurie",
    requestId: overrides.requestId,
    artifactKind: "image",
    prompt: overrides.prompt ?? "a friendly golden retriever in a sunlit kitchen",
    filename: "hero.png",
    tags: [],
    costReceipt: imageCostReceipt("openai", "gpt-image-1", "1024x1024"),
    requirements: {
      image: {
        size: "1024x1024",
        outputFormat: "png",
        role: "featured",
        ...(overrides.annotate === undefined ? {} : { annotate: overrides.annotate }),
      },
    },
  });
}

// ---------------------------------------------------------------------------------------
// Pure suffix builder
// ---------------------------------------------------------------------------------------

test("buildAnnotatedGenerationPrompt appends the no-text and composition clauses to a fresh prompt", () => {
  const base = "a friendly golden retriever in a sunlit kitchen";
  const result = buildAnnotatedGenerationPrompt(base);
  assert.ok(result.startsWith(base), "the caller's own prompt must survive intact at the front");
  assert.ok(result.includes(IMAGE_ANNOTATION_NO_TEXT_CLAUSE));
  assert.ok(result.includes(IMAGE_ANNOTATION_COMPOSITION_CLAUSE));
  assert.equal(result, `${base}\n\n${IMAGE_ANNOTATION_PROMPT_SUFFIX}`);
});

test("buildAnnotatedGenerationPrompt is idempotent: appending twice never duplicates the suffix", () => {
  const base = "a product photo of a ceramic mug";
  const once = buildAnnotatedGenerationPrompt(base);
  const twice = buildAnnotatedGenerationPrompt(once);
  assert.equal(twice, once, "a second pass over an already-annotated prompt must be a no-op");
  // Belt-and-suspenders: each clause appears exactly once, not twice.
  assert.equal(twice.split(IMAGE_ANNOTATION_NO_TEXT_CLAUSE).length - 1, 1);
  assert.equal(twice.split(IMAGE_ANNOTATION_COMPOSITION_CLAUSE).length - 1, 1);
});

test("buildAnnotatedGenerationPrompt does not double an instruction the caller already wrote themselves", () => {
  const base = "a minimalist product shot, no text please, plain background";
  const result = buildAnnotatedGenerationPrompt(base);
  // The caller's own "no text" survives untouched...
  assert.ok(result.includes("no text please"));
  // ...and the FULL clause (which restates "no text") is not appended a second time...
  assert.ok(!result.includes(IMAGE_ANNOTATION_NO_TEXT_CLAUSE));
  // ...but the reduced clause (arrows/labels/watermarks — ground the caller's wording does
  // not cover) still lands, so coverage is not silently lost.
  assert.ok(result.includes(IMAGE_ANNOTATION_NO_TEXT_CLAUSE_MINIMAL));
  assert.ok(result.includes(IMAGE_ANNOTATION_COMPOSITION_CLAUSE));

  // And appending again is still idempotent from this reduced state.
  const again = buildAnnotatedGenerationPrompt(result);
  assert.equal(again, result);
});

test("buildAnnotatedGenerationPrompt recognizes several phrasings of 'no text'", () => {
  for (const phrase of ["no words", "without lettering", "text-free", "textless illustration", "zero typography"]) {
    const result = buildAnnotatedGenerationPrompt(`a scene, ${phrase}`);
    assert.ok(!result.includes(IMAGE_ANNOTATION_NO_TEXT_CLAUSE), `"${phrase}" should suppress the full no-text clause`);
    assert.ok(result.includes(IMAGE_ANNOTATION_NO_TEXT_CLAUSE_MINIMAL), `"${phrase}" should still get the reduced clause`);
  }
});

// ---------------------------------------------------------------------------------------
// Workflow integration
// ---------------------------------------------------------------------------------------

test("a job without requirements.image.annotate sends the prompt to the provider byte-for-byte unaffected", async () => {
  const tracked = trackingImageClient();
  const job = await annotateJob({ annotate: false, requestId: "req-no-annotate" });
  await executeAgentArtifactWorkflow(job, { imageClient: tracked.client });
  assert.equal(tracked.calls(), 1);
  assert.equal(tracked.prompts[0], job.prompt, "prompt must be byte-for-byte identical to job.prompt when annotate is off");

  // Same for a job that never set requirements.image at all.
  const trackedNoReq = trackingImageClient();
  const bareJob = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-no-requirements",
    artifactKind: "image",
    prompt: "an unadorned landscape",
    filename: "hero2.png",
    tags: [],
  });
  await executeAgentArtifactWorkflow(bareJob, { imageClient: trackedNoReq.client });
  assert.equal(trackedNoReq.prompts[0], bareJob.prompt);
});

test("annotate:true appends the suffix to the prompt actually sent to the provider", async () => {
  const tracked = trackingImageClient();
  const job = await annotateJob({ annotate: true, requestId: "req-annotate-prompt" });
  await executeAgentArtifactWorkflow(job, { imageClient: tracked.client });
  assert.equal(tracked.prompts[0], buildAnnotatedGenerationPrompt(job.prompt!));
  assert.ok(tracked.prompts[0].includes(IMAGE_ANNOTATION_NO_TEXT_CLAUSE));
});

test("annotate:true with no checkImageTextLeak injected never regenerates (noop default)", async () => {
  const tracked = trackingImageClient();
  const job = await annotateJob({ annotate: true, requestId: "req-annotate-default-checker" });
  const result = await executeAgentArtifactWorkflow(job, { imageClient: tracked.client });
  assert.equal(tracked.calls(), 1, "the noop checker must never trigger a regenerate");
  assert.equal(result.annotateGuardWarnings, undefined);
  // The default is exported and usable directly too.
  assert.deepEqual(await noopImageTextLeakCheck({ bytes: pngBytes, contentType: "image/png" }), { leaking: false });
});

test("annotate-mode job regenerates exactly once when the text-leak check flags the first attempt, then accepts a clean second attempt", async () => {
  const tracked = trackingImageClient();
  const job = await annotateJob({ annotate: true, requestId: "req-leak-then-clean" });
  const result = await executeAgentArtifactWorkflow(job, {
    imageClient: tracked.client,
    checkImageTextLeak: leakThenClean(),
  });

  assert.equal(tracked.calls(), 2, "exactly one regenerate: two provider calls total, never a third");
  assert.ok(result.annotateGuardWarnings, "the retry outcome must be visible");
  assert.equal(result.annotateGuardWarnings!.length, 1);
  assert.match(result.annotateGuardWarnings![0], /regenerated once/i);
  assert.match(result.annotateGuardWarnings![0], /passed the text-leak check/i);
  // The retry must be charged like any other generation.
  const ledger = await readGenerationLedger("dr-lurie", "req-leak-then-clean");
  assert.equal(ledger.unpricedCount, 1, "one retry charged against the unpriced-model ledger");
  assert.equal(ledger.jobCount, 1);
});

test("annotate-mode job that leaks twice keeps the artifact and records both attempts, never a third generation", async () => {
  const tracked = trackingImageClient();
  const job = await annotateJob({ annotate: true, requestId: "req-leak-twice" });
  const result = await executeAgentArtifactWorkflow(job, {
    imageClient: tracked.client,
    checkImageTextLeak: alwaysLeaking(),
  });

  assert.equal(tracked.calls(), 2, "never a third attempt even though the second attempt also leaked");
  assert.ok(result.bytes, "the (still-leaking) artifact is kept, not discarded");
  assert.ok(result.annotateGuardWarnings);
  assert.equal(result.annotateGuardWarnings!.length, 1);
  assert.match(result.annotateGuardWarnings![0], /regenerated once/i);
  assert.match(result.annotateGuardWarnings![0], /still appears to contain rendered text/i);
  assert.doesNotMatch(result.annotateGuardWarnings![0], /passed the text-leak check/i);
});

test("the text-leak regenerate is charged against the generation budget and skipped (warned, not failed) when the budget forbids it", async () => {
  process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST = "0";
  try {
    const tracked = trackingImageClient();
    const job = await annotateJob({ annotate: true, requestId: "req-budget-exhausted" });
    const result = await executeAgentArtifactWorkflow(job, {
      imageClient: tracked.client,
      checkImageTextLeak: alwaysLeaking(),
    });

    assert.equal(tracked.calls(), 1, "the regenerate must not run as a free extra call when the budget forbids it");
    assert.ok(result.bytes, "the job still succeeds — a budget-blocked retry warns, it never fails the job");
    assert.ok(result.annotateGuardWarnings);
    assert.equal(result.annotateGuardWarnings!.length, 1);
    assert.match(result.annotateGuardWarnings![0], /could not run/i);
    assert.match(result.annotateGuardWarnings![0], /keeping the first attempt/i);
  } finally {
    delete process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST;
  }
});

test("a text-leak checker that throws never fails the job — treated as not-leaking, and the failure itself is warned about", async () => {
  const tracked = trackingImageClient();
  const job = await annotateJob({ annotate: true, requestId: "req-checker-throws" });
  const throwingChecker: ImageTextLeakChecker = async () => {
    throw new Error("OCR service unavailable");
  };
  const result = await executeAgentArtifactWorkflow(job, {
    imageClient: tracked.client,
    checkImageTextLeak: throwingChecker,
  });

  assert.equal(tracked.calls(), 1, "a checker failure must not itself trigger a regenerate");
  assert.ok(result.annotateGuardWarnings);
  assert.match(result.annotateGuardWarnings![0], /Text-leak check failed to run/i);
  assert.match(result.annotateGuardWarnings![0], /OCR service unavailable/i);
});
