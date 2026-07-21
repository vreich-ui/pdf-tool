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
