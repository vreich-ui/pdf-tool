/**
 * Bundled-fonts directory resolution, shared by the typst and chromium engines.
 * render-service/src/fonts.ts is always one directory below render-service/ — this holds for
 * both the tsx (src) and compiled (dist) layouts.
 */
import { existsSync } from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RENDER_SERVICE_ROOT = path.join(dirname(fileURLToPath(import.meta.url)), "..");

/** FONT_DIR: env override, else /srv/fonts (image path), else the local repo fonts/ dir. */
export function resolveFontDir(): string {
  const envDir = process.env.RENDER_SERVICE_FONT_DIR;
  if (envDir) return envDir;
  if (existsSync("/srv/fonts")) return "/srv/fonts";
  return path.join(RENDER_SERVICE_ROOT, "fonts");
}

// ---------------------------------------------------------------------------
// Font-family normalization (chromium engine only — see engines/chromium.ts)
//
// Chromium templates carry raw CSS `font-family` values. Two things go wrong with those
// unmodified: (1) render-service only ever bundles Noto faces (see render-service/fonts/), so
// a named brand/system font ("Georgia", "'Inter Variable'", "Helvetica Neue") resolves to
// whatever generic serif/sans-serif Chromium falls back to in the container — observed as
// LiberationSerif — and (2) a template that re-quotes an already-quoted brand stack (e.g.
// wraps `'Inter Variable', system-ui, sans-serif` in another layer of quotes) produces invalid
// CSS that Chromium silently ignores, same symptom. Both are fixed by reducing every
// font-family declaration down to a single, plain (unquoted-then-requoted) family name that is
// guaranteed to resolve: an uploaded request font if one matches, else a bundled Noto face.
// ---------------------------------------------------------------------------

export type GenericFontRole = "sans" | "serif" | "mono";

/** Strips one layer of surrounding matching quotes (") or (') from a single CSS token, plus
 * surrounding whitespace. Not a full CSS tokenizer — deliberately narrow: font-family stack
 * entries are the only thing this ever sees. */
function stripSurroundingQuotes(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * Normalizes a raw CSS `font-family` value — a single family (`Georgia`, `'Inter Variable'`)
 * or a comma-separated stack (`Georgia,'Times New Roman',serif`) — down to the FIRST family,
 * with any surrounding quotes and whitespace stripped. This is the one normalization step
 * every downstream consumer (bundled-face mapping, request-font matching) builds on, so a
 * family is never compared or re-emitted still wrapped in its original quoting.
 */
export function normalizeFontFamilyStack(raw: string): string {
  const [first = ""] = raw.split(",");
  return stripSurroundingQuotes(first);
}

/** Every entry of a stack, quote-stripped, in order. */
export function fontFamilyStackEntries(raw: string): string[] {
  return raw.split(",").map(stripSurroundingQuotes).filter((entry) => entry.length > 0);
}

/**
 * W3 — the CSS-wide keywords. `font-family: inherit` is not a family name: it means "take the
 * computed value of my parent". Reducing it to a concrete face (which is what happens when an
 * unrecognized name falls back to the bundled sans) silently overrides an inherited serif
 * heading font with NotoSans — a NEW wrong-font bug introduced by the very rewrite that
 * exists to fix wrong fonts. These values are left exactly as the template wrote them.
 */
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

export function isCssWideKeyword(raw: string): boolean {
  return CSS_WIDE_KEYWORDS.has(raw.trim().toLowerCase());
}

/** Named families mapped onto a generic role. Keys are matched case-insensitively against the
 * ALREADY-NORMALIZED (quote-stripped, first-of-stack) family name — deliberately small and
 * literal rather than heuristic; an unrecognized name is a normal, expected case (see
 * `bundledFallbackFamily`), not something to guess at. */
const GENERIC_FAMILY_ROLE: Record<string, GenericFontRole> = {
  // generic CSS keywords
  "sans-serif": "sans",
  "system-ui": "sans",
  "ui-sans-serif": "sans",
  "-apple-system": "sans",
  serif: "serif",
  "ui-serif": "serif",
  monospace: "mono",
  "ui-monospace": "mono",
  // common named sans faces (brand stacks, OS defaults)
  "inter": "sans",
  "inter variable": "sans",
  helvetica: "sans",
  "helvetica neue": "sans",
  arial: "sans",
  roboto: "sans",
  "segoe ui": "sans",
  verdana: "sans",
  tahoma: "sans",
  calibri: "sans",
  "open sans": "sans",
  // common named serif faces
  georgia: "serif",
  "times new roman": "serif",
  times: "serif",
  palatino: "serif",
  garamond: "serif",
  cambria: "serif",
  "book antiqua": "serif",
  // common named monospace faces
  courier: "mono",
  "courier new": "mono",
  consolas: "mono",
  monaco: "mono",
  "sf mono": "mono",
};

/** Classifies an already-normalized family name as sans/serif/mono, or `undefined` when the
 * name is not recognized (a custom/brand name with no sensible built-in mapping). */
export function classifyFontFamily(normalizedName: string): GenericFontRole | undefined {
  return GENERIC_FAMILY_ROLE[normalizedName.trim().toLowerCase()];
}

/**
 * W3 — classifies a whole stack by its FIRST recognizable entry, not just its head.
 *
 * A brand stack names its custom face first and its generic intent last, which is the entire
 * point of a stack: `"Canela Deck", Georgia, serif`. Classifying only the head threw that
 * intent away — an unrecognized brand name fell straight to the sans fallback, so a serif
 * heading rendered in NotoSans. That is the same wrong-font symptom T1.6 was written to fix,
 * just arriving through the fix instead of around it. The head still wins whenever it IS
 * recognized, so nothing that resolved before resolves differently now.
 */
export function classifyFontFamilyStack(raw: string): GenericFontRole | undefined {
  for (const entry of fontFamilyStackEntries(raw)) {
    const role = classifyFontFamily(entry);
    if (role) return role;
  }
  return undefined;
}

/**
 * Maps a generic role onto the bundled Noto family name that carries it (see BUNDLED_FONTS in
 * engines/chromium.ts, and render-service/fonts/: NotoSans + NotoSerif, no bundled monospace
 * face today). `mono` and an unrecognized/`undefined` role both fall back to the bundled sans
 * face — a template naming a family with no sensible mapping still renders (D-A-adjacent: this
 * is a quality fallback, never a render failure).
 */
export function bundledFallbackFamily(role: GenericFontRole | undefined): "NotoSans" | "NotoSerif" {
  return role === "serif" ? "NotoSerif" : "NotoSans";
}
