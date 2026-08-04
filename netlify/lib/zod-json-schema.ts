import { z } from "zod";

// `z.ZodTypeAny` (namespace-member type access) resolves reliably across zod's dual v3/v4
// package export shapes; a bare `import type { ZodTypeAny } from "zod"` does not always
// resolve under NodeNext module resolution against zod's `.d.cts` types entry.
type ZodTypeAny = z.ZodTypeAny;

/**
 * Minimal, dependency-free zod -> JSON Schema (draft-ish, MCP-tool-schema flavored) converter.
 *
 * S4 (surface): "a single validator: zod as source of truth, advertised JSON schema
 * generated from it, enforced at the transport layer" — this is that generator. It covers
 * exactly the zod node types pdf-tool's tool schemas use (objects, strings, numbers,
 * booleans, arrays, enums, optional/default/nullable wrappers, unknown/any passthrough,
 * records, and ZodEffects from .superRefine()/.refine()). Anything outside that vocabulary
 * throws immediately (at module load, via the tool-schema smoke test) rather than silently
 * emitting a wrong schema — a deliberate fail-fast so a future zod-shape drift is caught
 * long before it reaches a client.
 *
 * Deliberately NOT the `zod-to-json-schema` npm package: pdf-tool's tool schemas are a small,
 * fixed vocabulary, and a hand-rolled converter keeps exact control over the emitted shape
 * (additionalProperties placement, description passthrough) with zero new supply-chain
 * surface for a file every tool call schema-checks against.
 */

interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  [extra: string]: unknown;
}

type ZodDef = { typeName: string; [key: string]: unknown };

function def(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/** Unwraps the description a caller attached via `.describe()`, if any. */
function withDescription(schema: JsonSchema, description: string | undefined): JsonSchema {
  return description ? { ...schema, description } : schema;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const d = def(schema);
  const description = (d as { description?: string }).description;

  switch (d.typeName) {
    case "ZodObject": {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptionalZodType(value)) required.push(key);
      }
      const unknownKeys = (d as { unknownKeys?: string }).unknownKeys;
      const out: JsonSchema = {
        type: "object",
        properties,
        additionalProperties: unknownKeys === "passthrough",
        ...(required.length > 0 ? { required } : {})
      };
      return withDescription(out, description);
    }
    case "ZodRecord": {
      const valueType = d.valueType as ZodTypeAny;
      return withDescription({ type: "object", additionalProperties: zodToJsonSchema(valueType) }, description);
    }
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const check of (d.checks as Array<{ kind: string; value?: number }>) ?? []) {
        if (check.kind === "min" && typeof check.value === "number") out.minLength = check.value;
        if (check.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
      }
      return withDescription(out, description);
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const check of (d.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) ?? []) {
        if (check.kind === "int") out.type = "integer";
        if (check.kind === "min" && typeof check.value === "number") {
          if (check.inclusive === false) out.exclusiveMinimum = check.value;
          else out.minimum = check.value;
        }
      }
      return withDescription(out, description);
    }
    case "ZodBoolean":
      return withDescription({ type: "boolean" }, description);
    case "ZodArray": {
      const itemType = (d.type as ZodTypeAny);
      return withDescription({ type: "array", items: zodToJsonSchema(itemType) }, description);
    }
    case "ZodEnum": {
      const values = d.values as string[];
      return withDescription({ type: "string", enum: [...values] }, description);
    }
    case "ZodLiteral":
      return withDescription({ const: d.value }, description);
    case "ZodOptional":
    case "ZodDefault": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny);
      if (d.typeName === "ZodDefault") {
        const defaultValue = (d.defaultValue as () => unknown)();
        return { ...inner, default: defaultValue };
      }
      return description ? withDescription(inner, description) : inner;
    }
    case "ZodNullable": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny);
      const innerType = inner.type;
      const type = Array.isArray(innerType) ? [...innerType, "null"] : innerType ? [innerType, "null"] : undefined;
      return withDescription({ ...inner, ...(type ? { type } : {}) }, description);
    }
    case "ZodEffects":
      // .superRefine()/.refine() wrap the schema without changing its shape.
      return zodToJsonSchema(d.schema as ZodTypeAny);
    case "ZodUnknown":
    case "ZodAny":
      return withDescription({}, description);
    case "ZodUnion": {
      // Only used for simple scalar unions in pdf-tool's schemas (e.g. boolean | string);
      // JSON Schema expresses this as anyOf.
      const options = d.options as ZodTypeAny[];
      return withDescription({ anyOf: options.map((option) => zodToJsonSchema(option)) }, description);
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported zod node type "${d.typeName}" — extend the converter before using this zod construct in an MCP tool schema`);
  }
}

function isOptionalZodType(schema: ZodTypeAny): boolean {
  const typeName = def(schema).typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}
