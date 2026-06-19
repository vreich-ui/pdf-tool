import { projectBlobStore } from "./blob-store.js";
import type { ArtifactJobRecord } from "./agent-artifact-jobs.js";
import type { ArtifactReference } from "./artifact-core/index.js";

export const AGENT_ARTIFACT_WORKFLOW_STORE = "agent-artifact-workflows";

export interface ArtifactWorkflowRecord {
  projectId: string;
  requestId: string;
  workflowId?: string;
  jobs: Array<{
    jobId: string;
    artifactKind: ArtifactJobRecord["artifactKind"];
    status: ArtifactJobRecord["status"];
    filename: string;
    slot?: string;
    destination: {
      projectId: string;
      requestId: string;
      artifactKind: ArtifactJobRecord["artifactKind"];
      slot?: string;
      filename: string;
    };
    agentName?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  artifacts: ArtifactReference[];
  updatedAt: string;
}

function safePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Invalid empty path segment");
  return sanitized;
}

export function workflowRecordKey(projectId: string, requestId: string, workflowId?: string): string {
  const suffix = workflowId ? safePart(workflowId) : "default";
  return `projects/${safePart(projectId)}/requests/${safePart(requestId)}/workflows/${suffix}.json`;
}

async function readWorkflowRecord(job: Pick<ArtifactJobRecord, "projectId" | "requestId" | "workflowId">): Promise<ArtifactWorkflowRecord> {
  const store = await projectBlobStore(AGENT_ARTIFACT_WORKFLOW_STORE, { consistency: "strong" });
  const key = workflowRecordKey(job.projectId, job.requestId, job.workflowId);
  const existing = await store.get(key, { type: "json" }).catch(() => null) as ArtifactWorkflowRecord | null;
  return existing ?? { projectId: job.projectId, requestId: job.requestId, workflowId: job.workflowId, jobs: [], artifacts: [], updatedAt: new Date().toISOString() };
}

export async function appendArtifactJobToWorkflow(job: ArtifactJobRecord): Promise<void> {
  if (!job.workflowId && !job.agentName) return;
  const store = await projectBlobStore(AGENT_ARTIFACT_WORKFLOW_STORE, { consistency: "strong" });
  const record = await readWorkflowRecord(job);
  const destination = { projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, slot: job.slot, filename: job.filename };
  const metadata = { jobId: job.jobId, artifactKind: job.artifactKind, status: job.status, filename: job.filename, slot: job.slot, destination, agentName: job.agentName, createdAt: job.createdAt, updatedAt: job.updatedAt };
  record.jobs = [...record.jobs.filter((entry) => entry.jobId !== job.jobId), metadata];
  record.updatedAt = new Date().toISOString();
  await store.setJSON(workflowRecordKey(job.projectId, job.requestId, job.workflowId), record);
}

export async function appendArtifactReferenceToWorkflow(job: ArtifactJobRecord, artifact: ArtifactReference): Promise<void> {
  if (!job.workflowId && !job.agentName) return;
  const store = await projectBlobStore(AGENT_ARTIFACT_WORKFLOW_STORE, { consistency: "strong" });
  const record = await readWorkflowRecord(job);
  const destination = { projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, slot: job.slot, filename: job.filename };
  const completedJob = { jobId: job.jobId, artifactKind: job.artifactKind, status: "complete" as const, filename: job.filename, slot: job.slot, destination, agentName: job.agentName, createdAt: job.createdAt, updatedAt: job.updatedAt };
  record.jobs = record.jobs.some((entry) => entry.jobId === job.jobId)
    ? record.jobs.map((entry) => entry.jobId === job.jobId ? { ...entry, status: "complete", updatedAt: job.updatedAt } : entry)
    : [...record.jobs, completedJob];
  record.artifacts = [...record.artifacts.filter((entry) => entry.sha256 !== artifact.sha256), artifact];
  record.updatedAt = new Date().toISOString();
  await store.setJSON(workflowRecordKey(job.projectId, job.requestId, job.workflowId), record);
}
