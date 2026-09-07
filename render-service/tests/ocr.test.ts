/**
 * T4 — `POST /ocr/image` (tesseract, `check_image_text`'s backend).
 *
 * Two layers, the same split rasterize.test.ts / chromium-thumbnail.test.ts use:
 *   - contract-level: every refusal code is reachable WITHOUT tesseract being installed, so
 *     the validation surface is covered on any machine.
 *   - integration: real PNG fixtures (precomputed with ImageMagick, embedded below — the
 *     same "precompute rather than generate at runtime" convention
 *     agent-artifact-pdf-rasterize.test.ts's PAGE_PNGS uses, so this suite has no runtime
 *     dependency on ImageMagick) are OCR'd and the recognized text is checked. Skipped with a
 *     printed note when tesseract is absent — the Dockerfile is what guarantees it in deploy,
 *     and this suite must never silently pass a check it did not actually run.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { MAX_OCR_IMAGE_BYTES, SUPPORTED_OCR_LANGUAGES, tesseractVersion, validateOcrRequest } from "../src/ocr.js";

const SECRET = "ocr-secret";

let TESSERACT_AVAILABLE = false;

before(async () => {
  TESSERACT_AVAILABLE = (await tesseractVersion()) !== null;
  if (!TESSERACT_AVAILABLE) {
    // eslint-disable-next-line no-console
    console.log("tesseract not found: skipping the /ocr/image integration tests (contract-level tests still run).");
  }
});

/**
 * Three DISTINCT PNGs, precomputed with `convert` (ImageMagick) and verified against a real
 * tesseract 5.3.4 invocation at fixture-authoring time — NOT generated at runtime, so this
 * suite has no ImageMagick dependency:
 *   - BLANK: 300x80 solid white, no text at all — the `expect_none` PASS case.
 *   - LEAKED: 300x80 white with the word "NAC" rendered onto it — stands in for exactly the
 *     defect class this whole feature exists to catch (BRIEF: "the NAC/cysteine/glutathione
 *     failure"): text that leaked out of an image model into a generated base image.
 *   - LABEL: 320x90 white with the word "Glutathione" rendered onto it — the `expect: [...]`
 *     PASS case (an annotation's own text actually rendered).
 */
const BLANK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAASwAAABQAQAAAACLkXXWAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oJBwgRALYGuiQAAAAlSURBVEjH7coxAQAACAOg9U9rA1fBX7jJXkw0TdM0TdM0TfvXCq0s0BYIkJMCAAAAAElFTkSuQmCC";
const LEAKED_TEXT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAASwAAABQCAAAAACGgRenAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAD/h4/MvwAAAAd0SU1FB+oJBwgRALYGuiQAAALJSURBVHja7dtLSBVxHMXxM6KZ1yzIygjpQYqLrgslctFDJEgMLiKGq7Bo16ICowe1cFFIaLUMKui5Se5GRwoKIUFCi6CQQiJ7YJC9FaXbzaxfi7HSnWf1/wfns3H+M5vDl+EyGwODzFWG6wH/E8UiKBZBsQiKRVAsgmIRFIugWATFIigWQbEIikVQLIJiERSLoFgExSIoFkGxCIpFUCyCYhEUi6BYBMUiKBZBsQiKRVAsggexHgdBW3S1Y3n092tO0Dr90K5XLc6Nt6RcjwTgRSwALV9mHW+n0RldpWsb+0oqh49XjrmeCHgSq3Ls5Kxz59I1/R8BAE1d5YN9t0bqH+5zvREAYM49woWyeS/NzOoLzMxsasnu/bhkZjaA3DdmZqm1GHA908y8eLOCtsljM473PiUSCAHgPHYWAkDOAbS7Hgkg0/UAAMDWmvaD6/+ewuxt2QvvpOcDPaiNbjVuKHW9EZ78ZgGtGYf+HcKqBVnVqW4Az1AW3VpUEXM9Ed7Eiu/qufnnevB5AkggBCamkO962UyexMKJ2JGf05edSADbM7oMgT/7APgzZkXT08vTl2HR96Gh0fi7B8iN4bPrYTP5EguHlzVHn+kf7g8VFxcXDyBEsA4D0dPx5HvXA+FRrLzmt2cAAF2/riSTyeQ5hEA1OqKn7Q1XXQ8E/PgovWhm9qMkb3OBmSVKo9tFeGGvMmPDZmbpePDa9Uzz5KMUAJB5aqIXwLfumuhchxCrj6bqRoCJPU/2rnK9D/DozTLbhAKzDtyNTn2oMptsQE5NTT62jLteaebTmwWcBoAwb2N0qijsHUXWjWvl/T0rz3bnuR4HAIH+hW7ufHqzvKdYBMUiKBZBsQiKRVAsgmIRFIugWATFIigWQbEIikVQLIJiERSLoFgExSIoFkGxCIpFUCyCYhEUi6BYBMUiKBZBsQiKRVAsgmIRfgMAPMXoTwPm3gAAAABJRU5ErkJggg==";
const LABEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAABaCAAAAADswdA/AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAD/h4/MvwAAAAd0SU1FB+oJBwgRALYGuiQAAAQhSURBVHja7dxvTNR1HMDx9xHcFQcqLvCosNG1In0Qi2omVNZMRzzogbhZWxBiQOUSS2e0zLPatMHWlg9a3MzS3Kjl6kGrBym1abrERUZliqCjZRzTxj+jSO7TA+4HQpCtz/q2ts/r2e9zvx/3+77vd7ff3QN8gtFI+q9P4P/OAipZQCULqGQBlSygkgVUsoBKFlDJAipZQCULqGQBlSygkgVUsoBKFlDJAipZQCULqGQBlSygkgVUsoBKFlDJAipZQCULqGQBlSygkgVUsoBKFlDJAipZQCULqGQBlZwHHNpyczCjaCfAm76vJjwUu6+JKQY1l48NGnx73Sf6a64D9tz+bNqjy0+Xr5risYG9Zy8xyAinOj7fS0p2+3Sy4tu3yuDXlduXLv8Hh1dWuj3dv7Ukpz6gQkREBmdViOygVaQyKCLSwi6ZCfCAyMmqvNSZi5rFG1QHRjZlp5V0SeII6Vtzjf+G+riIVIaH1mWnl3aLiPQ/nePPrRtyux4Rx1fgTh4HIHjmij899k5XVU1JiJMFWY/l9r1W/OW8xACe37e5++VlhxP7Dd7V8WS4ef2JRoBHTq3tip46nMQvi36sCx9t+OIT1x9Kbl+vUNrI+MakK1Da2SYir+f2iEhfsM4bVPvuGRZ5ka8TR6zjIxGpZb9Ipf/u30W2cVBkvf+YiBxgt+Mr0O3rFY9lJ0F3JBKJRKbbp6ozEyRw3fHx17g2BYpoT2ztmF8MPMN2YHhjMtxJOyPRkjygcG4Tbrl9C1+QFKB7M8C0BX9qaO7sh9D45A4gg59HN06fWwIwJ+coQCEQZJDjve/7AAg6XZDrgP4ZPUC+QNHn0+3TUdS38rk5yRXxsUlKJnCZtzVAJgDpMSB19B4xTi+rnhh9CqcLcn4bc2tzRxjAu5y8G9H+8V02xA4sBIbHJxM/ZjITO5+bDfi8aRZJ+W6XMuXJ/etW0AhA7IQ3mX1+GGgBSEaAI/MWArGuscEkodARgB96brt4eu2s/QBs2ud2Qa4Dls9/5VMgvnbEmxRwCM5HAbL4Hgj1C7D1wthgEt9D33wM1EvVxdOU8mNvA7tf6HS7INdvYf97i5eWLRhoal22JzEpzqmqj2998CUgdcGOvBlLVj+8eg3RQ4W/eYPJf2PjntLauc3vbiicMI18WP7ZLd813u/8u4rj2ybpeSrsT198sBXve0XbvelXv9rPLhFpKwhc2SLRm/yhmt7S671BdUBEpI2od8SZssxA/hsi3k3k6O3i2ZqrAjduGXa9Hp/9zwQd+z1QyQIqWUAlC6hkAZUsoJIFVLKAShZQyQIqWUAlC6hkAZUsoJIFVLKAShZQyQIqWUAlC6hkAZUsoJIFVLKAShZQyQIqWUAlC6hkAZUsoJIFVLKAShZQyQIqWUAlC6hkAZX+AKB5ASQpoQUjAAAAAElFTkSuQmCC";

async function withServer<T>(fn: (server: FastifyInstance) => Promise<T>): Promise<T> {
  process.env.RENDER_SERVICE_SECRET = SECRET;
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function ocr(server: FastifyInstance, payload: Record<string, unknown>, secret: string = SECRET) {
  const response = await server.inject({
    method: "POST",
    url: "/ocr/image",
    headers: { "x-render-secret": secret },
    payload,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

/** A fake `tesseract` on PATH — proves the ROUTE handles a nonzero exit / stdout shape
 * correctly without depending on a real binary being installed. */
function stubTesseract(opts: { exitCode: number; stdout?: string; stderr?: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tesseract-stub-"));
  const binPath = path.join(dir, "tesseract");
  writeFileSync(
    binPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "tesseract 0.0.0-stub"; exit 0; fi
${opts.stdout ? `printf '%s' ${JSON.stringify(opts.stdout)}` : "true"}
${opts.stderr ? `printf '%s' ${JSON.stringify(opts.stderr)} 1>&2` : "true"}
exit ${opts.exitCode}
`
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

async function withStubbedTesseract<T>(opts: { exitCode: number; stdout?: string; stderr?: string }, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TESSERACT_BIN;
  process.env.TESSERACT_BIN = stubTesseract(opts);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TESSERACT_BIN;
    else process.env.TESSERACT_BIN = previous;
  }
}

// --- contract-level (no tesseract required) -----------------------------------------------

test("validateOcrRequest: refuses a body that carries no decodable image", async () => {
  for (const body of [undefined, {}, { imageBase64: 123 }, { imageBase64: "not base64!!" }, { imageBase64: Buffer.from("hello").toString("base64") }]) {
    const result = validateOcrRequest(body);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(body)}`);
    assert.equal(result.ok === false && result.code, "OCR_IMAGE_INVALID");
  }
});

test("validateOcrRequest: accepts PNG, JPEG, GIF and WebP magic bytes", async () => {
  const cases: Array<[string, Buffer]> = [
    ["PNG", Buffer.from(BLANK_PNG_BASE64, "base64")],
    ["JPEG", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])],
    ["GIF", Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)])],
    ["WebP", Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(8)])],
  ];
  for (const [label, bytes] of cases) {
    const result = validateOcrRequest({ imageBase64: bytes.toString("base64") });
    assert.equal(result.ok, true, `${label} must be accepted`);
  }
});

test("validateOcrRequest: decoded bytes over the cap are refused with OCR_IMAGE_TOO_LARGE", async () => {
  const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_OCR_IMAGE_BYTES)]);
  const result = validateOcrRequest({ imageBase64: oversized.toString("base64") });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "OCR_IMAGE_TOO_LARGE");
});

test("validateOcrRequest: an unsupported language is refused with OCR_LANGUAGE_UNAVAILABLE, naming what IS supported", async () => {
  const result = validateOcrRequest({ imageBase64: BLANK_PNG_BASE64, languages: ["fra"] });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "OCR_LANGUAGE_UNAVAILABLE");
  assert.match(result.ok === false ? result.message : "", new RegExp(SUPPORTED_OCR_LANGUAGES.join(", ")));
});

test("validateOcrRequest: timeoutMs is clamped into range, not refused", async () => {
  const tooLow = validateOcrRequest({ imageBase64: BLANK_PNG_BASE64, timeoutMs: 1 });
  assert.equal(tooLow.ok === true && tooLow.request.timeoutMs, 1000);
  const tooHigh = validateOcrRequest({ imageBase64: BLANK_PNG_BASE64, timeoutMs: 999_999 });
  assert.equal(tooHigh.ok === true && tooHigh.request.timeoutMs, 60000);
});

test("POST /ocr/image: rejects a missing/invalid shared secret and surfaces named refusals over the wire", async () => {
  await withServer(async (server) => {
    const unauthorized = await ocr(server, { imageBase64: BLANK_PNG_BASE64 }, "wrong-secret");
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, "RENDER_SERVICE_AUTH");

    const badBody = await ocr(server, { imageBase64: "not base64!!" });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.body.code, "OCR_IMAGE_INVALID");
  });
});

// --- tesseract's own exit code / stdout shape (stubbed — no real binary needed) -----------

test("POST /ocr/image: a nonzero tesseract exit is OCR_ENGINE_ERROR carrying its stderr, not a bare 500", async () => {
  await withStubbedTesseract({ exitCode: 1, stderr: "Error: something went wrong" }, async () => {
    await withServer(async (server) => {
      const { status, body } = await ocr(server, { imageBase64: BLANK_PNG_BASE64 });
      assert.equal(status, 500, JSON.stringify(body));
      assert.equal(body.code, "OCR_ENGINE_ERROR");
      assert.match(String(body.message), /something went wrong/);
    });
  });
});

test("POST /ocr/image: a TSV with only the page-level row (no words) is a SUCCESSFUL empty result, not an error", async () => {
  const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t300\t80\t-1\t\n";
  await withStubbedTesseract({ exitCode: 0, stdout: tsv }, async () => {
    await withServer(async (server) => {
      const { status, body } = await ocr(server, { imageBase64: BLANK_PNG_BASE64 });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.text, "");
      assert.deepEqual(body.words, []);
    });
  });
});

// --- integration (needs a real tesseract binary) -------------------------------------------

test("POST /ocr/image: a blank image reports no words at all", async (t) => {
  if (!TESSERACT_AVAILABLE) return t.skip("tesseract not installed");
  await withServer(async (server) => {
    const { status, body } = await ocr(server, { imageBase64: BLANK_PNG_BASE64 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.text, "");
    assert.deepEqual(body.words, []);
    const diagnostics = body.diagnostics as { wordCount: number; engine: { id: string } };
    assert.equal(diagnostics.wordCount, 0);
    assert.equal(diagnostics.engine.id, "tesseract");
  });
});

test("POST /ocr/image: text leaked into a generated image (the NAC/cysteine/glutathione failure) IS detected", async (t) => {
  if (!TESSERACT_AVAILABLE) return t.skip("tesseract not installed");
  await withServer(async (server) => {
    const { status, body } = await ocr(server, { imageBase64: LEAKED_TEXT_PNG_BASE64 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(String(body.text), /NAC/i);
    const words = body.words as Array<{ text: string; conf: number }>;
    assert.ok(words.some((w) => /NAC/i.test(w.text)));
    assert.ok(words.every((w) => w.conf >= 0 && w.conf <= 100), "confidence is reported as a 0-100 number");
  });
});

test("POST /ocr/image: an annotation's own rendered label text IS recognized", async (t) => {
  if (!TESSERACT_AVAILABLE) return t.skip("tesseract not installed");
  await withServer(async (server) => {
    const { status, body } = await ocr(server, { imageBase64: LABEL_PNG_BASE64 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(String(body.text), /Glutathione/i);
  });
});

test("POST /ocr/image: an unsupported language is refused before tesseract is even spawned", async (t) => {
  if (!TESSERACT_AVAILABLE) return t.skip("tesseract not installed");
  await withServer(async (server) => {
    const { status, body } = await ocr(server, { imageBase64: LABEL_PNG_BASE64, languages: ["deu"] });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, "OCR_LANGUAGE_UNAVAILABLE");
  });
});
