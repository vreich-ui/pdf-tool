import { artifactJobRequestSchema, createArtifactJob, getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

export async function triggerWorker(baseUrl: string | undefined, token: string | undefined, projectId: string, jobId: string): Promise<void> {
  if (!baseUrl || !token || typeof fetch !== "function") return;
  const url = new URL("/.netlify/functions/agent-artifact-worker-background", baseUrl);
  await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ projectId, jobId })
  }).catch(() => undefined);
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!isAuthorized(getHeader(event.headers, "authorization"))) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  const parsedBody = parseJsonBody<unknown>(event.body);
  if (!parsedBody) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const parsed = artifactJobRequestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return jsonResponse(400, { error: "Invalid artifact job input", issues: parsed.error.issues.map((issue: { path: unknown; message: string }) => ({ path: issue.path, message: issue.message })) });
  }

  const job = await createArtifactJob(parsed.data as import("../lib/agent-artifact-jobs.js").ArtifactJobRequest);
  void triggerWorker(process.env.URL, process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId);
  return jsonResponse(202, { jobId: job.jobId, status: job.status });
}
