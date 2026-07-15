// Netlify Functions has no min-instances / provisioned-concurrency setting (unlike Cloud
// Run or Lambda), so the only lever available to reduce cold starts is traffic: this
// scheduled function (see netlify.toml `[functions."warm-ping-scheduled"] schedule`) pings
// the mcp function's own unauthenticated liveness route every ~5 minutes, keeping at least
// one of its containers warm for real initialize/tools-call traffic.
//
// This must invoke the mcp function itself over HTTP (not just call its liveness logic
// in-process) — each Netlify Function is its own separate container/bundle, so only an
// actual request to /mcp keeps *that* function's instance warm.
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
  try {
    const response = await fetch(new URL("/.netlify/functions/mcp?health=1", baseUrl));
    if (!response.ok) console.error(`warm-ping-scheduled: liveness ping returned status ${response.status}`);
  } catch (error) {
    console.error("warm-ping-scheduled: liveness ping failed:", error instanceof Error ? error.message : error);
  }
  return { statusCode: 200, body: "" };
}
