/**
 * #51, the owner's decision of 2026-11-18: after ANY 403 or 429 from Checkbook NYC, this server
 * process refuses every later upstream call and sends nothing, until it is restarted. No timer,
 * no automatic unlock. Calls already waiting in the pacer are not sent either. The tools that
 * never touch the network (about_data, about_betanyc, whats_changed) keep working.
 *
 * Also here: the pacer seen from the tools (two different tool calls at once), and the 120 s
 * retry deadline counting time spent waiting in the pacer's queue.
 *
 * All offline: every fetch is a stub; the pacer is the real one, on a virtual clock.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { callCheckbookApi, fetchWithRetry, smartSearch, upstreamLocked, CheckbookApiError } from "../dist/checkbook.js";
import { freshUpstream, withFetch } from "./helpers/upstream.mjs";

const MIN_INTERVAL_MS = 1_100;
const OK_XML =
  "<response><status><result>success</result></status>" +
  "<result_records><record_count>0</record_count></result_records></response>";
const INCIDENT = "160000700030852915-73978535351423378";
const BLOCK_PAGE = `<html><body><iframe>Request unsuccessful. Incapsula incident ID: ${INCIDENT}</iframe></body></html>`;
const RETRY_INVITE = /try again|retry|ask again (?!now)/i;
const LOCKED = /This server has stopped sending requests to Checkbook NYC, and sent nothing for this call/;

let clock;
beforeEach(() => {
  clock = freshUpstream();
});

async function connect() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "upstream-lock-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (res) => res.content.map((c) => c.text).join("\n");

/** The plain locked error, in full. */
function assertLocked(res, status, label) {
  assert.equal(res.isError, true, label);
  const text = textOf(res);
  assert.match(text, LOCKED, label);
  assert.match(text, status === 429 ? /rate-limited requests from this network at / : /refused requests from this network at /, label);
  assert.match(text, /at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(HTTP \d{3}\)/, `${label}: says when`);
  assert.match(text, /Asking again will not help and could make the block last longer/, label);
  assert.match(text, /Report it to whoever runs this server, with the Incapsula incident ID 160000700030852915-73978535351423378/, label);
  assert.match(text, /must be restarted, after a person has checked, before it will send anything again/, label);
  assert.doesNotMatch(text, RETRY_INVITE, `${label}: no invitation to retry`);
}

const SAME_TIME = [
  ["search_budget", { fiscal_year: "2026", page_size: 1 }],
  ["search_spending", { fiscal_year: "2026", page_size: 1 }],
  ["get_contract", { contract_id: "CT1" }],
  ["search_payroll", { fiscal_year: "2026", page_size: 1 }],
  ["search_revenue", { fiscal_year: "2026", page_size: 1 }],
];

for (const status of [429, 403]) {
  test(`#51 five tool calls at once, the first reply is ${status}: one request, four locked errors`, async () => {
    const { client, close } = await connect();
    let calls = 0;
    try {
      const results = await withFetch(
        async () => {
          calls++;
          await clock.sleep(300); // the reply takes a moment; the others wait in the pacer
          return new Response(BLOCK_PAGE, { status, headers: { "content-type": "text/html" } });
        },
        () => Promise.all(SAME_TIME.map(([name, args]) => client.callTool({ name, arguments: args })))
      );
      assert.equal(calls, 1, "fetch was called exactly once");
      assert.ok(upstreamLocked());
      // The call that was sent gets the refusal itself, which also says the server has stopped.
      const refusal = new RegExp(`\\(HTTP ${status}\\)\\. This is not "no records"`);
      const sent = results.filter((r) => refusal.test(textOf(r)));
      assert.equal(sent.length, 1, "one answer is the refusal");
      assert.equal(sent[0].isError, true);
      assert.match(textOf(sent[0]), /This server has stopped sending requests to Checkbook NYC until it is restarted/);
      assert.match(textOf(sent[0]), new RegExp(INCIDENT));
      results.forEach((r, i) => r === sent[0] || assertLocked(r, status, SAME_TIME[i][0]));

      // And a later call: nothing is sent.
      const later = await withFetch(
        async () => assert.fail("a locked server sent a request"),
        () => client.callTool({ name: "search_budget", arguments: { fiscal_year: "2025", page_size: 1 } })
      );
      assertLocked(later, status, "a later call");
      assert.equal(calls, 1, "still exactly one request");
    } finally {
      await close();
    }
  });
}

test("#51 a call that arrives while the block page is still being read gets the incident ID too", async () => {
  let calls = 0;
  let sendBody;
  const bodyArrives = new Promise((r) => (sendBody = r));
  let fetched;
  const fetchCalled = new Promise((r) => (fetched = r));
  await withFetch(
    async () => {
      calls++;
      fetched();
      // Headers now, the body later: a slow network, or a slow CI machine.
      const body = new ReadableStream({
        async start(c) {
          await bodyArrives;
          c.enqueue(new TextEncoder().encode(BLOCK_PAGE));
          c.close();
        },
      });
      return new Response(body, { status: 429 });
    },
    async () => {
      const first = callCheckbookApi({ type_of_data: "Budget" });
      await fetchCalled;
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const late = callCheckbookApi({ type_of_data: "Spending" }); // arrives mid-body
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      sendBody();
      await assert.rejects(first, { kind: "refused" });
      await assert.rejects(late, (err) => {
        assert.equal(err.kind, "locked");
        assert.match(err.message, new RegExp(`incident ID ${INCIDENT}`));
        return true;
      });
    }
  );
  assert.equal(calls, 1);
});

test("#51 the lock has no timer: hours later, still locked and still nothing sent", async () => {
  await withFetch(
    async () => new Response(BLOCK_PAGE, { status: 429 }),
    () => assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }), { kind: "refused" })
  );
  await clock.sleep(24 * 60 * 60 * 1000);
  await withFetch(
    async () => assert.fail("a locked server sent a request"),
    () =>
      assert.rejects(
        () => callCheckbookApi({ type_of_data: "Budget" }),
        (err) => err instanceof CheckbookApiError && err.kind === "locked" && err.message.includes(INCIDENT)
      )
  );
});

/** Every upstream path, as a function that makes one call. */
const PATHS = {
  runSearch: (client) => client.callTool({ name: "search_spending", arguments: { fiscal_year: "2026", page_size: 1 } }),
  get_contract: (client) => client.callTool({ name: "get_contract", arguments: { contract_id: "CT1" } }),
  smartSearch: (client) => client.callTool({ name: "smart_search", arguments: { query: "laptops" } }),
};

for (const [blockedOn, first] of Object.entries(PATHS)) {
  test(`#51 the lock is shared by every upstream path: blocked on ${blockedOn}`, async () => {
    const saved = process.env.CHECKBOOK_ENABLE_SMART_SEARCH;
    process.env.CHECKBOOK_ENABLE_SMART_SEARCH = "1";
    const { client, close } = await connect();
    try {
      await withFetch(async () => new Response(BLOCK_PAGE, { status: 403 }), () => first(client));
      assert.ok(upstreamLocked(), `a 403 on ${blockedOn} locks the process`);
      await withFetch(
        async () => assert.fail("a locked server sent a request"),
        async () => {
          for (const [name, call] of Object.entries(PATHS)) assertLocked(await call(client), 403, `${name} after a block on ${blockedOn}`);
          // The functions themselves, not only the tools.
          await assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }), { kind: "locked" });
          await assert.rejects(() => smartSearch("laptops"), { kind: "locked" });
          await assert.rejects(() => fetchWithRetry("http://x/api", {}), { kind: "locked" });
        }
      );
    } finally {
      await close();
      if (saved === undefined) delete process.env.CHECKBOOK_ENABLE_SMART_SEARCH;
      else process.env.CHECKBOOK_ENABLE_SMART_SEARCH = saved;
    }
  });
}

test("#51 while locked, about_data, about_betanyc and whats_changed still answer", async () => {
  const { client, close } = await connect();
  try {
    await withFetch(async () => new Response("Forbidden", { status: 403 }), () => PATHS.runSearch(client));
    assert.ok(upstreamLocked());
    await withFetch(
      async () => assert.fail("a locked server sent a request"),
      async () => {
        for (const name of ["about_data", "about_betanyc", "whats_changed"]) {
          const res = await client.callTool({ name, arguments: {} });
          assert.notEqual(res.isError, true, `${name}: ${textOf(res).slice(0, 200)}`);
          assert.ok(textOf(res).length > 0, name);
        }
      }
    );
  } finally {
    await close();
  }
});

test("#51 the locked error without an incident ID says so plainly, and keeps the first block's details", async () => {
  await withFetch(async () => new Response("Forbidden", { status: 429 }), () =>
    assert.rejects(() => callCheckbookApi({ type_of_data: "Budget" }))
  );
  await assert.rejects(
    () => callCheckbookApi({ type_of_data: "Budget" }),
    (err) => {
      assert.match(err.message, /rate-limited requests from this network at .* \(HTTP 429\)/);
      assert.match(err.message, /Report it to whoever runs this server\. The server must be restarted/);
      assert.doesNotMatch(err.message, /incident/);
      return true;
    }
  );
});

test("#51 the server cannot unlock itself: the reset refuses to run outside the test runner", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import("${new URL("../dist/checkbook.js", import.meta.url)}").then((m) => m.resetUpstreamForTests())`],
    { env, encoding: "utf8" }
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /resetUpstreamForTests is for the test runner only/);
});

// ─── The pacer, seen from the tools ──────────────────────────────────────────

test("two different tool calls at once: the second request starts 1.1 s after the first one finished", async () => {
  const { client, close } = await connect();
  const spans = [];
  try {
    const results = await withFetch(
      async () => {
        const span = { start: clock.now() };
        spans.push(span);
        await clock.sleep(500); // the first request opens a connection: it takes a while
        span.end = clock.now();
        return new Response(OK_XML, { status: 200 });
      },
      () =>
        Promise.all([
          client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", page_size: 1 } }),
          client.callTool({ name: "get_contract", arguments: { contract_id: "CT1" } }),
        ])
    );
    for (const r of results) assert.notEqual(r.isError, true, textOf(r));
    assert.equal(spans.length, 2);
    spans.sort((a, b) => a.start - b.start);
    assert.ok(spans[0].end <= spans[1].start, "one request at a time");
    const gap = spans[1].start - spans[0].end;
    assert.ok(gap >= MIN_INTERVAL_MS, `the second request started ${gap} ms after the first one finished`);
  } finally {
    await close();
  }
});

// ─── The 120 s deadline counts time in the pacer's queue (README) ────────────

test("#51 no retry starts more than 120 s after the call began, time waiting in the queue included", async () => {
  const policy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, deadlineMs: 120_000, timeoutMs: 60_000 };
  let retried = 0;
  // This call's first attempt is first in the queue: a 503 at once, so it plans a retry.
  const call = fetchWithRetry("http://x/api", {}, policy, {
    sleepImpl: (ms) => clock.sleep(ms),
    randomImpl: () => 0,
    makeSignal: () => undefined,
    fetchImpl: async () => {
      retried++;
      return new Response("busy", { status: 503 });
    },
  });
  // Started at the same moment, so it is next in the queue, and its request holds the queue
  // for 130 s. The retry's turn comes after that: past the 120 s deadline.
  const slowOther = fetchWithRetry("http://x/other", {}, policy, {
    sleepImpl: (ms) => clock.sleep(ms),
    makeSignal: () => undefined,
    fetchImpl: async () => {
      await clock.sleep(130_000);
      return new Response(OK_XML, { status: 200 });
    },
  });
  const [res] = await Promise.all([call, slowOther]);
  assert.equal(retried, 1, "the retry waited in the queue past 120 s, so it was not sent");
  assert.equal(res.status, 503, "the last reply is returned as it was");
});
