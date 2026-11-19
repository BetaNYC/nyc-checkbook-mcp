/**
 * #51: we follow the Comptroller's office's stated limits for the Checkbook NYC API
 * (README "API notes and limits"): 1 request per second per IP address, at most 20,000
 * records per call, and a block, not a throttle, for going over. So a 403 or a 429 is
 * NEVER retried, not even with Retry-After, and the error says stop and report.
 *
 * After any 403 or 429 the process locks until restart (test/upstream-lock.test.mjs).
 *
 * All offline: fetch is a fake; pace() is the real pacer, on a virtual clock.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fetchWithRetry, callCheckbookApi, CheckbookApiError, incidentId } from "../dist/checkbook.js";
import { registerTools } from "../dist/tools.js";
import { freshUpstream, withFetch } from "./helpers/upstream.mjs";

const MIN_INTERVAL_MS = 1_100;
const OK_XML =
  "<response><status><result>success</result></status>" +
  "<result_records><record_count>0</record_count></result_records></response>";
const BLOCK_PAGE =
  "<html><body><iframe>Request unsuccessful. Incapsula incident ID: 160000700030852915-73978535351423378</iframe></body></html>";
const RETRY_INVITE = /try again|retry|ask again (?!now)/i;

let clock;
beforeEach(() => {
  clock = freshUpstream();
});

for (const status of [403, 429]) {
  test(`#51 a ${status} with Retry-After is sent once and never retried`, async () => {
    let calls = 0;
    const sleeps = [];
    const res = await fetchWithRetry("http://x/api", {}, undefined, {
      fetchImpl: async () => {
        calls++;
        return new Response(BLOCK_PAGE, { status, headers: { "retry-after": "1" } });
      },
      sleepImpl: async (ms) => sleeps.push(ms),
      paceImpl: async () => {},
      makeSignal: () => undefined,
    });
    assert.equal(res.status, status);
    assert.equal(calls, 1, "exactly one request");
    assert.deepEqual(sleeps, [], "no wait for a retry, because there is no retry");
  });

  test(`#51 callCheckbookApi: a ${status} is one request and a plain "stop" error with the incident ID`, async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return new Response(BLOCK_PAGE, { status, headers: { "retry-after": "1", "content-type": "text/html" } });
      },
      () =>
        assert.rejects(
          () => callCheckbookApi({ type_of_data: "Budget" }),
          (err) => {
            assert.ok(err instanceof CheckbookApiError);
            assert.equal(err.kind, "refused");
            assert.equal(err.status, status);
            assert.match(err.message, status === 429 ? /rate-limited/ : /refused/);
            assert.match(err.message, /not "no records"/);
            assert.match(err.message, /Do not ask Checkbook NYC again now/);
            assert.match(err.message, /This server has stopped sending requests to Checkbook NYC until it is restarted/);
            assert.match(err.message, /report it to whoever runs this server or at https:\/\/github\.com\/BetaNYC\/nyc-checkbook-mcp\/issues/);
            assert.match(err.message, /160000700030852915-73978535351423378/);
            assert.doesNotMatch(err.message, RETRY_INVITE);
            return true;
          }
        )
    );
    assert.equal(calls, 1, "exactly one request");
  });
}

test("#51 the tool's answer to a 429 says stop and report, and does not invite a retry", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "rate-limits-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = await withFetch(
      async () => new Response(BLOCK_PAGE, { status: 429, headers: { "retry-after": "30" } }),
      () => client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", page_size: 1 } })
    );
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /rate-limited requests from this network \(HTTP 429\)/);
    assert.match(text, /Stop using these tools/);
    assert.match(text, /incident ID 160000700030852915-73978535351423378/);
    assert.doesNotMatch(text, RETRY_INVITE);
  } finally {
    await client.close();
    await server.close();
  }
});

test("#51 incidentId reads both forms Incapsula uses, and nothing else", () => {
  assert.equal(incidentId(BLOCK_PAGE), "160000700030852915-73978535351423378");
  assert.equal(incidentId("...&incident_id=1600-7397&edet=15"), "1600-7397");
  assert.equal(incidentId("Forbidden"), undefined);
});

test("#51 retried failures (timeout, 5xx) start at least 1.1 s after the attempt before them finished", async () => {
  const spans = [];
  const replies = [
    () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
    () => new Response("", { status: 503, headers: { "retry-after": "0" } }),
    () => new Response(OK_XML, { status: 200 }),
  ];
  const res = await fetchWithRetry(
    "http://x/api",
    {},
    { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 60_000, timeoutMs: 1_000 },
    {
      sleepImpl: (ms) => clock.sleep(ms),
      makeSignal: () => undefined,
      fetchImpl: async () => {
        const span = [clock.now()];
        spans.push(span);
        await clock.sleep(800); // the attempt takes time: a connection, a slow reply, a timeout
        span.push(clock.now());
        return replies[spans.length - 1]();
      },
    }
  );
  assert.equal(res.status, 200);
  assert.equal(spans.length, 3, "two retries, then the answer");
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i][0] - spans[i - 1][1];
    assert.ok(gap >= MIN_INTERVAL_MS, `retry ${i} started ${gap} ms after the attempt before it finished`);
  }
});

test("#51 the default policy retries at most twice", async () => {
  let calls = 0;
  await assert.rejects(() =>
    fetchWithRetry("http://x/api", {}, undefined, {
      fetchImpl: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
      sleepImpl: async () => {},
      paceImpl: async () => {},
      makeSignal: () => undefined,
    })
  );
  assert.equal(calls, 3);
});

test("#51 the default policy retries a timed-out request at most once (60 s timeout, 120 s deadline)", async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(() =>
    fetchWithRetry("http://x/api", {}, undefined, {
      nowImpl: () => clock,
      fetchImpl: async () => {
        calls++;
        clock += 60_000; // each attempt runs the full timeout
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      sleepImpl: async (ms) => {
        clock += ms;
      },
      paceImpl: async () => {
        clock += MIN_INTERVAL_MS;
      },
      makeSignal: () => undefined,
    })
  );
  assert.equal(calls, 2);
});

test("#51 no call asks for more than 20,000 records", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "rate-limits-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const withPageSize = (await client.listTools()).tools.filter((t) => t.inputSchema.properties?.page_size);
    assert.ok(withPageSize.length >= 5);
    for (const t of withPageSize) assert.equal(t.inputSchema.properties.page_size.maximum, 20000, t.name);

    const bodies = [];
    await withFetch(
      async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(OK_XML, { status: 200 });
      },
      async () => {
        const over = await client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", page_size: 20001 } });
        assert.equal(over.isError, true, "20,001 is refused");
        assert.equal(bodies.length, 0, "and never sent");
        const max = await client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", page_size: 20000 } });
        assert.notEqual(max.isError, true);
      }
    );
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /<max_records>20000<\/max_records>/);
  } finally {
    await client.close();
    await server.close();
  }
});
