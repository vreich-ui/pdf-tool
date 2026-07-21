/**
 * x-render-secret auth. Timing-safe compare against process.env.RENDER_SERVICE_SECRET.
 * We compare sha256 digests (fixed 32-byte length) rather than the raw strings so that
 * timingSafeEqual never throws on a length mismatch and so the raw secret length itself
 * leaks no timing signal.
 */
import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Fails closed: if RENDER_SERVICE_SECRET is unset or empty, every request is unauthorized. */
export function checkAuth(headerValue: string | undefined): boolean {
  const secret = process.env.RENDER_SERVICE_SECRET;
  if (!secret) return false;
  if (!headerValue) return false;
  const secretDigest = sha256(secret);
  const headerDigest = sha256(headerValue);
  return timingSafeEqual(secretDigest, headerDigest);
}
