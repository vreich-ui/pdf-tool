import { AsyncLocalStorage } from "node:async_hooks";
import {
  CANONICAL_STORAGE_STORES,
  currentStorageGrant,
  extractStorageGrant,
  runWithStorageGrant,
  type StorageGrant,
  type StorageGrantLimits,
  type StorageGrantStores
} from "./storage-grant.js";
import type { ArtifactKind } from "./artifact-core/artifacts.js";

/**
 * Caller-supplied project descriptor — the stateless replacement for the deleted
 * agent-project-registry / project-adapters model. pdf-tool no longer knows any client by
 * name: the caller self-describes per request with a `descriptor` argument (all fields
 * optional; a minimal caller sends only the storage grant and gets the defaults below),
 * and the storage grant supplies the credentials + store names. Any projectId works with
 * zero pdf-tool-side registration; the grant↔descriptor↔request projectId binding is the
 * tenant boundary, enforced on every entrypoint.
 */

export interface ProjectDescriptor {
  projectId?: string;
  /** Store-name overrides for keys the GRANT does not explicitly name (grant wins). */
  storeNames?: Partial<StorageGrantStores>;
  /** Generation-model allowlist; defaults to DEFAULT_ALLOWED_MODELS. */
  allowedModels?: string[];
  /** Model used when a job omits `model` (after usage-context routing); defaults to DEFAULT_IMAGE_MODEL. */
  defaultModel?: string;
  /** Artifact kinds this caller may create; defaults to DEFAULT_ALLOWED_ARTIFACT_KINDS. */
  allowedKinds?: ArtifactKind[];
  /** Full-match pattern for request ids (e.g. "req_[a-z0-9]+_\\d{8}_\\d{2}"), in a SAFE
   * regex subset (literals, escapes, classes, quantifiers on single atoms — no groups or
   * alternation; see REQUEST_ID_PATTERN_CONTRACT) matched by a linear-time engine. When
   * declared, writes under a non-conforming id FAIL instead of creating client-side
   * orphans. */
  requestIdPattern?: string;
}

export const PROJECT_DESCRIPTOR_VERSION = "descriptor-v1";

export const DEFAULT_ALLOWED_ARTIFACT_KINDS: ArtifactKind[] = ["image", "pdf"];
export const DEFAULT_IMAGE_MODEL = "gpt-image-1";

/**
 * Default model allowlist — carried over VERBATIM from the deleted dr-lurie adapter so the
 * effective policy does not silently widen or narrow for callers (Platform sends no
 * allowedModels today). A caller tightens or widens it by sending descriptor.allowedModels.
 */
export const DEFAULT_ALLOWED_MODELS = [
  "gpt-image-1",
  "test-image-model",
  "alternate-test-image-model",
  // fal.ai backends (PR6) — canonical names plus the friendly aliases the registry
  // resolves (flux-2 → klein/9b default tier).
  "fal-ai/flux-2/klein/4b",
  "fal-ai/flux-2/klein/9b",
  "fal-ai/flux-2-pro",
  "fal-ai/flux-2-flex",
  "fal-ai/qwen-image",
  "fal-ai/qwen-image-edit",
  "flux-2",
  "qwen-image",
  "qwen-image-edit",
] as const;

const ARTIFACT_KINDS: ArtifactKind[] = ["image", "pdf", "binary"];
const STORE_KEYS: Array<keyof StorageGrantStores> = ["artifacts", "artifactIndex", "templates", "imageSearch", "renderData", "jobs"];

export type ParseProjectDescriptorResult =
  | { ok: true; descriptor: ProjectDescriptor }
  | { ok: false; error: string };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** ReDoS guard bounds: the pattern is caller-supplied and executed server-side, so both
 * the pattern and the ids it is tested against are strictly bounded. */
export const MAX_REQUEST_ID_PATTERN_LENGTH = 256;
export const MAX_PATTERN_CHECKED_REQUEST_ID_LENGTH = 256;

export const REQUEST_ID_PATTERN_CONTRACT =
  "safe pattern subset: literal characters, escapes (\\d \\D \\w \\W \\s \\S and escaped literals), '.' for any character, character classes like [a-z0-9^-], and quantifiers ? * + {m} {m,} {m,n} on single atoms — groups, alternation, anchors and backreferences are not supported";

/**
 * Caller-supplied request-id patterns are NEVER run through the JS RegExp engine: its
 * backtracking matcher has caller-triggerable exponential blowups that no denylist
 * reliably excludes (nested quantifiers, adjacent unbounded quantifiers, variable-length
 * alternation — each confirmed to hang the function for minutes within modest length
 * caps). Instead the pattern language is a restricted subset — a linear SEQUENCE of
 * quantified single-character atoms — parsed here and matched with a set-of-positions
 * simulation whose worst case is O(patternElements × idLength²) on strictly bounded
 * inputs (≈8M steps absolute worst): milliseconds, regardless of pattern content. The
 * subset fully covers request-id conventions (e.g. req_[a-z0-9]+_[a-z0-9]+_\d{8}_\d{2}).
 */
interface RequestIdPatternElement {
  min: number;
  /** Number.POSITIVE_INFINITY for * + {m,} */
  max: number;
  test(char: string): boolean;
}

export type ParseRequestIdPatternResult =
  | { ok: true; elements: RequestIdPatternElement[] }
  | { ok: false; error: string };

const CLASS_ESCAPES: Record<string, (char: string) => boolean> = {
  d: (c) => c >= "0" && c <= "9",
  D: (c) => !(c >= "0" && c <= "9"),
  w: (c) => /[A-Za-z0-9_]/.test(c),
  W: (c) => !/[A-Za-z0-9_]/.test(c),
  s: (c) => /\s/.test(c),
  S: (c) => !/\s/.test(c)
};

export function parseRequestIdPattern(pattern: string): ParseRequestIdPatternResult {
  if (pattern.length > MAX_REQUEST_ID_PATTERN_LENGTH) {
    return { ok: false, error: `pattern exceeds ${MAX_REQUEST_ID_PATTERN_LENGTH} characters` };
  }
  const elements: RequestIdPatternElement[] = [];
  let i = 0;
  const fail = (reason: string): ParseRequestIdPatternResult => ({ ok: false, error: `${reason} (at position ${i}); ${REQUEST_ID_PATTERN_CONTRACT}` });

  const parseEscape = (): ((char: string) => boolean) | { error: string } => {
    const next = pattern[i + 1];
    if (next === undefined) return { error: "dangling backslash" };
    i += 2;
    const classEscape = CLASS_ESCAPES[next];
    if (classEscape) return classEscape;
    if (next >= "1" && next <= "9") return { error: "backreferences are not supported" };
    return (c) => c === next;
  };

  while (i < pattern.length) {
    const char = pattern[i];
    let atom: (c: string) => boolean;

    if (char === "(" || char === ")" || char === "|" || char === "^" || char === "$") {
      return fail(`"${char}" is not supported`);
    } else if (char === "*" || char === "+" || char === "?" || char === "{") {
      return fail(`quantifier "${char}" must follow a literal, escape, '.', or character class`);
    } else if (char === "\\") {
      const parsed = parseEscape();
      if (typeof parsed !== "function") return fail(parsed.error);
      atom = parsed;
    } else if (char === ".") {
      i += 1;
      atom = () => true;
    } else if (char === "[") {
      i += 1;
      const negated = pattern[i] === "^";
      if (negated) i += 1;
      const predicates: Array<(c: string) => boolean> = [];
      let closed = false;
      while (i < pattern.length) {
        const classChar = pattern[i];
        if (classChar === "]") {
          closed = true;
          i += 1;
          break;
        }
        if (classChar === "\\") {
          const parsed = parseEscape();
          if (typeof parsed !== "function") return fail(parsed.error);
          predicates.push(parsed);
          continue;
        }
        // Range like a-z (a literal '-' at either end stays literal).
        if (pattern[i + 1] === "-" && pattern[i + 2] !== undefined && pattern[i + 2] !== "]" && pattern[i + 2] !== "\\") {
          const from = classChar;
          const to = pattern[i + 2];
          if (from > to) return fail(`invalid character-class range ${from}-${to}`);
          predicates.push((c) => c >= from && c <= to);
          i += 3;
          continue;
        }
        predicates.push((c) => c === classChar);
        i += 1;
      }
      if (!closed) return fail("unterminated character class");
      if (predicates.length === 0) return fail("empty character class");
      atom = negated ? (c) => !predicates.some((p) => p(c)) : (c) => predicates.some((p) => p(c));
    } else {
      i += 1;
      atom = (c) => c === char;
    }

    // Optional quantifier on the atom just parsed.
    let min = 1;
    let max = 1;
    const quantifier = pattern[i];
    if (quantifier === "?") { min = 0; max = 1; i += 1; }
    else if (quantifier === "*") { min = 0; max = Number.POSITIVE_INFINITY; i += 1; }
    else if (quantifier === "+") { min = 1; max = Number.POSITIVE_INFINITY; i += 1; }
    else if (quantifier === "{") {
      const match = pattern.slice(i).match(/^\{(\d{1,3})(?:(,)(\d{1,3})?)?\}/);
      if (!match) return fail("invalid {m,n} quantifier");
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === undefined ? Number.POSITIVE_INFINITY : Number(match[3]);
      if (max < min) return fail(`invalid quantifier {${min},${max}}`);
      i += match[0].length;
    }
    if (pattern[i] === "*" || pattern[i] === "+" || pattern[i] === "?" || pattern[i] === "{") {
      return fail("stacked quantifiers are not supported");
    }
    elements.push({ min, max, test: atom });
  }
  return { ok: true, elements };
}

/** Linear-time full-match: propagates the set of reachable input positions element by
 * element. No backtracking engine is involved, so no pattern can blow up. */
export function requestIdMatchesPattern(elements: RequestIdPatternElement[], id: string): boolean {
  let positions = new Set<number>([0]);
  for (const element of elements) {
    const next = new Set<number>();
    for (const position of positions) {
      // Longest run of matching characters starting here bounds the repetitions.
      let run = 0;
      while (position + run < id.length && element.test(id[position + run])) run += 1;
      const upper = Math.min(element.max, run);
      for (let count = element.min; count <= upper; count += 1) next.add(position + count);
    }
    if (next.size === 0) return false;
    positions = next;
  }
  return positions.has(id.length);
}

export function parseProjectDescriptor(input: unknown): ParseProjectDescriptorResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "project descriptor must be an object" };
  }
  const value = input as Record<string, unknown>;
  const descriptor: ProjectDescriptor = {};

  const projectId = asString(value.projectId) ?? asString(value.project_id);
  if (projectId) descriptor.projectId = projectId;

  const storeNamesInput = value.storeNames ?? value.store_names ?? value.stores;
  if (storeNamesInput !== undefined) {
    if (!storeNamesInput || typeof storeNamesInput !== "object" || Array.isArray(storeNamesInput)) {
      return { ok: false, error: "descriptor storeNames must be an object" };
    }
    const storeNames: Partial<StorageGrantStores> = {};
    for (const key of STORE_KEYS) {
      const raw = (storeNamesInput as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      const name = asString(raw);
      if (!name) return { ok: false, error: `descriptor storeNames.${key} must be a non-empty string` };
      storeNames[key] = name;
    }
    if (Object.keys(storeNames).length > 0) descriptor.storeNames = storeNames;
  }

  if (value.allowedModels !== undefined) {
    if (!Array.isArray(value.allowedModels) || value.allowedModels.some((model) => typeof model !== "string" || !model.trim())) {
      return { ok: false, error: "descriptor allowedModels must be an array of non-empty strings" };
    }
    descriptor.allowedModels = (value.allowedModels as string[]).map((model) => model.trim());
  }

  const defaultModel = asString(value.defaultModel);
  if (value.defaultModel !== undefined && !defaultModel) {
    return { ok: false, error: "descriptor defaultModel must be a non-empty string" };
  }
  if (defaultModel) descriptor.defaultModel = defaultModel;

  if (value.allowedKinds !== undefined) {
    if (!Array.isArray(value.allowedKinds) || value.allowedKinds.some((kind) => !(ARTIFACT_KINDS as string[]).includes(kind as string))) {
      return { ok: false, error: `descriptor allowedKinds must be an array of: ${ARTIFACT_KINDS.join(", ")}` };
    }
    descriptor.allowedKinds = value.allowedKinds as ArtifactKind[];
  }

  const requestIdPattern = asString(value.requestIdPattern) ?? asString(value.request_id_pattern);
  if ((value.requestIdPattern !== undefined || value.request_id_pattern !== undefined) && !requestIdPattern) {
    return { ok: false, error: "descriptor requestIdPattern must be a non-empty string" };
  }
  if (requestIdPattern) {
    const parsedPattern = parseRequestIdPattern(requestIdPattern);
    if (!parsedPattern.ok) {
      return { ok: false, error: `descriptor requestIdPattern rejected: ${parsedPattern.error}` };
    }
    descriptor.requestIdPattern = requestIdPattern;
  }

  return { ok: true, descriptor };
}

const projectDescriptorContext = new AsyncLocalStorage<ProjectDescriptor>();

export function runWithProjectDescriptor<T>(descriptor: ProjectDescriptor | undefined, fn: () => T): T {
  return descriptor ? projectDescriptorContext.run(descriptor, fn) : fn();
}

export function currentProjectDescriptor(): ProjectDescriptor | undefined {
  return projectDescriptorContext.getStore();
}

// ── Request context: grant + descriptor extracted and bound together ──

export const STORAGE_GRANT_REQUIRED_CODE = "STORAGE_GRANT_REQUIRED";

export const STORAGE_GRANT_REQUIRED_MESSAGE =
  "Storage grant required: pdf-tool holds no storage credentials of its own (the server-side CLIENT_*/PDF_TOOL_* env fallbacks were removed), so every call must carry the caller's short-lived Netlify Blobs grant as the `storage` argument: " +
  '{ "storage": { "projectId": "<your project>", "siteId": "<netlify site id>", "token": "<blobs token>", "expiresAt": "<ISO>", "stores": { "artifacts", "artifactIndex", "templates", "imageSearch", "renderData", "jobs" } } }. ' +
  "Callers on a Platform site fetch a grant from their artifact bridge; direct callers mint one for their own site. " +
  "An optional `descriptor` argument ({ projectId, storeNames?, allowedModels?, defaultModel?, allowedKinds?, requestIdPattern? }) tunes project policy — omitted fields use pdf-tool defaults, so a grant alone is a complete call.";

export interface RequestContext {
  grant?: StorageGrant;
  descriptor?: ProjectDescriptor;
}

export interface ExtractRequestContextResult {
  ctx?: RequestContext;
  error?: string;
  errorCode?: string;
}

/**
 * Extracts and binds the per-request context from a tool-argument/body object:
 * the `storage` grant, the optional `descriptor`, and the request `projectId` must all
 * agree on the project. With requireGrant (the default for every storage-touching
 * entrypoint), a missing grant fails LOUDLY with a typed, self-explaining error — never a
 * silent read of the wrong (empty) store.
 */
export function extractRequestContext(args: unknown, options: { requireGrant?: boolean } = {}): ExtractRequestContextResult {
  const requireGrant = options.requireGrant ?? true;
  const value = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};

  const extractedGrant = extractStorageGrant(value);
  if (extractedGrant.error) return { error: extractedGrant.error };

  let descriptor: ProjectDescriptor | undefined;
  if (value.descriptor !== undefined && value.descriptor !== null) {
    const parsed = parseProjectDescriptor(value.descriptor);
    if (!parsed.ok) return { error: parsed.error };
    descriptor = parsed.descriptor;
  }

  // Bind grant ↔ descriptor ↔ request projectId (every present pair must agree).
  const requestProjectId = asString(value.projectId) ?? asString(value.project_id);
  const grantProjectId = extractedGrant.grant?.projectId;
  const descriptorProjectId = descriptor?.projectId;
  if (descriptorProjectId && requestProjectId && descriptorProjectId !== requestProjectId) {
    return { error: `descriptor projectId mismatch: descriptor targets ${descriptorProjectId}, request targets ${requestProjectId}` };
  }
  if (descriptorProjectId && grantProjectId && descriptorProjectId !== grantProjectId) {
    return { error: `descriptor projectId mismatch: descriptor targets ${descriptorProjectId}, storage grant is scoped to ${grantProjectId}` };
  }

  if (requireGrant && !extractedGrant.grant) {
    return { error: STORAGE_GRANT_REQUIRED_MESSAGE, errorCode: STORAGE_GRANT_REQUIRED_CODE };
  }

  return { ctx: { grant: extractedGrant.grant, descriptor } };
}

/** extractRequestContext for a raw HTTP body string (tolerates GET/empty/malformed bodies,
 * which then simply carry no grant/descriptor — and fail the requireGrant check loudly). */
export function extractRequestContextFromBody(body: string | null | undefined, options: { requireGrant?: boolean } = {}): ExtractRequestContextResult {
  let parsed: unknown;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
  }
  return extractRequestContext(parsed ?? {}, options);
}

/** Runs fn with both the storage grant and the project descriptor in ambient context. */
export function runWithRequestContext<T>(ctx: RequestContext | undefined, fn: () => T): T {
  return runWithStorageGrant(ctx?.grant, () => runWithProjectDescriptor(ctx?.descriptor, fn));
}

// ── Context-aware policy/store resolution (replaces the registry lookups) ──

/**
 * Effective store names for the current request. Trap-1 rule: the GRANT's explicitly-named
 * stores always win (they name what the credential grants); descriptor.storeNames fills any
 * gaps; canonical names cover the rest. Slot/filename index lookups, template reads, policy
 * stores and job records all resolve through this — never through a hard-coded default.
 */
export function projectStoreNames(): StorageGrantStores {
  const grant = currentStorageGrant();
  const descriptor = currentProjectDescriptor();
  return {
    ...CANONICAL_STORAGE_STORES,
    ...(descriptor?.storeNames ?? {}),
    ...(grant?.explicitStores ?? {})
  };
}

/** Options for artifact-index readers/writers: the index store the grant names. */
export function resolveProjectArtifactIndexOptions(_projectId?: string): { storeName: string } {
  return { storeName: projectStoreNames().artifactIndex };
}

export function projectGrantLimits(): StorageGrantLimits {
  return currentStorageGrant()?.limits ?? {};
}

export function serviceDefaultModel(): string | undefined {
  return process.env.AGENT_ARTIFACT_DEFAULT_MODEL;
}

export function allowedProjectModels(_projectId?: string): Set<string> {
  const descriptor = currentProjectDescriptor();
  const allowed = new Set<string>(descriptor?.allowedModels ?? DEFAULT_ALLOWED_MODELS);
  allowed.add(descriptor?.defaultModel ?? DEFAULT_IMAGE_MODEL);
  const serviceModel = serviceDefaultModel();
  if (serviceModel) allowed.add(serviceModel);
  for (const model of (process.env.AGENT_ARTIFACT_ALLOWED_MODELS ?? "").split(",")) {
    const trimmed = model.trim();
    if (trimmed) allowed.add(trimmed);
  }
  return allowed;
}

export function resolveProjectModel(_projectId?: string, requestedModel?: string): string | undefined {
  return requestedModel || currentProjectDescriptor()?.defaultModel || DEFAULT_IMAGE_MODEL;
}

export function validateProjectModel(projectId: string, model: string | undefined): string | undefined {
  if (!model) return "No generation model configured for project";
  if (!allowedProjectModels(projectId).has(model)) return `Unsupported model for ${projectId}: ${model}`;
  return undefined;
}

export function validateProjectArtifactKind(projectId: string, artifactKind: ArtifactKind): string | undefined {
  const allowedKinds = currentProjectDescriptor()?.allowedKinds ?? DEFAULT_ALLOWED_ARTIFACT_KINDS;
  if (!allowedKinds.includes(artifactKind)) return `Unsupported artifactKind for ${projectId}: ${artifactKind}`;
  return undefined;
}

/** Descriptor-declared request-id convention: fail the write, never create an orphan.
 * The match runs on the linear safe-subset engine only — never the RegExp backtracker. */
export function validateProjectRequestId(requestId: string): string | undefined {
  const pattern = currentProjectDescriptor()?.requestIdPattern;
  if (!pattern) return undefined;
  // Re-parsed at match time (defense in depth against a descriptor that reached the
  // context without going through parseProjectDescriptor); parse cost is linear.
  const parsedPattern = parseRequestIdPattern(pattern);
  if (!parsedPattern.ok) return `descriptor requestIdPattern rejected: ${parsedPattern.error}`;
  if (requestId.length > MAX_PATTERN_CHECKED_REQUEST_ID_LENGTH) {
    return `requestId exceeds ${MAX_PATTERN_CHECKED_REQUEST_ID_LENGTH} characters (the declared requestIdPattern is only tested against bounded ids)`;
  }
  if (!requestIdMatchesPattern(parsedPattern.elements, requestId)) {
    return `requestId "${requestId}" does not match the project's declared requestIdPattern ${pattern}`;
  }
  return undefined;
}

/**
 * Belt-and-braces project binding, callable from any depth (the entrypoints already bind
 * grant↔descriptor↔request): rejects an empty projectId and a projectId that contradicts
 * the active grant or descriptor. Returns an error string, or undefined when access is fine.
 */
export function validateProjectAccess(projectId: string | undefined): string | undefined {
  if (!projectId || !projectId.trim()) return "projectId is required";
  const grantProjectId = currentStorageGrant()?.projectId;
  if (grantProjectId && grantProjectId !== projectId) {
    return `storage grant projectId mismatch: grant is scoped to ${grantProjectId}, request targets ${projectId}`;
  }
  const descriptorProjectId = currentProjectDescriptor()?.projectId;
  if (descriptorProjectId && descriptorProjectId !== projectId) {
    return `descriptor projectId mismatch: descriptor targets ${descriptorProjectId}, request targets ${projectId}`;
  }
  return undefined;
}
