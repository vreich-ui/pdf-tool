import test from "node:test";
import assert from "node:assert/strict";
import { handler as warmPingHandler } from "../netlify/functions/warm-ping-scheduled.js";

// ── Scheduled keepalive ping: ping both mcp and worker health routes ──
// Netlify Functions has no min-instances setting, so this scheduled function pings the
// mcp and agent-artifact-worker-background health routes every ~5 minutes to keep both
// function instances warm. Pings are concurrent but independent: one target failing does
// not suppress the other.

test("warm-ping-scheduled: pings both mcp and worker targets concurrently", async () => {
  // Mock the global fetch to track calls
  const originalFetch = global.fetch as any;
  const calls: string[] = [];

  (global.fetch as any) = async (url: string | URL) => {
    const urlStr = url instanceof URL ? url.href : url;
    calls.push(urlStr);
    return { ok: true, status: 200 };
  };

  try {
    process.env.URL = "https://example.netlify.app";
    const result = await warmPingHandler({});
    assert.equal(result.statusCode, 200);

    // Both targets should have been pinged
    assert.equal(calls.length, 2);
    const urlsSorted = calls.sort();
    assert.ok(urlsSorted.some((u) => u.includes("mcp") && u.includes("health=1")));
    assert.ok(urlsSorted.some((u) => u.includes("agent-artifact-worker-background") && u.includes("health=1")));
  } finally {
    global.fetch = originalFetch;
    delete process.env.URL;
  }
});

test("warm-ping-scheduled: one target failing does not suppress the other", async () => {
  const originalFetch = global.fetch as any;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => {
    errors.push(args.join(" "));
  };

  const urls = new Set<string>();
  (global.fetch as any) = async (url: string | URL) => {
    const urlStr = url instanceof URL ? url.href : url;
    urls.add(urlStr);

    // First call (mcp) fails, second call (worker) succeeds
    if (urlStr.includes("mcp?health=1")) {
      throw new Error("mcp ping failed");
    }
    return { ok: true, status: 200 };
  };

  try {
    process.env.URL = "https://example.netlify.app";
    const result = await warmPingHandler({});
    assert.equal(result.statusCode, 200);

    // Both targets should have been attempted
    assert.equal(urls.size, 2);

    // The error from mcp should be logged, but warmPingHandler still returns 200
    assert.ok(errors.some((e) => e.includes("mcp") && e.includes("failed")));
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    delete process.env.URL;
  }
});

test("warm-ping-scheduled: skips ping when URL environment is unset", async () => {
  const originalFetch = global.fetch as any;
  const calls: string[] = [];
  (global.fetch as any) = async (url: string | URL) => {
    calls.push(url instanceof URL ? url.href : url);
    return { ok: true, status: 200 };
  };

  try {
    delete process.env.URL;
    delete process.env.DEPLOY_PRIME_URL;
    const result = await warmPingHandler({});
    assert.equal(result.statusCode, 200);

    // No fetch calls should have been made
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("warm-ping-scheduled: logs non-ok response status for each target separately", async () => {
  const originalFetch = global.fetch as any;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => {
    errors.push(args.join(" "));
  };

  let callCount = 0;
  (global.fetch as any) = async (url: string | URL) => {
    callCount++;
    // Both return non-ok status
    return { ok: false, status: 500 };
  };

  try {
    process.env.URL = "https://example.netlify.app";
    const result = await warmPingHandler({});
    assert.equal(result.statusCode, 200);

    // Both failures should be logged separately
    const mcp_error = errors.find((e) => e.includes("mcp") && e.includes("500"));
    const worker_error = errors.find((e) => e.includes("agent-artifact-worker-background") && e.includes("500"));
    assert.ok(mcp_error, "mcp error should be logged");
    assert.ok(worker_error, "worker error should be logged");
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    delete process.env.URL;
  }
});
