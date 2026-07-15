import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { jobBlobStore } from "./blob-store.js";
import { getHeader } from "./agent-artifact-jobs.js";

/**
 * Minimal OAuth 2.1 authorization server for the MCP endpoint, implementing exactly what
 * MCP clients (claude.ai custom connectors, MCP Inspector) need: RFC 8414 / RFC 9728
 * metadata, RFC 7591 dynamic client registration, Authorization Code + PKCE (S256), and a
 * token endpoint. Access tokens are self-verifying HMAC tokens so the MCP hot path never
 * depends on Blobs; only the one-time authorization-code exchange touches storage.
 *
 * Access is gated by an owner secret (MCP_OAUTH_PASSWORD, falling back to MCP_CONNECTOR_KEY):
 * the browser consent screen requires it before any code is issued, so only the operator can
 * authorize a connector.
 */

export const MCP_OAUTH_STORE = "mcp-oauth";
export const OAUTH_SCOPE = "mcp";
const AUTH_CODE_TTL_S = 5 * 60;
const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;

export type FunctionHeaders = Record<string, string | undefined> | undefined;

export function publicBaseUrl(headers: FunctionHeaders): string {
  if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL.replace(/\/$/, "");
  if (process.env.URL) return process.env.URL.replace(/\/$/, "");
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL.replace(/\/$/, "");
  const host = getHeader(headers, "host");
  return host ? `https://${host}` : "https://pdf-x.netlify.app";
}

// ── base64url helpers ──

function b64urlEncode(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8")).toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

// ── Owner secret (consent gate) ──

export function oauthOwnerSecret(): string | undefined {
  return process.env.MCP_OAUTH_PASSWORD || process.env.MCP_CONNECTOR_KEY || undefined;
}

export function verifyOwnerSecret(provided: string | undefined): boolean {
  const secret = oauthOwnerSecret();
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Token signing (self-verifying, HMAC-SHA256) ──

function signingSecret(): string {
  const secret = process.env.MCP_OAUTH_SIGNING_SECRET || process.env.AGENT_RUN_TOKEN;
  if (!secret) throw new Error("No signing secret configured (MCP_OAUTH_SIGNING_SECRET or AGENT_RUN_TOKEN)");
  return secret;
}

interface TokenPayload {
  sub: string;
  scope: string;
  typ: "access" | "refresh";
  iat: number;
  exp: number;
  jti: string;
}

/** Signs an arbitrary payload as a self-verifying HMAC envelope: v1.<payload>.<sig>. */
function signEnvelope(payload: Record<string, unknown>): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", signingSecret()).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

function verifyEnvelope(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;
  const expected = createHmac("sha256", signingSecret()).update(`v1.${body}`).digest("base64url");
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  try {
    return JSON.parse(b64urlDecode(body).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function signToken(payload: TokenPayload): string {
  return signEnvelope(payload as unknown as Record<string, unknown>);
}

/** nowSeconds is injectable so token expiry is testable without a real clock. */
function verifyToken(token: string, expectedType: "access" | "refresh", nowSeconds: number): TokenPayload | null {
  const payload = verifyEnvelope(token) as TokenPayload | null;
  if (!payload) return null;
  if (payload.typ !== expectedType) return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  return payload;
}

export function issueTokenPair(subject: string, iatSeconds: number): { accessToken: string; refreshToken: string; expiresIn: number } {
  const accessToken = signToken({ sub: subject, scope: OAUTH_SCOPE, typ: "access", iat: iatSeconds, exp: iatSeconds + ACCESS_TOKEN_TTL_S, jti: randomUUID() });
  const refreshToken = signToken({ sub: subject, scope: OAUTH_SCOPE, typ: "refresh", iat: iatSeconds, exp: iatSeconds + REFRESH_TOKEN_TTL_S, jti: randomUUID() });
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_S };
}

/** Validates an MCP access token issued by this server. Pure/synchronous — no Blobs. */
export function verifyMcpAccessToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  try {
    return verifyToken(token, "access", nowSeconds) !== null;
  } catch {
    return false;
  }
}

export function verifyRefreshToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): TokenPayload | null {
  try {
    return verifyToken(token, "refresh", nowSeconds);
  } catch {
    return null;
  }
}

// ── PKCE ──

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const digest = createHash("sha256").update(codeVerifier).digest("hex");
  const computed = Buffer.from(digest, "hex").toString("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Storage (authorization codes + registered clients) ──

async function store() {
  return jobBlobStore(MCP_OAUTH_STORE, { consistency: "strong" });
}

export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: string;
}

export async function registerClient(input: { redirectUris: string[]; clientName?: string }): Promise<OAuthClientRecord> {
  const record: OAuthClientRecord = {
    clientId: `mcp-${randomBytes(16).toString("hex")}`,
    redirectUris: input.redirectUris,
    clientName: input.clientName,
    createdAt: new Date().toISOString()
  };
  try {
    await (await store()).setJSON(`clients/${record.clientId}.json`, record);
  } catch {
    // Public clients are stateless-usable; persistence is best-effort for later tightening.
  }
  return record;
}

export interface AuthorizationCodePayload {
  typ: "code";
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
}

/**
 * Authorization codes are self-contained signed envelopes, not stored records, so issuing
 * one never depends on Blobs. Security rests on the short TTL and mandatory PKCE (an
 * intercepted code is useless without the client's code_verifier). Single-use is enforced
 * best-effort against storage when it is reachable, and degrades to PKCE-only otherwise.
 */
export function issueAuthorizationCode(
  input: { clientId: string; redirectUri: string; codeChallenge: string; scope: string },
  iatSeconds = Math.floor(Date.now() / 1000)
): string {
  return signEnvelope({ typ: "code", ...input, iat: iatSeconds, exp: iatSeconds + AUTH_CODE_TTL_S, jti: randomUUID() });
}

/** Best-effort single-use: false = already redeemed (only detectable when storage is up). */
async function markAuthorizationCodeUsed(jti: string): Promise<boolean> {
  try {
    const s = await store();
    const key = `used-codes/${jti}.json`;
    const existing = await s.get(key, { type: "json" }).catch(() => null);
    if (existing) return false;
    await s.setJSON(key, { usedAt: new Date().toISOString() });
    return true;
  } catch {
    // Storage unavailable: fall back to PKCE-only protection rather than blocking the flow.
    return true;
  }
}

/** Verifies a signed authorization code (signature + type + expiry), then applies best-effort
 * single-use. Returns null when invalid, expired, or already redeemed. */
export async function redeemAuthorizationCode(code: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<AuthorizationCodePayload | null> {
  const payload = verifyEnvelope(code) as AuthorizationCodePayload | null;
  if (!payload || payload.typ !== "code") return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (!payload.clientId || !payload.redirectUri || !payload.codeChallenge || !payload.jti) return null;
  if (!(await markAuthorizationCodeUsed(payload.jti))) return null;
  return payload;
}

// ── Redirect-URI policy ──

export function isAllowedRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) return false;
  const allowlist = (process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length === 0) return true;
  return allowlist.includes(url.hostname.toLowerCase());
}

// ── Metadata documents ──

export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: baseUrl
  };
}

export function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    service_documentation: baseUrl
  };
}
