/**
 * Canonical docTree JSON Schema (draft 2020-12) for the react-pdf renderer.
 *
 * This TypeScript module is the source of truth; the sibling schema.json is a generated
 * copy for out-of-repo consumers, kept byte-identical by a test. Edit THIS file.
 *
 * Design rules: discriminated unions on `type`; NO arbitrary code, NO arbitrary URLs,
 * NO style passthrough — every node type and style property is allowlisted; data binding
 * is declarative only ({{dot.path}} interpolation, $for, $if).
 */

export const DOC_TREE_SCHEMA_ID = "pdf-tool/react-pdf-doctree/v1";

/** Font families shipped in netlify/assets/fonts (Regular + Bold each). */
export const BUNDLED_FONT_FAMILIES = ["NotoSans", "NotoSansHebrew", "NotoSerif"] as const;
export type BundledFontFamily = (typeof BUNDLED_FONT_FAMILIES)[number];

/** Engine limits enforced OUTSIDE the schema (semantic checks in validate.ts / interpreter.ts). */
export const DOC_TREE_LIMITS = {
  maxTreeDepth: 12,
  maxNodes: 3000,
  maxTemplateBytes: 1_000_000,
  maxDistinctAssets: 20,
  maxFonts: 6,
  maxForItemsPerLoop: 1000,
  maxForItemsExpanded: 5000,
  maxDataUriDecodedBytes: 200_000,
  maxInterpolatedChars: 20_000,
  maxAssetBytes: 5_000_000,
  maxAssetBytesTotal: 20_000_000,
  maxFontBytes: 3_000_000,
  maxFontBytesTotal: 10_000_000,
} as const;

/** Dot-path used by {{interpolation}}, $for.items and $if.when.path — no expressions/filters/calls. */
export const DATA_PATH_PATTERN = "^[a-zA-Z_$][a-zA-Z0-9_$]*(\\.[a-zA-Z_$][a-zA-Z0-9_$]*|\\[[0-9]+\\])*$";

const styleRef = { type: "string", maxLength: 64 };
const dimRef = { $ref: "#/$defs/dim" };
const colorRef = { $ref: "#/$defs/color" };

const styleDef = {
  type: "object",
  additionalProperties: false,
  properties: {
    // layout (flexbox)
    flexDirection: { enum: ["row", "column", "row-reverse", "column-reverse"] },
    justifyContent: { enum: ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"] },
    alignItems: { enum: ["flex-start", "flex-end", "center", "stretch", "baseline"] },
    alignSelf: { enum: ["auto", "flex-start", "flex-end", "center", "stretch", "baseline"] },
    flexWrap: { enum: ["nowrap", "wrap", "wrap-reverse"] },
    flexGrow: { type: "number", minimum: 0 },
    flexShrink: { type: "number", minimum: 0 },
    flexBasis: dimRef,
    gap: dimRef,
    rowGap: dimRef,
    columnGap: dimRef,
    // box
    width: dimRef, height: dimRef,
    minWidth: dimRef, maxWidth: dimRef, minHeight: dimRef, maxHeight: dimRef,
    margin: dimRef, marginTop: dimRef, marginRight: dimRef, marginBottom: dimRef, marginLeft: dimRef,
    marginHorizontal: dimRef, marginVertical: dimRef,
    padding: dimRef, paddingTop: dimRef, paddingRight: dimRef, paddingBottom: dimRef, paddingLeft: dimRef,
    paddingHorizontal: dimRef, paddingVertical: dimRef,
    position: { enum: ["relative", "absolute"] },
    top: dimRef, right: dimRef, bottom: dimRef, left: dimRef,
    border: { type: "string", maxLength: 64 },
    borderWidth: dimRef,
    borderColor: colorRef,
    borderStyle: { enum: ["solid", "dashed", "dotted"] },
    borderRadius: dimRef,
    borderTopWidth: dimRef, borderRightWidth: dimRef, borderBottomWidth: dimRef, borderLeftWidth: dimRef,
    backgroundColor: colorRef,
    opacity: { type: "number", minimum: 0, maximum: 1 },
    objectFit: { enum: ["contain", "cover", "fill", "none", "scale-down"] },
    // text
    color: colorRef,
    /** Must match a theme.fonts family or a bundled default family. */
    fontFamily: { type: "string", maxLength: 64 },
    fontSize: { type: "number", minimum: 4, maximum: 144 },
    fontWeight: {
      oneOf: [
        { type: "number", minimum: 100, maximum: 900 },
        { enum: ["normal", "bold"] },
      ],
    },
    fontStyle: { enum: ["normal", "italic"] },
    lineHeight: { type: "number", minimum: 0.5, maximum: 5 },
    letterSpacing: { type: "number", minimum: -10, maximum: 50 },
    textAlign: { enum: ["left", "right", "center", "justify"] },
    textDecoration: { enum: ["none", "underline", "line-through"] },
    textTransform: { enum: ["none", "uppercase", "lowercase", "capitalize"] },
    direction: { enum: ["ltr", "rtl"] },
  },
};

export const DOC_TREE_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: DOC_TREE_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: ["docTreeVersion", "document"],
  properties: {
    docTreeVersion: { const: 1 },
    theme: {
      type: "object",
      additionalProperties: false,
      properties: {
        /** Named styles referenced via styleRef. */
        styles: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/style" },
          maxProperties: 64,
        },
        /** Families usable in fontFamily; resolved server-side. */
        fonts: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["family", "source"],
            properties: {
              family: { type: "string", minLength: 1, maxLength: 64 },
              source: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "name"],
                    properties: {
                      kind: { const: "bundled" },
                      name: { enum: [...BUNDLED_FONT_FAMILIES] },
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "fontId"],
                    properties: {
                      kind: { const: "project" },
                      /** Blobs-stored project font at fonts/<fontId>/font.ttf in the templates store. */
                      fontId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9._-]+$" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
    document: { $ref: "#/$defs/documentNode" },
  },
  $defs: {
    documentNode: {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "document" },
        title: { type: "string", maxLength: 256 },
        author: { type: "string", maxLength: 256 },
        /** e.g. "he" — flips RTL defaults. */
        language: { type: "string", maxLength: 16 },
        children: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/$defs/pageNode" } },
      },
    },
    pageNode: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "page" },
        size: {
          oneOf: [
            { enum: ["A4", "LETTER", "A5", "A3"] },
            {
              type: "array",
              prefixItems: [{ type: "number", exclusiveMinimum: 0 }, { type: "number", exclusiveMinimum: 0 }],
              minItems: 2,
              maxItems: 2,
              items: false,
            },
          ],
        },
        orientation: { enum: ["portrait", "landscape"] },
        /** number(pt) or per-side object; applied as page padding. */
        margin: { $ref: "#/$defs/spacing" },
        style: { $ref: "#/$defs/style" },
        styleRef,
        /** Default true → content reflows to new pages. */
        wrap: { type: "boolean" },
        children: { type: "array", maxItems: 500, items: { $ref: "#/$defs/node" } },
        /** Headers/footers/watermarks (render on every page). */
        fixed: { type: "array", maxItems: 8, items: { $ref: "#/$defs/node" } },
      },
    },
    node: {
      oneOf: [
        { $ref: "#/$defs/viewNode" },
        { $ref: "#/$defs/textNode" },
        { $ref: "#/$defs/imageNode" },
        { $ref: "#/$defs/linkNode" },
        { $ref: "#/$defs/pageNumberNode" },
        { $ref: "#/$defs/eachNode" },
        { $ref: "#/$defs/ifNode" },
      ],
    },
    /** Maps to <View>; flexbox container. */
    viewNode: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "view" },
        style: { $ref: "#/$defs/style" },
        styleRef,
        wrap: { type: "boolean" },
        break: { type: "boolean" },
        minPresenceAhead: { type: "number", minimum: 0 },
        children: { type: "array", maxItems: 500, items: { $ref: "#/$defs/node" } },
      },
    },
    /** Maps to <Text>; content = string with {{path}} interpolation, or inline styled runs. */
    textNode: {
      type: "object",
      additionalProperties: false,
      required: ["type", "content"],
      properties: {
        type: { const: "text" },
        style: { $ref: "#/$defs/style" },
        styleRef,
        content: {
          oneOf: [
            { type: "string", maxLength: 20000 },
            {
              type: "array",
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text"],
                properties: {
                  text: { type: "string", maxLength: 20000 },
                  style: { $ref: "#/$defs/style" },
                  styleRef,
                },
              },
            },
          ],
        },
      },
    },
    /** Maps to <Image>; src is resolved & fetched SERVER-SIDE to bytes before render.
     * NOTE: no http(s) URLs by design; imports go through import_image_from_url first. */
    imageNode: {
      type: "object",
      additionalProperties: false,
      required: ["type", "src"],
      properties: {
        type: { const: "image" },
        style: { $ref: "#/$defs/style" },
        styleRef,
        src: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "blobKey"],
              properties: {
                kind: { const: "artifact" },
                /** Client blob store (grant-scoped); defaults to the project's artifacts store. */
                storeName: { type: "string", maxLength: 128 },
                blobKey: { type: "string", minLength: 1, maxLength: 512 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "assetId"],
              properties: {
                kind: { const: "jobAsset" },
                /** Matches an entry in the job's assets.images array. */
                assetId: { type: "string", minLength: 1, maxLength: 128 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "value"],
              properties: {
                kind: { const: "dataUri" },
                value: { type: "string", maxLength: 2000000, pattern: "^data:image/(png|jpeg|webp);base64," },
              },
            },
          ],
        },
      },
    },
    linkNode: {
      type: "object",
      additionalProperties: false,
      required: ["type", "href", "content"],
      properties: {
        type: { const: "link" },
        /** https only. Interpolation allowed; re-validated as https after binding. */
        href: { type: "string", maxLength: 2048, pattern: "^(https://|\\{\\{)" },
        style: { $ref: "#/$defs/style" },
        styleRef,
        content: { type: "string", maxLength: 2048 },
      },
    },
    pageNumberNode: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "pageNumber" },
        style: { $ref: "#/$defs/style" },
        styleRef,
        format: { enum: ["n", "n-of-total"] },
      },
    },
    /** Repetition: binds the array at `items` (dot path into job data), renders children once per item. */
    eachNode: {
      type: "object",
      additionalProperties: false,
      required: ["type", "items", "children"],
      properties: {
        type: { const: "$for" },
        items: { type: "string", pattern: DATA_PATH_PATTERN, maxLength: 256 },
        /** Loop variable, default "item"; use {{item.x}} and {{index}}. */
        as: { type: "string", pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$", maxLength: 32 },
        /** Hard engine cap 1000 regardless. */
        maxItems: { type: "integer", minimum: 1, maximum: 1000 },
        children: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/$defs/node" } },
      },
    },
    /** Conditional. */
    ifNode: {
      type: "object",
      additionalProperties: false,
      required: ["type", "when", "then"],
      properties: {
        type: { const: "$if" },
        when: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", pattern: DATA_PATH_PATTERN, maxLength: 256 },
            op: { enum: ["exists", "truthy", "eq", "ne", "gt", "lt", "nonEmpty"] },
            value: {},
          },
        },
        then: { type: "array", maxItems: 100, items: { $ref: "#/$defs/node" } },
        else: { type: "array", maxItems: 100, items: { $ref: "#/$defs/node" } },
      },
    },
    /** ALLOWLISTED subset of react-pdf styles; anything else → validation error. */
    style: styleDef,
    color: { type: "string", pattern: "^(#[0-9a-fA-F]{3,8}|rgba?\\([0-9.,\\s%]+\\))$" },
    dim: {
      oneOf: [
        { type: "number" },
        { type: "string", pattern: "^-?\\d+(\\.\\d+)?(pt|mm|cm|in|%|vw|vh)?$" },
      ],
    },
    spacing: {
      oneOf: [
        { type: "number", minimum: 0 },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            top: { type: "number", minimum: 0 },
            right: { type: "number", minimum: 0 },
            bottom: { type: "number", minimum: 0 },
            left: { type: "number", minimum: 0 },
          },
        },
      ],
    },
  },
};
