// T12.23 — the crawl half, proven against a REAL DOM.
//
// `EXTRACT_PAGE_MODEL_SCRIPT` only ever runs inside page.evaluate(), so the only honest test of it
// is one that evaluates it in a browser. Asserting against a hand-built fake element would prove
// the assertions, not the extraction: `closest()`, `:scope > li` and `querySelectorAll` are exactly
// where a plausible-looking implementation goes wrong, and none of them exist on a stub.
//
// What is under test is the promise the mapper depends on: the shapes a page states in its markup
// — a <dl>, a <blockquote>, an <ol>, a <ul>, a <table> — survive the crawl instead of being melted
// into textContent, which is what capped every clone at 10 of the platform's 24 section types.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { EXTRACT_PAGE_MODEL_SCRIPT } from "../src/capture.js";

const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const PAGE = `<!doctype html><html><body><main>
  <section id="faq" style="min-height:80px">
    <h2>Questions</h2>
    <dl>
      <dt>Do you fund students?</dt><dd>Yes, every spring.</dd>
      <dt>Where are you based?</dt><dd>Berlin.</dd>
    </dl>
  </section>
  <section id="quote" style="min-height:80px">
    <blockquote>They changed how we work.<cite>Dana Reyes, Director</cite></blockquote>
  </section>
  <section id="steps" style="min-height:80px">
    <ol><li>Apply: send the form.</li><li>Interview: we call you.</li></ol>
  </section>
  <section id="bullets" style="min-height:80px">
    <ul><li>Open access</li><li>Peer reviewed</li></ul>
  </section>
  <section id="table" style="min-height:80px">
    <table>
      <tr><th>Plan</th><th>Basic</th><th>Pro</th></tr>
      <tr><td>Archive access</td><td>&#10003;</td><td>&#10003;</td></tr>
    </table>
  </section>
  <section id="plain" style="min-height:80px"><p>Just a paragraph of ordinary prose here.</p></section>
</main></body></html>`;

type Block = { selector: string; structure?: Record<string, any> };

const extract = async (): Promise<Block[]> => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE, { waitUntil: "domcontentloaded" });
    const model = (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as { blocks: Block[] };
    return model.blocks;
  } finally {
    await browser.close();
  }
};

const bySelector = (blocks: Block[], id: string) =>
  blocks.find((block) => block.selector.includes(id));

test("the crawl keeps the DOM shapes the mapper needs", async () => {
  const blocks = await extract();
  assert.ok(blocks.length >= 6, `expected the six sections to be captured, got ${blocks.length}`);

  const faq = bySelector(blocks, "faq");
  assert.deepEqual(faq?.structure?.qa, [
    { q: "Do you fund students?", a: "Yes, every spring." },
    { q: "Where are you based?", a: "Berlin." }
  ]);

  // The attribution must not remain inside the quote — otherwise the person is quoted as having
  // said their own job title.
  const quote = bySelector(blocks, "quote");
  assert.deepEqual(quote?.structure?.quotes, [
    { quote: "They changed how we work.", attribution: "Dana Reyes, Director" }
  ]);

  const steps = bySelector(blocks, "steps");
  assert.equal(steps?.structure?.lists?.[0]?.ordered, true);
  assert.deepEqual(steps?.structure?.lists?.[0]?.items, ["Apply: send the form.", "Interview: we call you."]);

  // ordered:false is the signal that keeps a plain bullet list from being re-typed as a sequence.
  const bullets = bySelector(blocks, "bullets");
  assert.equal(bullets?.structure?.lists?.[0]?.ordered, false);
  assert.deepEqual(bullets?.structure?.lists?.[0]?.items, ["Open access", "Peer reviewed"]);

  const table = bySelector(blocks, "table");
  assert.deepEqual(table?.structure?.tables?.[0]?.headers, ["Plan", "Basic", "Pro"]);
  assert.deepEqual(table?.structure?.tables?.[0]?.rows, [["Archive access", "✓", "✓"]]);
});

test("a block with no recoverable shape carries no structure key at all", async () => {
  // Additive means additive: a plain prose section must serialize exactly as it did before T12.23,
  // or every existing snapshot diff becomes noise.
  const blocks = await extract();
  const plain = bySelector(blocks, "plain");
  assert.ok(plain, "the prose section was captured");
  assert.equal("structure" in (plain as object), false);
});

test("a nesting ancestor does not claim its descendant's structure twice", async () => {
  // <main> and its <section> children are both block candidates. Without the ownership check every
  // list would be reported by the section AND by main, and the mapper would see two candidates
  // competing for one piece of content.
  const blocks = await extract();
  const owners = blocks.filter((block) => (block.structure?.lists ?? []).some((list: any) => list.items.includes("Open access")));
  assert.equal(owners.length, 1, "exactly one block owns the bullet list");
});
