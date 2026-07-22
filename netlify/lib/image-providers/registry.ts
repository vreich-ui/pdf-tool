/**
 * Model → provider routing: prefix rules (`fal-ai/*` → fal; `gpt-image*`/`dall-e*` →
 * openai) plus friendly aliases. Unknown models error LISTING valid values — never a
 * silent fallback.
 */
import { RenderError } from "../pdf-render/errors.js";
import { falImageProvider } from "./fal.js";
import { openAiImageProvider } from "./openai.js";
import type { ImageProvider } from "./types.js";

const providers: ImageProvider[] = [falImageProvider, openAiImageProvider];

/** Friendly aliases → canonical model strings. klein/9b over 4b as the default tier:
 * +$0.001/MP for visibly better output; 4b stays explicitly selectable. */
export const IMAGE_MODEL_ALIASES: Record<string, string> = {
  "flux-2": "fal-ai/flux-2/klein/9b",
  "qwen-image": "fal-ai/qwen-image",
  "qwen-image-edit": "fal-ai/qwen-image-edit",
};

export const KNOWN_IMAGE_MODEL_EXAMPLES = [
  "gpt-image-1",
  "fal-ai/flux-2/klein/4b",
  "fal-ai/flux-2/klein/9b",
  "fal-ai/flux-2-pro",
  "fal-ai/flux-2-flex",
  "fal-ai/qwen-image",
  "fal-ai/qwen-image-edit",
  ...Object.keys(IMAGE_MODEL_ALIASES),
] as const;

/** Resolves aliases to canonical model strings; unknown strings pass through unchanged
 * (the provider match below decides whether they are routable). */
export function canonicalImageModel(model: string): string {
  return IMAGE_MODEL_ALIASES[model] ?? model;
}

export function findImageProvider(model: string): ImageProvider | undefined {
  const canonical = canonicalImageModel(model);
  return providers.find((provider) => provider.matches(canonical));
}

/** Resolves the provider for a model or throws IMAGE_MODEL_UNSUPPORTED listing valid values. */
export function resolveImageProvider(model: string | undefined): { provider: ImageProvider; model: string } {
  if (!model) {
    throw new RenderError("IMAGE_MODEL_UNSUPPORTED", `No image model selected; known models include: ${KNOWN_IMAGE_MODEL_EXAMPLES.join(", ")}`);
  }
  const canonical = canonicalImageModel(model);
  const provider = providers.find((candidate) => candidate.matches(canonical));
  if (!provider) {
    throw new RenderError("IMAGE_MODEL_UNSUPPORTED", `Unknown image model "${model}"; known models include: ${KNOWN_IMAGE_MODEL_EXAMPLES.join(", ")}`, {
      model,
      known: [...KNOWN_IMAGE_MODEL_EXAMPLES],
    });
  }
  return { provider, model: canonical };
}
