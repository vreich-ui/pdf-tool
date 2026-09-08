/**
 * D1 (cost receipts) and D2 (per-request generation budget).
 *
 * The gap D1 closes is that nothing in the system reported what anything cost: the only cost
 * object was image-only, carried no provenance, and PDF jobs had none at all. The gap D2
 * closes is that no ceiling bounded how many paid generations one requestId could accumulate.
 *
 * The subtle case both share, and the one most worth locking down: an UNPRICED model must
 * never be treated as free. Valuing an unmodellable price at zero would understate every
 * total and let exactly the expensive case walk straight past the budget guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { parseStorageGrant, runWithStorageGrant } from "../netlify/lib/storage-grant.js";
import { deterministicRenderCostReceipt, imageCostReceipt, sumCostReceipts } from "../netlify/lib/cost-receipt.js";
import {
  chargeGenerationBudget,
  readGenerationLedger,
  generationBudget,
  evaluateGenerationBudget,
  budgetExceededWarning,
  overBudgetMode,
  BUDGET_EXCEEDED_WARNING_CODE,
  DEFAULT_GENERATION_BUDGET_USD,
  type GenerationLedger,
} from "../netlify/lib/generation-budget.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  delete process.env.GENERATION_BUDGET_USD_PER_REQUEST;
  delete process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST;
}

const GRANT = {
  grantType: "netlify-pat" as const,
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

/** Every ledger read/write goes through the project's jobs store, which is only reachable
 * under an active per-request storage grant -- same posture as production. */
function withGrant<T>(fn: () => Promise<T>, limits?: Record<string, unknown>): Promise<T> {
  const parsed = parseStorageGrant(limits ? { ...GRANT, limits } : GRANT);
  assert.ok(parsed.ok, "test grant must parse");
  return runWithStorageGrant(parsed.ok ? parsed.grant : undefined, fn);
}

/** QA-W16-5: a grant that opts INTO the old hard-stop behaviour. */
function withBlockingGrant<T>(fn: () => Promise<T>): Promise<T> {
  return withGrant(fn, { overBudget: "block" });
}

function ledger(patch: Partial<GenerationLedger> = {}): GenerationLedger {
  return { projectId: "dr-lurie", requestId: "req-x", spentUsd: 0, unpricedCount: 0, jobCount: 0, updatedAt: "2026-09-08T00:00:00.000Z", ...patch };
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// -- D1: receipts -------------------------------------------------------------

test("a priced fal model produces a per-megapixel receipt with provenance", () => {
  const receipt = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
  assert.equal(receipt.provider, "fal");
  assert.equal(receipt.basis, "per-megapixel");
  assert.equal(receipt.isEstimate, true);
  assert.ok((receipt.estimateUsd ?? 0) > 0, "a priced model must carry a non-zero estimate");
  // Provenance is what keeps a stored receipt interpretable after the table moves.
  assert.ok(receipt.pricedAt, "receipt must record when its prices were verified");
  assert.ok(receipt.tableVersion, "receipt must record which price table produced it");
  assert.equal(receipt.detail?.estimatedMegapixels, 1.049);
});

test("an unpriced model records NO estimate rather than a zero", () => {
  const receipt = imageCostReceipt("openai", "gpt-image-1", "1024x1024");
  assert.equal(receipt.basis, "per-image-unpriced");
  assert.equal(receipt.estimateUsd, undefined, "unknown price must not be recorded as free");
});

test("a deterministic PDF render records an exact, non-estimated zero", () => {
  const receipt = deterministicRenderCostReceipt("pdfme");
  assert.equal(receipt.provider, "pdf-tool");
  assert.equal(receipt.basis, "deterministic-render");
  assert.equal(receipt.estimateUsd, 0);
  assert.equal(receipt.isEstimate, false, "there is no provider charge to estimate");
});

test("summing receipts reports unpriced entries separately from the total", () => {
  const summed = sumCostReceipts([
    imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024"),
    imageCostReceipt("openai", "gpt-image-1", "1024x1024"),
    deterministicRenderCostReceipt("pdfme"),
    undefined,
  ]);
  assert.ok(summed.totalUsd > 0);
  // The caller must be able to tell "this total is complete" from "this total is a floor".
  assert.equal(summed.unpricedCount, 1);
});

// -- D2: the budget -----------------------------------------------------------

test("the default budget applies when no env override is set", () => {
  assert.equal(generationBudget().budgetUsd, DEFAULT_GENERATION_BUDGET_USD);
});

test("charging accumulates spend across jobs on the same requestId", async () => {
  await withGrant(async () => {
    const receipt = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-a", receipt });
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-a", receipt });

    const ledger = await readGenerationLedger("dr-lurie", "req-a");
    assert.equal(ledger.jobCount, 2);
    assert.ok(Math.abs(ledger.spentUsd - (receipt.estimateUsd ?? 0) * 2) < 1e-9, `unexpected total ${ledger.spentUsd}`);
  });
});

test("ledgers are isolated per requestId", async () => {
  await withGrant(async () => {
    const receipt = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-a", receipt });
    const other = await readGenerationLedger("dr-lurie", "req-b");
    assert.equal(other.jobCount, 0);
    assert.equal(other.spentUsd, 0);
  });
});

test("the hard stop fires when a job would push the request past its ceiling, under a blocking grant", async () => {
  process.env.GENERATION_BUDGET_USD_PER_REQUEST = "0.01";
  await withBlockingGrant(async () => {
    // ~$0.0063 each against the klein tier: the first fits, the second would exceed $0.01.
    const receipt = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-cap", receipt });
    await assert.rejects(
      () => chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-cap", receipt }),
      /would exceed its generation budget/
    );

    // The refused job must not be charged — a rejected request costs nothing.
    const ledger = await readGenerationLedger("dr-lurie", "req-cap");
    assert.equal(ledger.jobCount, 1);
  });
});

test("unpriced models are bounded by a count limit instead of slipping through as free, under a blocking grant", async () => {
  process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST = "2";
  await withBlockingGrant(async () => {
    const receipt = imageCostReceipt("openai", "gpt-image-1", "1024x1024");
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-unpriced", receipt });
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-unpriced", receipt });
    await assert.rejects(
      () => chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-unpriced", receipt }),
      /cannot price/
    );
    const ledger = await readGenerationLedger("dr-lurie", "req-unpriced");
    assert.equal(ledger.unpricedCount, 2);
    // An unpriced charge must not inflate the dollar total with a fabricated number.
    assert.equal(ledger.spentUsd, 0);
  });
});

test("deterministic renders are free and never consume the budget", async () => {
  process.env.GENERATION_BUDGET_USD_PER_REQUEST = "0.001";
  await withGrant(async () => {
    const receipt = deterministicRenderCostReceipt("pdfme");
    for (let i = 0; i < 20; i++) {
      await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-pdf", receipt });
    }
    const ledger = await readGenerationLedger("dr-lurie", "req-pdf");
    assert.equal(ledger.spentUsd, 0);
    assert.equal(ledger.jobCount, 0, "free renders should not be charged to the ledger at all");
  });
});

test("setting the budget to 0 disables enforcement entirely", async () => {
  process.env.GENERATION_BUDGET_USD_PER_REQUEST = "0";
  await withGrant(async () => {
    const receipt = imageCostReceipt("fal", "fal-ai/flux-2-flex", "1024x1024");
    for (let i = 0; i < 5; i++) {
      await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-off", receipt });
    }
    // Nothing throws, and nothing is recorded — the guard is off, not silently lenient.
    assert.equal((await readGenerationLedger("dr-lurie", "req-off")).jobCount, 0);
  });
});

// -- QA-W16-5: over_budget: "warn" is the default, and it is honoured ----------
//
// The defect: every site's media policy says over_budget: "warn", and the standing platform
// ruling is that quality/spend gates warn rather than block -- but the spend ceiling refused
// the job outright no matter what the policy said. These lock down both halves: the pure
// decision (evaluateGenerationBudget) and what each mode does with it.

test("evaluateGenerationBudget is a pure decision: it reports the breach and never acts on it", () => {
  const budget = { budgetUsd: 0.01, unpricedLimit: 2 };
  const priced = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");

  assert.equal(evaluateGenerationBudget(ledger(), priced, budget), undefined, "the first job fits");

  const over = evaluateGenerationBudget(ledger({ spentUsd: 0.009, jobCount: 1 }), priced, budget);
  assert.equal(over?.reason, "cost");
  assert.match(over?.message ?? "", /would exceed its generation budget/);
  assert.equal(over?.detail.budgetUsd, 0.01);

  const unpriced = imageCostReceipt("openai", "gpt-image-1", "1024x1024");
  assert.equal(evaluateGenerationBudget(ledger({ unpricedCount: 1 }), unpriced, budget), undefined);
  const overUnpriced = evaluateGenerationBudget(ledger({ unpricedCount: 2 }), unpriced, budget);
  assert.equal(overUnpriced?.reason, "unpriced");
  assert.match(overUnpriced?.message ?? "", /cannot price/);

  // The two cases that are never a breach, whatever the ledger says.
  assert.equal(evaluateGenerationBudget(ledger({ spentUsd: 999 }), deterministicRenderCostReceipt("pdfme"), budget), undefined);
  assert.equal(evaluateGenerationBudget(ledger({ spentUsd: 999 }), priced, { budgetUsd: 0, unpricedLimit: 2 }), undefined);
});

test('the over-budget mode defaults to "warn" and only an explicit grant value blocks', async () => {
  await withGrant(async () => assert.equal(overBudgetMode(), "warn"));
  await withGrant(async () => assert.equal(overBudgetMode(), "warn"), { maxImageBytes: 10 });
  await withGrant(async () => assert.equal(overBudgetMode(), "warn"), { overBudget: "yolo" });
  await withBlockingGrant(async () => assert.equal(overBudgetMode(), "block"));
  // No grant at all (a caller that never configured any of this) still warns.
  assert.equal(overBudgetMode(), "warn");
});

test('over budget under "warn": the job PROCEEDS, is still charged, and carries a budget_exceeded warning', async () => {
  process.env.GENERATION_BUDGET_USD_PER_REQUEST = "0.01";
  await withGrant(async () => {
    const receipt = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
    const first = await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-warn", receipt });
    assert.equal(first.warning, undefined, "a job inside the ceiling must not be flagged");

    const second = await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-warn", receipt });
    assert.ok(second.warning, "the over-budget job must be flagged, not refused");
    assert.match(second.warning ?? "", new RegExp(BUDGET_EXCEEDED_WARNING_CODE));
    assert.match(second.warning ?? "", /would exceed its generation budget/);
    assert.equal(second.breach?.reason, "cost");

    // The spend is real, so it is recorded: a warned job is a charged job.
    const led = await readGenerationLedger("dr-lurie", "req-warn");
    assert.equal(led.jobCount, 2);
    assert.ok(led.spentUsd > 0.01, `warned spend must still be on the ledger, got ${led.spentUsd}`);
  });
});

test('the unpriced ceiling warns under "warn" too, rather than refusing', async () => {
  process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST = "1";
  await withGrant(async () => {
    const receipt = imageCostReceipt("openai", "gpt-image-1", "1024x1024");
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-warn-unpriced", receipt });
    const over = await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-warn-unpriced", receipt });
    assert.equal(over.breach?.reason, "unpriced");
    assert.match(over.warning ?? "", /cannot price/);
    assert.equal((await readGenerationLedger("dr-lurie", "req-warn-unpriced")).unpricedCount, 2);
  });
});

test('over budget under "block": refused exactly as before, and nothing is charged', async () => {
  process.env.GENERATION_BUDGET_USD_PER_REQUEST = "0.01";
  await withBlockingGrant(async () => {
    const receipt = imageCostReceipt("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
    await chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-block", receipt });
    await assert.rejects(
      () => chargeGenerationBudget({ projectId: "dr-lurie", requestId: "req-block", receipt }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.equal(typed.code, "GENERATION_BUDGET_EXCEEDED");
        assert.match(typed.message ?? "", /would exceed its generation budget/);
        return true;
      }
    );
    assert.equal((await readGenerationLedger("dr-lurie", "req-block")).jobCount, 1, "a refused job costs nothing");
  });
});

test("the warning text names the policy that let the job through, so a reader can act on it", () => {
  const warning = budgetExceededWarning({ reason: "cost", message: "Request \"r\" would exceed its generation budget.", detail: {} });
  assert.match(warning, /^budget_exceeded: /);
  assert.match(warning, /over_budget: "warn"/);
  assert.match(warning, /limits\.overBudget/);
});
