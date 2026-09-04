/**
 * Fastify server wiring the wire contract documented in README.md. Exported as
 * `buildServer()` so tests can drive it via `fastify.inject()` without binding a port.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { checkAuth } from "./auth.js";
import { validateRenderRequest } from "./contract.js";
import { capturePage, validateCaptureRequest } from "./capture.js";
import { chromiumAvailable, renderChromium } from "./engines/chromium.js";
import { renderTypst, typstVersion } from "./engines/typst.js";
import { popplerVersion, rasterizePdf, validateRasterizeRequest } from "./rasterize.js";

const BODY_LIMIT_BYTES = 32 * 1024 * 1024; // 32 MB

export function buildServer(): FastifyInstance {
  const fastify = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: process.env.NODE_ENV === "production",
  });

  // NOTE: the PRIMARY health path is /health. Google's frontend intercepts the exact path
  // /healthz on *.run.app (legacy GFE health checking) and answers 404 before the container
  // is reached; /healthz is kept only as an alias for local dev and tests.
  // "Which commit is actually live?" was unanswerable from outside this service, and on
  // 2026-08-19 that cost a diagnosis cycle: a redeploy was performed, a fresh crawl still
  // produced the pre-fix output, and there was no way to tell a stale IMAGE from a live bug
  // without GCP console access. deploy/cloud-run.sh stamps the built commit in here and then
  // asserts /health reports it back, so a deploy that did not actually take now FAILS LOUDLY
  // instead of reporting success. A git sha is not a credential; nothing else is exposed.
  const buildInfo = {
    gitSha: process.env.SERVICE_GIT_SHA || null,
    deployedAt: process.env.SERVICE_DEPLOYED_AT || null,
  };

  const healthHandler = async () => {
    const [typstVer, chromiumInfo, popplerVer] = await Promise.all([typstVersion(), chromiumAvailable(), popplerVersion()]);
    return {
      ok: true,
      service: "pdf-tool-render",
      build: buildInfo,
      engines: {
        typst: { available: typstVer !== null, ...(typstVer ? { version: typstVer } : {}) },
        chromium: { available: chromiumInfo.available, ...(chromiumInfo.version ? { version: chromiumInfo.version } : {}) },
        // B2/R2: poppler is not a template ENGINE — it is the rasterizer behind
        // /rasterize/pdf (and therefore behind non-chromium template thumbnails). It is
        // reported here because "why did every thumbnail stop appearing" must be
        // answerable from outside the container, exactly like the two engines above.
        poppler: { available: popplerVer !== null, ...(popplerVer ? { version: popplerVer } : {}) },
      },
    };
  };
  fastify.get("/health", healthHandler);
  fastify.get("/healthz", healthHandler);

  fastify.post("/render/typst", async (request, reply) => {
    if (!checkAuth(request.headers["x-render-secret"] as string | undefined)) {
      reply.code(401);
      return { ok: false, code: "RENDER_SERVICE_AUTH", message: "Missing or invalid x-render-secret header" };
    }

    const validated = validateRenderRequest(request.body, "typst");
    if (!validated.ok) {
      reply.code(validated.status);
      return { ok: false, code: validated.code, message: validated.message };
    }

    let result;
    try {
      result = await renderTypst(validated.request);
    } catch (error) {
      reply.code(500);
      return {
        ok: false,
        code: "RENDER_ENGINE_ERROR",
        message: `Unexpected typst engine failure: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!result.ok) {
      const status = result.code === "RENDER_TIMEOUT" ? 504 : result.code === "PDF_REQ_MAX_BYTES" ? 507 : 500;
      reply.code(status);
      return { ok: false, code: result.code, message: result.message };
    }

    reply.code(200);
    return {
      ok: true,
      pdfBase64: result.pdfBytes.toString("base64"),
      diagnostics: {
        ...result.diagnostics,
        engine: { id: "typst", executedIn: "render-service" },
      },
    };
  });

  fastify.post("/render/chromium", async (request, reply) => {
    if (!checkAuth(request.headers["x-render-secret"] as string | undefined)) {
      reply.code(401);
      return { ok: false, code: "RENDER_SERVICE_AUTH", message: "Missing or invalid x-render-secret header" };
    }

    const validated = validateRenderRequest(request.body, "chromium");
    if (!validated.ok) {
      reply.code(validated.status);
      return { ok: false, code: validated.code, message: validated.message };
    }

    let result;
    try {
      result = await renderChromium(validated.request);
    } catch (error) {
      reply.code(500);
      return {
        ok: false,
        code: "RENDER_ENGINE_ERROR",
        message: `Unexpected chromium engine failure: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!result.ok) {
      const status =
        result.code === "RENDER_TIMEOUT" ? 504 : result.code === "PDF_REQ_MAX_BYTES" ? 507 : result.code === "DATA_BINDING_ERROR" ? 400 : 500;
      reply.code(status);
      return { ok: false, code: result.code, message: result.message };
    }

    reply.code(200);
    return {
      ok: true,
      pdfBase64: result.pdfBytes.toString("base64"),
      // D3: only present when the request set options.wantThumbnail AND the capture
      // succeeded — a failed capture is a diagnostics.engineWarnings entry, never an error.
      ...(result.thumbnailPng ? { thumbnailPngBase64: result.thumbnailPng.toString("base64") } : {}),
      diagnostics: {
        ...result.diagnostics,
        engine: { id: "chromium", executedIn: "render-service" },
      },
    };
  });

  // B2 / RULING R2: rasterize a FINISHED PDF into one PNG per page with poppler's pdftoppm.
  // Unlike /render/*, this route renders no template and binds no data — it takes bytes that
  // already exist and photographs them, which is what makes it usable for BOTH a stored PDF
  // (the rasterize_pdf_artifact tool) and for the non-chromium renderers' thumbnails.
  // See src/rasterize.ts for the exact invocation and every refusal code.
  fastify.post("/rasterize/pdf", async (request, reply) => {
    if (!checkAuth(request.headers["x-render-secret"] as string | undefined)) {
      reply.code(401);
      return { ok: false, code: "RENDER_SERVICE_AUTH", message: "Missing or invalid x-render-secret header" };
    }

    const validated = validateRasterizeRequest(request.body);
    if (!validated.ok) {
      reply.code(validated.status);
      return { ok: false, code: validated.code, message: validated.message };
    }

    let result;
    try {
      result = await rasterizePdf(validated.request);
    } catch (error) {
      reply.code(500);
      return {
        ok: false,
        code: "RASTERIZE_ENGINE_ERROR",
        message: `Unexpected rasterize failure: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!result.ok) {
      // Every input-shaped refusal is a 400 (the caller can fix it), a missing binary is a
      // 503 (the deploy can fix it), a timeout is a 504. Nothing here is a bare 500.
      // RASTERIZE_PAGE_TOO_LARGE is deliberately in the 400 bucket: the page box and the dpi
      // both came from the caller, and lowering dpi is a fix available to it.
      const status =
        result.code === "RASTERIZE_TIMEOUT"
          ? 504
          : result.code === "RASTERIZE_UNAVAILABLE"
            ? 503
            : result.code === "RASTERIZE_ENGINE_ERROR"
              ? 500
              : 400;
      reply.code(status);
      return { ok: false, code: result.code, message: result.message };
    }

    reply.code(200);
    return {
      ok: true,
      pages: result.pages,
      diagnostics: { ...result.diagnostics, engine: { id: "poppler-pdftoppm", executedIn: "render-service" } },
    };
  });

  // T12.8 capture plane: navigate ONE page with JavaScript enabled inside a fresh,
  // allowlist-routed context and return the snapshot.v1 page payload + screenshots. The
  // print routes above keep their lockdown untouched — capture is opt-in per request.
  fastify.post("/capture/page", async (request, reply) => {
    if (!checkAuth(request.headers["x-render-secret"] as string | undefined)) {
      reply.code(401);
      return { ok: false, code: "RENDER_SERVICE_AUTH", message: "Missing or invalid x-render-secret header" };
    }

    const validated = validateCaptureRequest(request.body);
    if (!validated.ok) {
      reply.code(validated.status);
      return { ok: false, code: validated.code, message: validated.message };
    }

    let result;
    try {
      result = await capturePage(validated.request);
    } catch (error) {
      reply.code(500);
      return {
        ok: false,
        code: "CAPTURE_ENGINE_ERROR",
        message: `Unexpected capture engine failure: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!result.ok) {
      const status = result.code === "CAPTURE_TIMEOUT" ? 504 : result.code === "CAPTURE_NAVIGATION_FAILED" ? 502 : 500;
      reply.code(status);
      return { ok: false, code: result.code, message: result.message };
    }

    reply.code(200);
    return {
      ok: true,
      page: result.page,
      screenshots: result.screenshots,
      diagnostics: { ...result.diagnostics, engine: { id: "chromium-capture", executedIn: "render-service" } },
    };
  });

  return fastify;
}
