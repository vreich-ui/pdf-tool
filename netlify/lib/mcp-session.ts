import { randomUUID } from "node:crypto";
import { jobBlobStore } from "./blob-store.js";

export const MCP_SESSION_STORE = "mcp-sessions";
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
export const LATEST_MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_SESSION_TTL_SECONDS = 86_400;

export interface McpSessionRecord {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  protocolVersion: string;
  clientInfo?: { name?: string; version?: string };
}

/** Session ids are server-issued UUIDs; reject anything else before it reaches a blob key. */
export function isValidMcpSessionId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,128}$/.test(value);
}

function sessionKey(sessionId: string): string {
  if (!isValidMcpSessionId(sessionId)) throw new Error("Invalid MCP session id");
  return `sessions/${sessionId}.json`;
}

export function mcpSessionTtlMs(): number {
  const raw = Number(process.env.MCP_SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  return (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_TTL_SECONDS) * 1000;
}

/** Echo the client's requested version when supported; otherwise offer our latest. */
export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
  return LATEST_MCP_PROTOCOL_VERSION;
}

async function sessionStore() {
  return jobBlobStore(MCP_SESSION_STORE, { consistency: "strong" });
}

export async function createMcpSession(protocolVersion: string, clientInfo?: { name?: string; version?: string }): Promise<McpSessionRecord> {
  const now = new Date().toISOString();
  const record: McpSessionRecord = { sessionId: randomUUID(), createdAt: now, lastSeenAt: now, protocolVersion, clientInfo };
  const store = await sessionStore();
  await store.setJSON(sessionKey(record.sessionId), record);
  return record;
}

export function isMcpSessionExpired(record: McpSessionRecord, now = Date.now()): boolean {
  const lastSeen = Date.parse(record.lastSeenAt);
  if (!Number.isFinite(lastSeen)) return true;
  return now - lastSeen > mcpSessionTtlMs();
}

/** Returns the live session or null when unknown, malformed, or expired (expired records are removed). */
export async function readMcpSession(sessionId: string): Promise<McpSessionRecord | null> {
  if (!isValidMcpSessionId(sessionId)) return null;
  const store = await sessionStore();
  const record = await store.get(sessionKey(sessionId), { type: "json" }).catch(() => null) as McpSessionRecord | null;
  if (!record?.sessionId) return null;
  if (isMcpSessionExpired(record)) {
    await store.delete?.(sessionKey(sessionId));
    return null;
  }
  return record;
}

export async function touchMcpSession(record: McpSessionRecord): Promise<void> {
  const store = await sessionStore();
  await store.setJSON(sessionKey(record.sessionId), { ...record, lastSeenAt: new Date().toISOString() });
}

/** Deletes the session; returns false when it did not exist (or was already expired). */
export async function deleteMcpSession(sessionId: string): Promise<boolean> {
  const record = await readMcpSession(sessionId);
  if (!record) return false;
  const store = await sessionStore();
  await store.delete?.(sessionKey(sessionId));
  return true;
}
