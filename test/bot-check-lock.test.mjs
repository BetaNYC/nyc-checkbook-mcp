/**
 * #51, decided 2026-11-18, to be confirmed by the owner (BOT_CHECK_LOCKS in src/checkbook.ts):
 * a 2xx or 3xx reply that the server already recognizes as the bot-challenge page is the same
 * block as a 403 or 429, so it locks the process the same way. Nothing wider: an ordinary 200
 * and a plain 302 do not lock.
 *
 * Also: smart_search never sends the model to the other tools after a redirect or the bot-check
 * page (they call the same site); it says to stop calling Checkbook NYC and to report it.
 *
 * All offline: every fetch is a stub; the pacer is the real one, on a virtual clock.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { callCheckbookApi, smartSearch, upstreamLocked, isBotCheckPage } from "../dist/checkbook.js";
import { freshUpstream, withFetch } from "./helpers/upstream.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const OK_XML =
  "<response><status><result>success</result></status>" +
  "<result_records><record_count>0</record_count></result_records></response>";
const INCIDENT = "160000700030852915-73978535351423378";
const CHALLENGE = `<html><body><iframe src="/_Incapsula_Resource?x=1">Request unsuccessful. Incapsula incident ID: ${INCIDENT}</iframe></body></html>`;
const LOADING_PAGE = fixture("smart-search-loading-302.html"); // a real 302 "Loading" page, no Incapsula marker
const RETRY_INVITE = /try again|retry|ask again (?!now)/i;
const OTHER_TOOLS = /Use the structured tools|search_spending|search_contracts/;
const LOCKED_BOT_CHECK =
  /Checkbook NYC answered requests from this network with its bot-check page at \S+ \(HTTP (200|302)\)\. This server has stopped sending requests to Checkbook NYC, and sent nothing for this call/;

beforeEach(() => freshUpstream());

async function connect() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "bot-check-lock-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (res) => res.content.map((c) => c.text).join("\n");

async function withSmartSearch(fn) {
  const saved = process.env.CHECKBOOK_ENABLE_SMART_SEARCH;
  process.env.CHECKBOOK_ENABLE_SMART_SEARCH = "1";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CHECKBOOK_ENABLE_SMART_SEARCH;
    else process.env.CHECKBOOK_ENABLE_SMART_SEARCH = saved;
  }
}

/** After a lock: one more call on each path sends nothing and gets the bot-check locked error. */
async function assertNothingSentAfter(client) {
  await withSmartSearch(() =>
    withFetch(
      async () => assert.fail("a locked server sent a request"),
      async () => {
        for (const [name, args] of [
          ["search_spending", { fiscal_year: "2026", page_size: 1 }],
          ["get_contract", { contract_id: "CT1" }],
          ["smart_search", { query: "laptops" }],
        ]) {
          const res = await client.callTool({ name, arguments: args });
          assert.equal(res.isError, true, name);
          assert.match(textOf(res), LOCKED_BOT_CHECK, name);
          assert.match(textOf(res), new RegExp(`incident ID ${INCIDENT}`), name);
          assert.doesNotMatch(textOf(res), RETRY_INVITE, name);
        }
      }
    )
  );
}

test("#51 the bot-check page on /api (HTTP 200) locks the server; the next call sends nothing", async () => {
  const { client, close } = await connect();
  try {
    let calls = 0;
    const res = await withFetch(
      async () => {
        calls++;
        return new Response(CHALLENGE, { status: 200, headers: { "content-type": "text/html" } });
      },
      () => client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", page_size: 1 } })
    );
    assert.equal(calls, 1);
    assert.ok(upstreamLocked(), "locked");
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.match(text, /Checkbook NYC answered with its bot-check page instead of data \(HTTP 200\)\. That is a block, the same as a refusal\. This is not "no records"/);
    assert.match(text, /This server has stopped sending requests to Checkbook NYC until it is restarted/);
    assert.match(text, new RegExp(`incident ID ${INCIDENT}`));
    assert.doesNotMatch(text, RETRY_INVITE);
    await assertNothingSentAfter(client);
  } finally {
    await close();
  }
});

test("#51 the bot-check page on /api: a call already waiting in the queue is not sent, even while the page is slow to arrive", async () => {
  let calls = 0;
  let sendBody;
  const bodyArrives = new Promise((r) => (sendBody = r));
  await withFetch(
    async () => {
      calls++;
      if (calls > 1) return new Response(OK_XML, { status: 200 }); // a call that should never have been sent
      // Headers now, the page later: the lock must hold the queue until the page is read.
      const body = new ReadableStream({
        async start(c) {
          await bodyArrives;
          c.enqueue(new TextEncoder().encode(CHALLENGE));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    },
    async () => {
      const first = callCheckbookApi({ type_of_data: "Budget" });
      const queued = callCheckbookApi({ type_of_data: "Spending" });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      sendBody();
      await assert.rejects(first, { kind: "refused" });
      await assert.rejects(queued, (err) => err.kind === "locked" && err.message.includes(INCIDENT));
    }
  );
  assert.equal(calls, 1, "the queued call was not sent");
});

test("#51 HTML where XML was expected on /api (the bot check without a marker, #39) locks too", async () => {
  await withFetch(
    async () => new Response(LOADING_PAGE, { status: 200, headers: { "content-type": "text/html" } }),
    () => assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }), { kind: "refused" })
  );
  assert.ok(upstreamLocked());
});

test("#51 the bot-check page in a 302 on /api locks; a plain 302 does not", async () => {
  await withFetch(
    async () => new Response(LOADING_PAGE, { status: 302, headers: { location: "/x", "content-type": "text/html" } }),
    () => assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }), { kind: "redirect" })
  );
  assert.equal(upstreamLocked(), false, "a plain 302 is an error, not a lock");

  await withFetch(
    async () => new Response(CHALLENGE, { status: 302, headers: { location: "/x", "content-type": "text/html" } }),
    () => assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }), { kind: "refused" })
  );
  assert.ok(upstreamLocked(), "a 302 that is the bot-check page locks");
});

test("#51 the bot-check page on smart search (HTTP 200) locks the server, and sends the model nowhere else", async () => {
  const { client, close } = await connect();
  try {
    const res = await withSmartSearch(() =>
      withFetch(
        async () => new Response(CHALLENGE, { status: 200, headers: { "content-type": "text/html" } }),
        () => client.callTool({ name: "smart_search", arguments: { query: "laptops" } })
      )
    );
    assert.ok(upstreamLocked(), "locked");
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.match(text, /bot-check page instead of data \(HTTP 200\)\. That is a block/);
    assert.match(text, /Stop using these tools, and report it/);
    assert.doesNotMatch(text, OTHER_TOOLS, "no 'use the other tools': they call the same site");
    assert.doesNotMatch(text, RETRY_INVITE);
    await assertNothingSentAfter(client);
  } finally {
    await close();
  }
});

test("#51 the bot-check page in a 302 on smart search locks", async () => {
  await withFetch(
    async () => new Response(CHALLENGE, { status: 302, headers: { location: "/x" } }),
    async () => {
      const out = await smartSearch("laptops");
      assert.equal(out.available, false);
      assert.equal(out.fallback, undefined);
    }
  );
  assert.ok(upstreamLocked());
});

test("smart search: a plain 302 does not lock, but says stop calling Checkbook NYC and report it, with no other tools", async () => {
  const { client, close } = await connect();
  try {
    const res = await withSmartSearch(() =>
      withFetch(
        async () => new Response(LOADING_PAGE, { status: 302, headers: { location: "/x", "content-type": "text/html" } }),
        () => client.callTool({ name: "smart_search", arguments: { query: "laptops" } })
      )
    );
    assert.equal(upstreamLocked(), false, "a plain 302 is not a lock");
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.match(text, /answered with a redirect \(HTTP 302\), which this server never follows/);
    assert.match(text, /Stop calling Checkbook NYC for now, and report it to whoever runs this server or at https:\/\/github\.com\/BetaNYC\/nyc-checkbook-mcp\/issues/);
    assert.doesNotMatch(text, OTHER_TOOLS, "no 'use the other tools': they call the same site");
  } finally {
    await close();
  }
});

test("#51 an ordinary 200 does not lock, on either path", async () => {
  await withFetch(async () => new Response(OK_XML, { status: 200, headers: { "content-type": "application/xml" } }), async () => {
    const r = await callCheckbookApi({ type_of_data: "Budget" });
    assert.equal(r.total_records, 0);
  });
  assert.equal(upstreamLocked(), false, "API XML");

  // A database timeout served as text/html (as seen live, #39) is not the bot check.
  await withFetch(
    async () => new Response(fixture("sqlstate-timeout.txt"), { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } }),
    () => assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }), { kind: "server_timeout" })
  );
  assert.equal(upstreamLocked(), false, "a database timeout");

  // Smart search: the site's own page without results (no marker) is not the bot check.
  await withFetch(async () => new Response("<html><body>Search results</body></html>", { status: 200, headers: { "content-type": "text/html" } }), async () => {
    const out = await smartSearch("laptops");
    assert.equal(out.available, false);
    assert.ok(out.fallback, "an empty page keeps the fallback");
  });
  assert.equal(upstreamLocked(), false, "a smart search page without results");
});

test("isBotCheckPage: only what the server already recognized as the bot check", () => {
  // /api
  assert.equal(isBotCheckPage("api", 200, "text/html", CHALLENGE), true);
  assert.equal(isBotCheckPage("api", 200, "text/html", LOADING_PAGE), true, "HTML where XML was expected (#39)");
  assert.equal(isBotCheckPage("api", 200, "application/xml", OK_XML), false);
  assert.equal(isBotCheckPage("api", 200, "text/html", fixture("sqlstate-timeout.txt")), false);
  assert.equal(isBotCheckPage("api", 302, "text/html", CHALLENGE), true);
  assert.equal(isBotCheckPage("api", 302, "text/html", LOADING_PAGE), false, "a plain 302");
  assert.equal(isBotCheckPage("api", 500, "text/html", CHALLENGE), false, "a 5xx is retried, never a bot check");
  // smart search: the site's pages are HTML, so only the marker counts
  assert.equal(isBotCheckPage("smart_search", 200, "text/html", CHALLENGE), true);
  assert.equal(isBotCheckPage("smart_search", 302, null, CHALLENGE), true);
  assert.equal(isBotCheckPage("smart_search", 200, "text/html", LOADING_PAGE), false);
  assert.equal(isBotCheckPage("smart_search", 302, "text/html", LOADING_PAGE), false);
});
