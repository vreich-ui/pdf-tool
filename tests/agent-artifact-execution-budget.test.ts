import test from "node:test";
import assert from "node:assert/strict";
import { remainingBudgetMs } from "../netlify/lib/execution-budget.js";
import { fetchImportBytes } from "../netlify/lib/image-search/import.js";
import { importImageFromUrl } from "../netlify/lib/agent-image-search-mcp.js";
import { getImageSearchProvider } from "../netlify/lib/image-search/providers.js";
import { DEFAULT_IMAGE_SOURCING_POLICY } from "../netlify/lib/image-search/policy.js";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as mcpHandler } from "../netlify/functions/mcp.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.IMAGE_SEARCH_TEST_FIXTURES;
  delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
  delete process.env.IMAGE_SEARCH_PROVIDER_TIMEOUT_MS;
}

const AUTH = { authorization: "Bearer test-token" };

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

/** Simulates real fetch()+AbortSignal.timeout() behavior: hangs until the signal aborts,
 * then rejects with the signal's abort reason (a TimeoutError DOMException), exactly as
 * Node's built-in fetch does. A real hung socket keeps the event loop alive; AbortSignal.
 * timeout()'s own internal timer is unref'd, so without an explicit keep-alive the process
 * would look idle and exit before the abort ever fires. */
function hangingFetch(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const keepAlive = setInterval(() => {}, 1000);
      const onAbort = () => {
        clearInterval(keepAlive);
        reject(signal!.reason);
      };
      if (!signal) return; // never resolves; the test's own timeout will fail it
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    });
  }) as typeof fetch;
}

// ── remainingBudgetMs ──

test("remainingBudgetMs prefers the platform's own clock when available", () => {
  const context = { getRemainingTimeInMillis: () => 5_000 };
  assert.equal(remainingBudgetMs(context, Date.now()), 3_000); // minus the 2s safety margin
});

test("remainingBudgetMs never returns negative even when the margin exceeds the remaining time", () => {
  const context = { getRemainingTimeInMillis: () => 500 };
  assert.equal(remainingBudgetMs(context, Date.now()), 0);
});

test("remainingBudgetMs falls back to elapsed-time-since-start when no platform context is given", () => {
  const startedAt = Date.now() - 1_000;
  const budget = remainingBudgetMs(undefined, startedAt);
  // Default configured timeout (10s) minus ~1s elapsed minus 2s margin ≈ 7s, with slack for test jitter.
  assert.ok(budget > 6_500 && budget <= 7_000, `expected ~7000ms, got ${budget}`);
});

test("remainingBudgetMs falls back gracefully when the platform context throws", () => {
  const context = { getRemainingTimeInMillis: () => { throw new Error("boom"); } };
  const budget = remainingBudgetMs(context, Date.now());
  assert.ok(budget >= 0);
});

// ── fetchImportBytes: bounded to a timeout, never hangs past it ──

test("fetchImportBytes throws a clean timeout error instead of hanging when the fetch never resolves", async () => {
  await assert.rejects(
    () => fetchImportBytes("https://slow.example.org/image.png", 5_000_000, hangingFetch(), 50),
    /image download timed out after 50ms/
  );
});

// ── importImageFromUrl: bounded to the caller's execution budget ──

test("importImageFromUrl fails fast without attempting the network when the budget is already exhausted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("must not be called: budget was already exhausted"); }) as typeof fetch;
  try {
    const result = await importImageFromUrl(
      { projectId: "dr-lurie", requestId: "req-budget-exhausted", url: "https://cdn.example.org/x.png" },
      { budgetMs: 500 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.match(result.error ?? "", /not enough execution time/i);
    assert.equal((result as { retryable?: boolean }).retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importImageFromUrl returns a structured retryable error (not a crash) when the download times out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    // Just above MIN_USABLE_IMPORT_BUDGET_MS so the call actually attempts the fetch (and
    // then times out via AbortSignal), rather than short-circuiting on the budget pre-check.
    const result = await importImageFromUrl(
      { projectId: "dr-lurie", requestId: "req-timeout", url: "https://slow.example.org/x.png" },
      { budgetMs: 1050 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.match(result.error ?? "", /timed out/i);
    assert.match(result.error ?? "", /import_images_from_url/);
    assert.equal((result as { retryable?: boolean }).retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importImageFromUrl with no budget specified behaves exactly as before (no behavior change)", async () => {
  const originalFetch = globalThis.fetch;
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength)
  }) as unknown as Response) as typeof fetch;
  try {
    const result = await importImageFromUrl({ projectId: "dr-lurie", requestId: "req-no-budget", url: "https://cdn.example.org/ok.png" });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── MCP end-to-end: a near-zero remaining execution budget must surface as a clean tool
// error, never a hang or a crash into a dropped connection ──

test("MCP tools/call import_image_from_url: a near-zero platform budget returns a clean isError result, never a hang", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("must not be called: budget was already exhausted"); }) as typeof fetch;
  const context = { getRemainingTimeInMillis: () => 100 }; // well under the 2s safety margin
  try {
    const response = await mcpHandler(
      {
        httpMethod: "POST",
        headers: AUTH,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "import_image_from_url", arguments: { projectId: "dr-lurie", requestId: "req-mcp-budget", url: "https://cdn.example.org/tight.png" } }
        })
      },
      context
    );
    assert.equal(response.statusCode, 200, "must return a JSON-RPC response, not an origin 5xx");
    const result = JSON.parse(response.body).result;
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /not enough execution time/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── fetchProviderJson (image search providers): also bounded, so one hung provider host
// can't stall the whole background search job ──

test("openverse provider search throws a clean timeout error instead of hanging on a dead host", async () => {
  process.env.IMAGE_SEARCH_PROVIDER_TIMEOUT_MS = "50";
  const provider = getImageSearchProvider("openverse");
  assert.ok(provider, "openverse provider must be registered");
  await assert.rejects(
    () => provider!.search({ projectId: "dr-lurie", query: "test", maxResults: 5, policy: DEFAULT_IMAGE_SOURCING_POLICY, fetchImpl: hangingFetch() }),
    /provider request timed out after 50ms/
  );
});
