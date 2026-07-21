import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance;
let originalSecret: string | undefined;

before(async () => {
  originalSecret = process.env.RENDER_SERVICE_SECRET;
  server = buildServer();
  await server.ready();
});

after(async () => {
  if (originalSecret === undefined) {
    delete process.env.RENDER_SERVICE_SECRET;
  } else {
    process.env.RENDER_SERVICE_SECRET = originalSecret;
  }
  await server.close();
});

test("no RENDER_SERVICE_SECRET set -> 401 even with a header present", async () => {
  delete process.env.RENDER_SERVICE_SECRET;
  const response = await server.inject({
    method: "POST",
    url: "/render/typst",
    headers: { "x-render-secret": "anything" },
    payload: {},
  });
  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "RENDER_SERVICE_AUTH");
});

test("no RENDER_SERVICE_SECRET set -> 401 with no header at all", async () => {
  delete process.env.RENDER_SERVICE_SECRET;
  const response = await server.inject({ method: "POST", url: "/render/typst", payload: {} });
  assert.equal(response.statusCode, 401);
});

test("RENDER_SERVICE_SECRET set, missing header -> 401", async () => {
  process.env.RENDER_SERVICE_SECRET = "s3cr3t-value";
  const response = await server.inject({ method: "POST", url: "/render/typst", payload: {} });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "RENDER_SERVICE_AUTH");
});

test("RENDER_SERVICE_SECRET set, wrong header -> 401", async () => {
  process.env.RENDER_SERVICE_SECRET = "s3cr3t-value";
  const response = await server.inject({
    method: "POST",
    url: "/render/typst",
    headers: { "x-render-secret": "totally-wrong" },
    payload: {},
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "RENDER_SERVICE_AUTH");
});

test("RENDER_SERVICE_SECRET set, right header -> proceeds past auth (contract 400 on empty body)", async () => {
  process.env.RENDER_SERVICE_SECRET = "s3cr3t-value";
  const response = await server.inject({
    method: "POST",
    url: "/render/typst",
    headers: { "x-render-secret": "s3cr3t-value" },
    payload: {},
  });
  // Auth passed (not 401); contract validation rejects the empty body (no template.source).
  assert.notEqual(response.statusCode, 401);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "TEMPLATE_INVALID");
});

test("chromium route also requires auth -> 401 without secret configured", async () => {
  delete process.env.RENDER_SERVICE_SECRET;
  const response = await server.inject({ method: "POST", url: "/render/chromium", payload: {} });
  assert.equal(response.statusCode, 401);
});

test("chromium route with valid auth -> 501 RENDERER_NOT_AVAILABLE", async () => {
  process.env.RENDER_SERVICE_SECRET = "s3cr3t-value";
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": "s3cr3t-value" },
    payload: {},
  });
  assert.equal(response.statusCode, 501);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "RENDERER_NOT_AVAILABLE");
});
