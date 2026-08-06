// Netlify Functions has no min-instances / provisioned-concurrency setting (unlike Cloud
// Run or Lambda), so the only lever available to reduce cold starts is traffic: this
// scheduled function (see netlify.toml `[functions."warm-ping-scheduled"] schedule`) pings
// the mcp and agent-artifact-worker-background functions' unauthenticated liveness routes
// every ~5 minutes, keeping at least one instance of each warm for real traffic.
//
// Each Netlify Function is its own separate container/bundle, so only actual HTTP requests
// to /mcp and /agent-artifact-worker-background keep those functions' instances warm.
// Pings are concurrent but independent: one target failing does not suppress the other.
export const config = { name: "warm-ping-scheduled" };

type FunctionEvent = { httpMethod?: string };

function targetBaseUrl(): string | undefined {
  return process.env.URL || process.env.DEPLOY_PRIME_URL;
}

export async function handler(_event: FunctionEvent) {
  const baseUrl = targetBaseUrl();
  if (!baseUrl) {
    console.error("warm-ping-scheduled: no site URL available (URL/DEPLOY_PRIME_URL unset); skipping ping");
    return { statusCode: 200, body: "" };
  }
  const results = await Promise.allSettled([
    (async () => {
      const response = await fetch(new URL("/.netlify/functions/mcp?health=1", baseUrl));
      if (!response.ok) console.error(`warm-ping-scheduled: mcp liveness ping returned status ${response.status}`);
    })(),
    (async () => {
      const response = await fetch(new URL("/.netlify/functions/agent-artifact-worker-background?health=1", baseUrl));
      if (!response.ok) console.error(`warm-ping-scheduled: agent-artifact-worker-background liveness ping returned status ${response.status}`);
    })()
  ]);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const target = index === 0 ? "mcp" : "agent-artifact-worker-background";
      console.error(`warm-ping-scheduled: ${target} liveness ping failed:`, result.reason instanceof Error ? result.reason.message : result.reason);
    }
  });
  return { statusCode: 200, body: "" };
}