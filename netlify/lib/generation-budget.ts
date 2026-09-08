/**
 * D2: a per-request generation budget with a hard stop.
 *
 * The asymmetry this exists for: a runaway loop against fal's klein tier (~$0.006/image) is
 * an annoyance, while the same loop against a premium per-image model is not. Nothing else in
 * the system bounds how many paid generations one requestId can accumulate, and the natural
 * failure mode of an agent loop is "try again", so the ceiling has to live server-side.
 *
 * Scope is the requestId (the artifact-owning content item) because that is the unit a caller
 * actually reasons about — "this article" — and it is already carried on every job.
 *
 * Deliberate design choices, both about being honest rather than convenient:
 *
 *   - The ledger is a running total updated at job CREATION, from the same estimate that lands
 *     on the job's cost receipt. Charging at creation (not completion) is what makes the stop
 *     effective: a loop that fails to check budget until after spending has already spent.
 *
 *   - Unpriced models (OpenAI, whose billing this table cannot model) are COUNTED, not
 *     silently valued at zero. Treating an unknown price as free would let exactly the
 *     expensive case slip past the guard. They are bounded by a separate count limit instead,
 *     so the guard degrades to something meaningful rather than to nothing.
 *
 * QA-W16-5 (Wolf's standing ruling: quality and spend gates WARN, they do not block — for
 * agents and humans alike): the ceiling above is no longer an unconditional hard stop. The
 * site's media policy carries exactly ONE over_budget mode, and it already reaches pdf-tool
 * on the storage grant as `limits.overBudget` (parseStorageGrant accepts the platform's
 * snake_case `over_budget` too, and normalizes absent/unrecognised to "warn"). S-15 wired
 * that field to the image BYTE budget in the worker; wiring the SPEND ceiling to the same
 * field is what makes one policy mean one thing everywhere:
 *
 *   - "warn" (the default, and what every site's media policy says): the job PROCEEDS, the
 *     spend is still recorded on the ledger, and a `budget_exceeded` warning rides the job
 *     record through to get_agent_artifact_job_status.
 *   - "block": exactly the previous behaviour — GENERATION_BUDGET_EXCEEDED, nothing charged.
 *
 * The ledger is a plain read-modify-write, so two truly simultaneous creations can each read
 * the pre-increment total. That window under-counts by at most one job's estimate and cannot
 * lose a recorded spend, which is an acceptable failure mode for a guard rail — unlike the
 * template-version race, where the same pattern silently destroys a version. A conditional
 * write would close it, and needs a Blobs SDK that offers one.
 */
import { projectBlobStore } from "./blob-store.js";
import { projectGrantLimits, projectStoreNames, validateProjectAccess } from "./project-descriptor.js";
import { RenderError } from "./pdf-render/errors.js";
import type { CostReceipt } from "./cost-receipt.js";

/** Default ceiling per requestId, in USD. Override with GENERATION_BUDGET_USD_PER_REQUEST. */
export const DEFAULT_GENERATION_BUDGET_USD = 5;
/** Default ceiling on unpriced (unmodellable) generations per requestId. */
export const DEFAULT_UNPRICED_GENERATION_LIMIT = 25;

export interface GenerationLedger {
  projectId: string;
  requestId: string;
  spentUsd: number;
  unpricedCount: number;
  jobCount: number;
  updatedAt: string;
}

export interface GenerationBudget {
  budgetUsd: number;
  unpricedLimit: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function generationBudget(): GenerationBudget {
  return {
    budgetUsd: numberFromEnv("GENERATION_BUDGET_USD_PER_REQUEST", DEFAULT_GENERATION_BUDGET_USD),
    unpricedLimit: numberFromEnv("GENERATION_UNPRICED_LIMIT_PER_REQUEST", DEFAULT_UNPRICED_GENERATION_LIMIT),
  };
}

/** Budget enforcement is off entirely when the ceiling is set to 0. */
export function generationBudgetEnabled(): boolean {
  return generationBudget().budgetUsd > 0;
}

function safePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Invalid empty path segment");
  return sanitized;
}

export function generationLedgerKey(projectId: string, requestId: string): string {
  return `projects/${safePart(projectId)}/budget/${safePart(requestId)}.json`;
}

async function ledgerStore(projectId: string) {
  const accessIssue = validateProjectAccess(projectId);
  if (accessIssue) throw new Error(accessIssue);
  return projectBlobStore(projectStoreNames().jobs, { consistency: "strong" });
}

export async function readGenerationLedger(projectId: string, requestId: string): Promise<GenerationLedger> {
  const empty: GenerationLedger = { projectId, requestId, spentUsd: 0, unpricedCount: 0, jobCount: 0, updatedAt: new Date().toISOString() };
  try {
    const store = await ledgerStore(projectId);
    const stored = (await store.get(generationLedgerKey(projectId, requestId), { type: "json" }).catch(() => null)) as GenerationLedger | null;
    if (!stored || stored.projectId !== projectId || stored.requestId !== requestId) return empty;
    return stored;
  } catch {
    // A ledger the store cannot serve must not take the whole job down; see assertWithinBudget.
    return empty;
  }
}

export interface BudgetCheckInput {
  projectId: string;
  requestId: string;
  receipt?: CostReceipt;
  /** Override the grant-derived over-budget mode (tests, and callers holding an explicit policy). */
  overBudget?: OverBudgetMode;
}

/** What the site's media policy says to do when something is over its budget. */
export type OverBudgetMode = "warn" | "block";

/** Warning code attached to a job that was allowed through over budget. */
export const BUDGET_EXCEEDED_WARNING_CODE = "budget_exceeded";

/**
 * The effective mode for the current request. The grant is the only place a tenant gets to
 * say "block"; anything else — absent limits, no grant at all, an unrecognised value — is
 * "warn", so a caller that never configured this sees the standing warn ruling.
 */
export function overBudgetMode(): OverBudgetMode {
  return projectGrantLimits().overBudget === "block" ? "block" : "warn";
}

export interface GenerationBudgetBreach {
  /** Which ceiling was hit: the dollar budget, or the unpriced-generation count. */
  reason: "cost" | "unpriced";
  message: string;
  detail: Record<string, unknown>;
}

/**
 * PURE: given a ledger, this job's receipt and the ceilings, would this job breach one?
 * Returns undefined when it fits (including the two cases that never charge at all — the
 * guard disabled, and a free deterministic render). No I/O, no ambient policy: the decision
 * and the acting on it are deliberately separate so both can be tested without a store.
 */
export function evaluateGenerationBudget(
  ledger: GenerationLedger,
  receipt: CostReceipt | undefined,
  budget: GenerationBudget
): GenerationBudgetBreach | undefined {
  if (budget.budgetUsd <= 0) return undefined;
  if (!receipt || receipt.basis === "deterministic-render") return undefined;

  const cost = receipt.estimateUsd;
  if (cost === undefined) {
    if (ledger.unpricedCount + 1 > budget.unpricedLimit) {
      return {
        reason: "unpriced",
        message: `Request "${ledger.requestId}" has reached its limit of ${budget.unpricedLimit} generations on models this deployment cannot price (${receipt.model}). Raise GENERATION_UNPRICED_LIMIT_PER_REQUEST, or route this usage context to a priced model.`,
        detail: { projectId: ledger.projectId, requestId: ledger.requestId, unpricedCount: ledger.unpricedCount, unpricedLimit: budget.unpricedLimit, model: receipt.model },
      };
    }
    return undefined;
  }

  if (ledger.spentUsd + cost > budget.budgetUsd) {
    return {
      reason: "cost",
      message: `Request "${ledger.requestId}" would exceed its generation budget: $${(ledger.spentUsd + cost).toFixed(4)} of $${budget.budgetUsd.toFixed(2)} after this job (${ledger.jobCount} job(s) already charged). Raise GENERATION_BUDGET_USD_PER_REQUEST or use a different requestId.`,
      detail: { projectId: ledger.projectId, requestId: ledger.requestId, spentUsd: ledger.spentUsd, wouldSpendUsd: cost, budgetUsd: budget.budgetUsd, jobCount: ledger.jobCount },
    };
  }
  return undefined;
}

/** PURE: the warning text a warn-mode breach attaches to the job. */
export function budgetExceededWarning(breach: GenerationBudgetBreach): string {
  return `${BUDGET_EXCEEDED_WARNING_CODE}: ${breach.message} Proceeding anyway per the media policy's over_budget: "warn" mode — set the storage grant's limits.overBudget to "block" to refuse instead.`;
}

export interface GenerationBudgetCharge {
  /** The ledger after this charge (or the pre-charge one when recording failed). */
  ledger?: GenerationLedger;
  /** Present only when the job went over budget and the policy said "warn". */
  warning?: string;
  /** The structured breach behind `warning`, for callers that want the numbers. */
  breach?: GenerationBudgetBreach;
}

/**
 * Records this job's spend against the request's ledger.
 *
 * Over budget under "block" — the grant's explicit opt-in — this throws
 * GENERATION_BUDGET_EXCEEDED and charges nothing, exactly as before. Over budget under
 * "warn" (the default) it charges anyway and returns a `budget_exceeded` warning for the
 * caller to attach to the job: the spend is real, so the ledger has to stay truthful, and
 * every later job on the same request keeps warning while it stays over.
 *
 * FAILS OPEN on a storage error. A budget guard that cannot read its own ledger must not
 * become an outage for every generation in the project — the cost of a missed check is
 * bounded and recoverable, the cost of blocking all work is not.
 */
export async function chargeGenerationBudget(input: BudgetCheckInput): Promise<GenerationBudgetCharge> {
  const budget = generationBudget();
  if (budget.budgetUsd <= 0) return {};

  const ledger = await readGenerationLedger(input.projectId, input.requestId);
  const receipt = input.receipt;
  // Deterministic renders are free and unlimited: they consume no provider budget, and
  // counting them would make the ceiling meaningless for the paid work it exists to bound.
  if (!receipt || receipt.basis === "deterministic-render") return { ledger };

  const breach = evaluateGenerationBudget(ledger, receipt, budget);
  if (breach && (input.overBudget ?? overBudgetMode()) === "block") {
    throw new RenderError("GENERATION_BUDGET_EXCEEDED", breach.message, breach.detail);
  }
  const warned = breach ? { warning: budgetExceededWarning(breach), breach } : {};

  const cost = receipt.estimateUsd;
  const updated: GenerationLedger = {
    projectId: input.projectId,
    requestId: input.requestId,
    spentUsd: Math.round((ledger.spentUsd + (cost ?? 0)) * 1_000_000) / 1_000_000,
    unpricedCount: ledger.unpricedCount + (cost === undefined ? 1 : 0),
    jobCount: ledger.jobCount + 1,
    updatedAt: new Date().toISOString(),
  };

  try {
    const store = await ledgerStore(input.projectId);
    await store.setJSON(generationLedgerKey(input.projectId, input.requestId), updated);
  } catch {
    // Recording failed but the check passed: let the job through rather than blocking work
    // on bookkeeping. The under-count is visible as a jobCount that lags the real job list.
    return { ledger, ...warned };
  }
  return { ledger: updated, ...warned };
}
