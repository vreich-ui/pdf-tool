/**
 * Fail-fast image-byte validation, shared by every renderer path that accepts caller-supplied
 * image bytes (pdfme `data` image fields, react-pdf docTree dataUri/jobAsset images, and the
 * chromium/typst job-assets.images resolver).
 *
 * QA finding (bug #1): a render job given corrupted/truncated base64 image data never
 * transitioned out of `status: "running"` — every OTHER invalid input in this pipeline (oversize
 * output, bad size string, missing prompt, bad template id) fails fast with a specific error,
 * but a bad image slipped past every existing check (magic-byte sniffing only looks at the
 * first few bytes) and was handed directly to the underlying renderer, which is not guaranteed
 * to fail cleanly (or quickly) on malformed input it wasn't hardened against.
 *
 * `sharp` (already a direct dependency, backed by libvips) is used as the decode oracle: a
 * FULL raw decode (not just header/metadata probing, which a truncated body can still pass)
 * either succeeds or rejects promptly. Never call this with untrusted bytes wrapped only in a
 * `.metadata()` check — that only validates the header.
 */
import { RenderError } from "./errors.js";

/** Generous but bounded — this guards against a hang/hog, not against legitimate large images
 * (the callers of this module already enforce their own byte-size ceilings separately). */
const DECODE_CHECK_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Asserts that `bytes` decodes as a real, complete raster image. Throws RenderError
 * IMAGE_DECODE_ERROR (naming `fieldName`) on anything that isn't a fully decodable image —
 * garbage bytes, a truncated/corrupted body, or an unsupported format.
 */
export async function assertImageBytesDecodable(fieldName: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength === 0) {
    throw new RenderError("IMAGE_DECODE_ERROR", `Image field "${fieldName}" is empty (0 bytes) after decoding — not a valid image`, { field: fieldName });
  }
  const { default: sharp } = await import("sharp");
  try {
    // A full raw decode (not just .metadata()) forces every pixel to be read, so a truncated
    // or otherwise corrupted body — which still carries a valid-looking header — is caught
    // here instead of surfacing later as a renderer-specific hang or a leaked internal error.
    await withTimeout(
      sharp(bytes).ensureAlpha().raw().toBuffer(),
      DECODE_CHECK_TIMEOUT_MS,
      `Image field "${fieldName}" did not decode within ${DECODE_CHECK_TIMEOUT_MS}ms`
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RenderError(
      "IMAGE_DECODE_ERROR",
      `Image field "${fieldName}" could not be decoded as an image (${reason}). Check that the base64 payload is complete and untruncated.`,
      { field: fieldName, reason }
    );
  }
}

/**
 * F3: an `http(s)://` value handed to an image field previously fell through to the same
 * base64-decode path as a real data URI — decoding the URL STRING ITSELF as image bytes,
 * which fails 100% of the time with a leaked, confusing decoder error ("SOI not found in
 * JPEG") instead of a clear message. This service does not fetch remote URLs server-side for
 * template image fields; reject the shape explicitly and point at the supported alternative.
 */
export function assertNotRemoteUrl(fieldName: string, value: string): void {
  if (/^https?:\/\//i.test(value.trim())) {
    throw new RenderError(
      "IMAGE_DECODE_ERROR",
      `Image field "${fieldName}" expects a data URI or asset reference, got a URL ("${value.slice(0, 80)}"). ` +
        "This renderer does not fetch remote image URLs at render time — use import_image_from_url (or import_images_from_url) " +
        "to fetch and store the image first, then pass the resulting data URI / asset reference here.",
      { field: fieldName }
    );
  }
}

/** Decodes a `data:<mime>;base64,<...>` (or bare base64) string to bytes and validates it. */
export async function assertImageDataUriDecodable(fieldName: string, dataUri: string): Promise<Buffer> {
  assertNotRemoteUrl(fieldName, dataUri);
  const comma = dataUri.indexOf(",");
  const base64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new RenderError("IMAGE_DECODE_ERROR", `Image field "${fieldName}" is not valid base64`, { field: fieldName });
  }
  await assertImageBytesDecodable(fieldName, bytes);
  return bytes;
}
