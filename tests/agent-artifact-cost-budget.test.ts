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
  DEFAULT_GENERATION_BUDGET_USD,
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
function withGrant<T>(fn: () => Promise<T>): Promise<T> {
  const parsed = parseStorageGrant(GRANT);
  assert.ok(parsed.ok, "test grant must parse");
  return runWithStorageGrant(parsed.ok ? parsed.grant : undefined, fn);
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

test("the hard stop fires when a job would push the request past its ceiling", async () => {
  process.env.GENERATION_BUDGET_USD_PER_REQUEST = "0.01";
  await withGrant(async () => {
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

test("unpriced models are bounded by a count limit instead of slipping through as free", async () => {
  process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST = "2";
  await withGrant(async () => {
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
