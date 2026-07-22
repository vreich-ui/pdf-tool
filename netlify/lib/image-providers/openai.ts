/**
 * OpenAI provider: an extraction of the pre-PR6 behavior behind the adapter interface —
 * generate/edit delegate to the existing agent-image-generation/-editing helpers (their
 * client/apiKey/test seams unchanged, existing suites stay green).
 *
 * Capability fix carried by this extraction: `supports("image_variation", "gpt-image-1")`
 * is FALSE — the old code fell through to a DALL·E-2-only variations call that broke on
 * gpt-image models. The workflow now checks supports() and fails loudly with
 * IMAGE_EDIT_MODE_UNSUPPORTED instead of silently mis-calling the API.
 */
import { generateImageArtifactBytes, type GeneratedImageBytes } from "../agent-image-generation.js";
import { editImageArtifactBytes, type ImageEditingClient } from "../agent-image-editing.js";
import type { ImageEditFeature, ImageProvider, ImageProviderEditInput, ImageProviderGenerateInput } from "./types.js";

export const openAiImageProvider: ImageProvider = {
  id: "openai",
  matches: (model) => model.startsWith("gpt-image") || model.startsWith("dall-e") || model.startsWith("test-") || model.startsWith("alternate-test-"),
  requiredEnv: ["OPENAI_API_KEY"],
  available: () => Boolean(process.env.OPENAI_API_KEY),
  supports: (feature: ImageEditFeature, model: string) => {
    if (feature === "masked_edit") return true;
    // Variations are a DALL·E-2-only API; gpt-image models have no variations endpoint.
    return model.startsWith("dall-e-2") || model.startsWith("test-") || model.startsWith("alternate-test-");
  },
  unitPriceUsdPerMegapixel: () => undefined,
  async generate(input: ImageProviderGenerateInput): Promise<GeneratedImageBytes> {
    return generateImageArtifactBytes({
      prompt: input.prompt,
      client: input.client as Parameters<typeof generateImageArtifactBytes>[0]["client"],
      apiKey: input.apiKey,
      model: input.model,
      size: input.size,
      outputFormat: input.outputFormat,
      maxBytes: input.maxBytes,
    });
  },
  async edit(input: ImageProviderEditInput): Promise<GeneratedImageBytes> {
    return editImageArtifactBytes({
      mode: input.mode,
      sourceBytes: input.sourceBytes,
      maskBytes: input.maskBytes,
      instructions: input.instructions,
      client: input.client as ImageEditingClient | undefined,
      apiKey: input.apiKey,
      model: input.model,
      size: input.size,
      outputFormat: input.outputFormat,
      maxBytes: input.maxBytes,
    });
  },
};
