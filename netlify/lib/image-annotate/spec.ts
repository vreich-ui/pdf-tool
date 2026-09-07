/**
 * AnnotationSpec v1 — the zod schema for `image.annotate`'s deterministic layout language.
 *
 * This module is pure schema + structural validation: no I/O, no network, no browser, no
 * sharp. It defines what a valid AnnotationSpec document looks like; turning a *valid*
 * document into absolute pixel placements is resolve.ts's job, not this file's.
 *
 * Coordinate conventions (shared with netlify/lib/image-annotate/analyze.ts's grid, though
 * this module does not import that file — T1/T2 are deliberately file-disjoint):
 *   - Cell ids run columns "A".."F" (left -> right) by rows "1".."6" (top -> bottom), so
 *     "A1" is the top-left cell of a fixed 6x6 grid and "F6" the bottom-right.
 *   - Point coordinates and `maxWidth` are normalized 0..1 fractions of the canvas box
 *     (0,0 = top-left, 1,1 = bottom-right), never absolute pixels — resolve.ts is the only
 *     place pixels get computed, from `canvas.w`/`canvas.h`.
 *
 * Design decisions the brief left open (documented here so a reviewer can override them
 * without spelunking resolve.ts):
 *   - Every element (including badge/box/scrim/logo) carries an `id`, not just text/arrow.
 *     Ids are how warnings (`elementId`) and arrow `ElementRef`s address a specific element,
 *     and uniqueness is enforced below.
 *   - `badge.n` is a non-negative integer (a count/index) OR a SHORT string label (<= 4
 *     characters, e.g. "A", "3a", "NEW"). It was integer-only in the first cut of this
 *     schema; the widening is deliberately bounded rather than free text, because a badge is
 *     a fixed-height pill whose width resolve.ts derives from the label's measured width —
 *     an arbitrarily long badge label is a `text` element, not a badge.
 *   - `box`/`scrim`/`avoid[]` all share one `RectSchema`: `{ at: Cell|Point, w, h }` where
 *     `at` is the rect's top-left corner. `avoid[]` reuses it verbatim (a zone to keep clear,
 *     not a renderable element, hence no `id`/`type`).
 *   - `logo.size` is a single 0..1 fraction (of min(canvas.w, canvas.h)) producing a square
 *     bounding box — this schema has no way to know the logo image's real aspect ratio
 *     without decoding bytes, which T1 may not do.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------

/** "A1".."F6" — a fixed 6-column (A-F) x 6-row (1-6) grid cell reference. */
export const cellSchema = z
  .string()
  .regex(/^[A-F][1-6]$/, "cell must be one of A1..F6 (columns A-F, rows 1-6)");
export type Cell = z.infer<typeof cellSchema>;

/** Normalized point: 0..1 fractions of canvas width/height. */
export const pointSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1)
  })
  .strict();
export type Point = z.infer<typeof pointSchema>;

/** "#<id>" — a reference to another element's `id` in the same spec. Existence of the
 * referenced id is checked by annotationSpecSchema's superRefine below, not here (a bare
 * regex can't see the rest of the document). */
export const elementRefSchema = z
  .string()
  .regex(/^#[A-Za-z0-9_-]+$/, 'element reference must look like "#<id>"');
export type ElementRef = z.infer<typeof elementRefSchema>;

/** Element id: the bare identifier an ElementRef points at (without the leading "#"). */
export const elementIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "id must be alphanumeric, '_' or '-'");

/** A position that is either a grid cell or an explicit normalized point. Used for `at`
 * fields (text/badge/logo) and for the `at` corner of a RectSchema. Does NOT include
 * ElementRef — only arrow endpoints may reference another element. */
export const cellOrPointSchema = z.union([cellSchema, pointSchema]);
export type CellOrPoint = z.infer<typeof cellOrPointSchema>;

/** Arrow endpoint: a grid cell, an explicit point, or a reference to another element
 * (resolved, at layout time, to the nearest edge point of that element's box). */
export const arrowEndpointSchema = z.union([cellSchema, pointSchema, elementRefSchema]);
export type ArrowEndpoint = z.infer<typeof arrowEndpointSchema>;

/** A normalized rectangle: `at` is its top-left corner, `w`/`h` are 0..1 fractions of the
 * canvas. Shared by box/scrim elements and by top-level `avoid[]` zones. */
export const rectSchema = z
  .object({
    at: cellOrPointSchema,
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1)
  })
  .strict();
export type SpecRect = z.infer<typeof rectSchema>;

/** Hex color, 3/6/8 digit forms (#rgb, #rrggbb, #rrggbbaa). */
export const hexColorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "must be a #rgb/#rrggbb/#rrggbbaa hex color");

/** Minimal, structural stand-in for artifact-core's ArtifactReference (see
 * netlify/lib/artifact-core/artifacts.ts). This module has no I/O, so it never fetches or
 * verifies the referenced bytes — it only needs enough of the shape to identify an artifact
 * for T3's renderer later. Extra ArtifactReference fields (tags, metadata, ...) pass
 * through untouched. */
export const artifactRefSchema = z
  .object({
    blobKey: z.string().min(1),
    sha256: z.string().min(1),
    contentType: z.string().min(1).optional()
  })
  .passthrough();
export type SpecArtifactRef = z.infer<typeof artifactRefSchema>;

export const NINE_ANCHORS = ["tl", "tc", "tr", "cl", "c", "cr", "bl", "bc", "br"] as const;
export const anchorSchema = z.enum(NINE_ANCHORS);
export type Anchor = z.infer<typeof anchorSchema>;

// ---------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------

/** Per-style foreground colors. A spec that paints its title white on a dark scrim and its
 * caption near-black on the plain photo has TWO text colors, and checking both against one
 * `theme.textColor` reports a contrast ratio that is wrong for at least one of them — this
 * is the field that makes resolve.ts's contrast check per-element instead of per-document.
 * Every key is optional; a style with no entry falls back to `theme.textColor`, and a theme
 * with neither falls back to resolve.ts's own DEFAULT_TEXT_COLOR. */
export const textColorsSchema = z
  .object({
    label: hexColorSchema.optional(),
    title: hexColorSchema.optional(),
    caption: hexColorSchema.optional(),
    badge: hexColorSchema.optional()
  })
  .strict();
export type AnnotationTextColors = z.infer<typeof textColorsSchema>;

export const themeSchema = z
  .object({
    fontFamily: z.string().min(1).optional(),
    /** Document-wide default foreground color: the fallback for any text `style` that
     * `textColors` does not name. Kept as the base of the two-level lookup rather than
     * replaced, so a spec with one text color stays a one-line theme. */
    textColor: hexColorSchema.optional(),
    /** Per-style overrides of `textColor` — see textColorsSchema. */
    textColors: textColorsSchema.optional(),
    accentColor: hexColorSchema.optional(),
    /** Default tint used by an auto-inserted contrast scrim when the spec's own elements
     * don't already include one. */
    scrimColor: hexColorSchema.optional()
  })
  .strict();
export type AnnotationTheme = z.infer<typeof themeSchema>;

// ---------------------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------------------

export const textStyleSchema = z.enum(["label", "title", "caption", "badge"]);
export type TextStyle = z.infer<typeof textStyleSchema>;
export const textAlignSchema = z.enum(["left", "center", "right"]);
export type TextAlign = z.infer<typeof textAlignSchema>;

export const textElementSchema = z
  .object({
    type: z.literal("text"),
    id: elementIdSchema,
    content: z.string().min(1),
    at: cellOrPointSchema,
    anchor: anchorSchema.default("tl"),
    maxWidth: z.number().min(0).max(1).default(0.9),
    style: textStyleSchema.default("label"),
    align: textAlignSchema.default("left")
  })
  .strict();

export const arrowStyleSchema = z.enum(["thin", "bold", "dashed"]);
export type ArrowStyle = z.infer<typeof arrowStyleSchema>;

export const arrowElementSchema = z
  .object({
    type: z.literal("arrow"),
    id: elementIdSchema,
    from: arrowEndpointSchema,
    to: arrowEndpointSchema,
    curve: z.number().min(-1).max(1).default(0),
    style: arrowStyleSchema.default("thin")
  })
  .strict();

/** Longest badge label accepted as a string. A badge is a fixed-height pill; past a few
 * characters it stops being a badge and becomes a `text` element, so the bound is part of
 * the schema rather than a rendering nicety. */
export const MAX_BADGE_LABEL_LENGTH = 4;

/** A badge's content: a non-negative integer (a count/index) or a short string label. The
 * string branch is trimmed of nothing and validated as-is — leading/trailing whitespace is
 * rejected by the regex, so a label never resolves to a differently-sized box than it
 * reads as. */
export const badgeLabelSchema = z.union([
  z.number().int().min(0),
  z
    .string()
    .min(1)
    .max(MAX_BADGE_LABEL_LENGTH)
    .regex(/^\S(.*\S)?$/, "a badge label must not start or end with whitespace")
]);
export type BadgeLabel = z.infer<typeof badgeLabelSchema>;

export const badgeElementSchema = z
  .object({
    type: z.literal("badge"),
    id: elementIdSchema,
    n: badgeLabelSchema,
    at: cellOrPointSchema
  })
  .strict();

export const boxStyleSchema = z
  .object({
    fill: hexColorSchema.optional(),
    stroke: hexColorSchema.optional(),
    strokeWidthPx: z.number().min(0).optional(),
    radiusPx: z.number().min(0).optional()
  })
  .strict();
export type BoxStyle = z.infer<typeof boxStyleSchema>;

export const boxElementSchema = z
  .object({
    type: z.literal("box"),
    id: elementIdSchema,
    rect: rectSchema,
    style: boxStyleSchema.default({})
  })
  .strict();

export const scrimDirectionSchema = z.enum(["top", "bottom", "left", "right"]);
export type ScrimDirection = z.infer<typeof scrimDirectionSchema>;

export const scrimElementSchema = z
  .object({
    type: z.literal("scrim"),
    id: elementIdSchema,
    rect: rectSchema,
    direction: scrimDirectionSchema.default("bottom"),
    strength: z.number().min(0).max(1).default(0.6)
  })
  .strict();

export const logoElementSchema = z
  .object({
    type: z.literal("logo"),
    id: elementIdSchema,
    at: cellOrPointSchema,
    size: z.number().min(0).max(1),
    artifactRef: artifactRefSchema
  })
  .strict();

export const annotationElementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  arrowElementSchema,
  badgeElementSchema,
  boxElementSchema,
  scrimElementSchema,
  logoElementSchema
]);
export type AnnotationElement = z.infer<typeof annotationElementSchema>;
export type AnnotationElementType = AnnotationElement["type"];

// ---------------------------------------------------------------------------------------
// Top-level spec
// ---------------------------------------------------------------------------------------

export const canvasSchema = z
  .object({
    w: z.number().int().positive(),
    h: z.number().int().positive()
  })
  .strict();

export const baseSchema = z
  .object({
    artifactRef: artifactRefSchema
  })
  .strict();

/**
 * Hard ceiling on `elements`. Not a style opinion — a bound on work this schema is the only
 * place able to impose, because every downstream stage is superlinear or does I/O per
 * element:
 *   - resolve.ts's collision push-out is O(n^2) per iteration x PUSH_ITERATIONS (measured:
 *     ~0.13 s at 1000 elements, ~1.8 s at 4000, ~8.8 s at 8000 — past a synchronous Netlify
 *     function's entire ~10 s budget);
 *   - every `logo` element costs its own artifact verification + blob read in
 *     agent-artifact-image-annotate.ts, and its bytes are held in memory until the render;
 *   - the render service measures at most MAX_IMAGE_MEASURE_SELECTORS (256) elements per
 *     request, so anything past that could not be measured even in principle and would come
 *     back as MEASUREMENT_UNAVAILABLE.
 * 256 is chosen to equal that measurement cap, so a spec that this schema accepts is a spec
 * every element of which can still be measured. An over-long list is refused as
 * TEMPLATE_INVALID naming the cap, never silently truncated.
 */
export const MAX_ANNOTATION_ELEMENTS = 256;
/** Same reasoning for `avoid`: pushOut is O(elements x avoid) per iteration, and an avoid
 * zone is a rectangle, not an element — a spec needing more than this is describing a mask,
 * not a set of keep-clear zones. */
export const MAX_AVOID_ZONES = 64;

const annotationSpecShape = z
  .object({
    version: z.literal(1),
    canvas: canvasSchema,
    base: baseSchema,
    theme: themeSchema.default({}),
    elements: z
      .array(annotationElementSchema)
      .max(MAX_ANNOTATION_ELEMENTS, `elements has more than the ${MAX_ANNOTATION_ELEMENTS}-element cap`)
      .default([]),
    avoid: z.array(rectSchema).max(MAX_AVOID_ZONES, `avoid has more than the ${MAX_AVOID_ZONES}-zone cap`).default([])
  })
  .strict();

export type AnnotationSpecInput = z.input<typeof annotationSpecShape>;
export type AnnotationSpec = z.infer<typeof annotationSpecShape>;

/**
 * AnnotationSpec v1. On top of the per-field checks above, this enforces two document-wide
 * invariants that no single field's schema can see:
 *   1. Every element `id` is unique.
 *   2. Every arrow endpoint written as an ElementRef ("#id") names an id that actually
 *      exists among `elements`.
 */
export const annotationSpecSchema = annotationSpecShape.superRefine((spec, ctx) => {
  const seen = new Map<string, number>();
  spec.elements.forEach((el, index) => {
    const firstIndex = seen.get(el.id);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate element id "${el.id}" (first seen at elements[${firstIndex}])`,
        path: ["elements", index, "id"]
      });
    } else {
      seen.set(el.id, index);
    }
  });

  spec.elements.forEach((el, index) => {
    if (el.type !== "arrow") return;
    for (const [field, endpoint] of [
      ["from", el.from],
      ["to", el.to]
    ] as const) {
      if (typeof endpoint === "string" && endpoint.startsWith("#")) {
        const targetId = endpoint.slice(1);
        if (!seen.has(targetId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `arrow "${el.id}".${field} references unknown element id "${targetId}"`,
            path: ["elements", index, field]
          });
        }
      }
    }
  });
});
