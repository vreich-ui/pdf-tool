/**
 * Fastify server wiring the wire contract documented in README.md. Exported as
 * `buildServer()` so tests can drive it via `fastify.inject()` without binding a port.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { checkAuth } from "./auth.js";
import { validateRenderRequest } from "./contract.js";
import { renderTypst, typstVersion } from "./engines/typst.js";

const BODY_LIMIT_BYTES = 32 * 1024 * 1024; // 32 MB

export function buildServer(): FastifyInstance {
  const fastify = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: process.env.NODE_ENV === "production",
  });

  // NOTE: the PRIMARY health path is /health. Google's frontend intercepts the exact path
  // /healthz on *.run.app (legacy GFE health checking) and answers 404 before the container
  // is reached; /healthz is kept only as an alias for local dev and tests.
  const healthHandler = async () => {
    const version = await typstVersion();
    return {
      ok: true,
      service: "pdf-tool-render",
      engines: {
        typst: { available: version !== null, ...(version ? { version } : {}) },
        chromium: { available: false },
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

    const validated = validateRenderRequest(request.body);
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
    reply.code(501);
    return { ok: false, code: "RENDERER_NOT_AVAILABLE", message: "chromium engine lands in PR4" };
  });

  return fastify;
}
