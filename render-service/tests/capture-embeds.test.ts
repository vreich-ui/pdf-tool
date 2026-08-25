// T15.20 — iframes/embeds captured into snapshot.v1's `embeds[]`.
//
// Same rationale as capture-structure.test.ts: EXTRACT_PAGE_MODEL_SCRIPT only ever runs
// inside page.evaluate(), so the only honest test is against a REAL DOM — closest(),
// getBoundingClientRect() and CSS.escape() are exactly where a hand-built fake element
// would lie.
//
// This tests the in-browser half of the contract (provider classification, capturable /
// not-capturable, containingBlockOrdinal, selector). The id assignment and per-viewport
// boundingBoxes are computed OUTSIDE the browser (capture.ts, after evaluate returns) and
// are covered by capture-integration.test.ts's full end-to-end capture instead.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { EXTRACT_PAGE_MODEL_SCRIPT } from "../src/capture.js";

const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

type Embed = {
  ordinal: number;
  tag: string;
  provider: string;
  src: string | null;
  rawSrc: string | null;
  providerHost: string | null;
  title: string | null;
  accessibleName: string | null;
  selector: string;
  containingBlockOrdinal: number | null;
  attributes: {
    width: string | null;
    height: string | null;
    allow: string | null;
    allowFullscreen: boolean;
    loading: string | null;
    sandbox: string | null;
    referrerPolicy: string | null;
  };
  capturable: boolean;
  notCapturableReason: string | null;
};

const PAGE = `<!doctype html><html><body><main>
  <section id="video-block" style="min-height:80px">
    <h2>Watch</h2>
    <iframe title="Intro video" src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"
      allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>
  </section>
  <section id="map-block" style="min-height:80px">
    <iframe aria-label="Store location" src="https://www.google.com/maps/embed?pb=x" width="600" height="450"></iframe>
  </section>
  <section id="booking-block" style="min-height:80px">
    <iframe src="https://calendly.com/acme/intro" width="100%" height="700" sandbox="allow-scripts allow-forms"></iframe>
  </section>
  <section id="social-block" style="min-height:80px">
    <iframe src="https://www.facebook.com/plugins/post.php?href=x" width="500" height="400"></iframe>
  </section>
  <section id="unknown-block" style="min-height:80px">
    <iframe src="https://widgets.example.com/reviews" width="300" height="200"></iframe>
  </section>
  <section id="empty-src-block" style="min-height:80px">
    <iframe title="No source yet"></iframe>
  </section>
  <section id="data-uri-block" style="min-height:80px">
    <iframe src="data:text/html,hello"></iframe>
  </section>
  <object id="legacy-object" data="https://widgets.example.com/legacy" width="200" height="150"></object>
</main></body></html>`;

const extract = async (): Promise<{ embeds: Embed[]; blocks: Array<{ selector: string }> }> => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    // Never let the test actually reach any of the fixture's iframe/object src hosts —
    // this proves DOM-attribute extraction works without the embedded content loading,
    // exactly as the capture policy requires in production.
    await page.route("**/*", (route) => route.abort());
    await page.setContent(PAGE, { waitUntil: "domcontentloaded" });
    return (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as { embeds: Embed[]; blocks: Array<{ selector: string }> };
  } finally {
    await browser.close();
  }
};

const byOrdinal = (embeds: Embed[], ordinal: number) => embeds.find((embed) => embed.ordinal === ordinal);

test("embeds are captured in DOM order with provider classification by hostname", async () => {
  const { embeds } = await extract();
  // 8 embeddable elements on the fixture page (7 iframes + 1 object).
  assert.equal(embeds.length, 8);

  const video = byOrdinal(embeds, 0)!;
  assert.equal(video.tag, "iframe");
  assert.equal(video.provider, "video");
  assert.equal(video.src, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(video.providerHost, "www.youtube.com");
  assert.equal(video.title, "Intro video");
  assert.equal(video.capturable, true);
  assert.equal(video.notCapturableReason, null);
  assert.deepEqual(video.attributes, {
    width: "560",
    height: "315",
    allow: "autoplay; fullscreen",
    allowFullscreen: true,
    loading: "lazy",
    sandbox: null,
    referrerPolicy: null,
  });

  const map = byOrdinal(embeds, 1)!;
  assert.equal(map.provider, "maps");
  assert.equal(map.accessibleName, "Store location");

  const booking = byOrdinal(embeds, 2)!;
  assert.equal(booking.provider, "booking");
  assert.equal(booking.attributes.sandbox, "allow-scripts allow-forms");

  const social = byOrdinal(embeds, 3)!;
  assert.equal(social.provider, "social");

  const unknown = byOrdinal(embeds, 4)!;
  assert.equal(unknown.provider, "unknown");
  assert.equal(unknown.capturable, true);

  const legacyObject = byOrdinal(embeds, 7)!;
  assert.equal(legacyObject.tag, "object");
  assert.equal(legacyObject.provider, "unknown");
  assert.equal(legacyObject.src, "https://widgets.example.com/legacy");
});

test("an embed that cannot be captured is represented explicitly, never dropped", async () => {
  const { embeds } = await extract();

  const missingSrc = byOrdinal(embeds, 5)!;
  assert.equal(missingSrc.capturable, false);
  assert.equal(missingSrc.notCapturableReason, "missing-src");
  assert.equal(missingSrc.src, null);
  assert.equal(missingSrc.providerHost, null);
  assert.equal(missingSrc.rawSrc, null);
  assert.equal(missingSrc.title, "No source yet", "identity is still recorded even when not capturable");
  assert.equal(typeof missingSrc.selector, "string", "geometry/selector still resolvable for a not-capturable embed");

  const dataUri = byOrdinal(embeds, 6)!;
  assert.equal(dataUri.capturable, false);
  assert.equal(dataUri.notCapturableReason, "unsupported-scheme");
  assert.equal(dataUri.src, null);
  assert.equal(dataUri.rawSrc, "data:text/html,hello");
});

test("each embed resolves to its nearest containing block, not the page root", async () => {
  const { embeds, blocks } = await extract();
  const video = byOrdinal(embeds, 0)!;
  assert.notEqual(video.containingBlockOrdinal, null);
  assert.ok(blocks[video.containingBlockOrdinal as number]?.selector.includes("video-block"));

  const legacyObject = byOrdinal(embeds, 7)!;
  // <object id="legacy-object"> sits directly under <main>, outside every section — it has
  // no containing block candidate.
  assert.equal(legacyObject.containingBlockOrdinal, null);
});

test("embed extraction is bounded (EMBED_MAX) so one page cannot inflate the snapshot", async () => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    const many = Array.from({ length: 60 }, (_, i) => `<iframe src="https://widgets.example.com/w${i}"></iframe>`).join("");
    await page.setContent(`<!doctype html><html><body><main>${many}</main></body></html>`, { waitUntil: "domcontentloaded" });
    const model = (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as { embeds: Embed[] };
    assert.equal(model.embeds.length, 40, "capped at EMBED_MAX even though 60 iframes are on the page");
  } finally {
    await browser.close();
  }
});
