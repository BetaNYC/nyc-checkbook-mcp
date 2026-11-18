// Offline tests for #39: a reply that is not the API's XML used to surface as a bare
// "Error: Empty response". It now says what the reply most likely was, keeps the
// evidence (status, Content-Type, length, the first 300 characters), and says this
// is not "no records". No network: fetch is stubbed. Each kind's sample is a reply
// actually seen (provenance in src/checkbook.ts, classifyReply).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callCheckbookApi, classifyReply, CheckbookApiError, REPLY_EXCERPT_MAX } from "../dist/checkbook.js";
import { registerTools } from "../dist/tools.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const CASES = [
  { kind: "server_timeout", body: fixture("sqlstate-timeout.txt"), type: "text/html; charset=UTF-8", what: /statement timeout\)\. Try a narrower search/ },
  // Only the phrase was recorded (#8, 2026-07-28), not the full body.
  { kind: "api_rejected_request", body: "contract_includes_sub_vendors is not of data type integer", type: "text/plain", what: /rejected a value in the request/ },
  { kind: "access_challenge", body: fixture("smart-search-incapsula-403.html"), type: "text/html", what: /Stop calling Checkbook NYC/ },
  { kind: "access_challenge", body: fixture("smart-search-loading-302.html"), type: "text/html", what: /bot check/ },
  { kind: "empty_body", body: "", type: null, what: /The reply was empty/ },
  { kind: "unparseable", body: "something else entirely", type: "text/plain", what: /The cause is not known/ },
];

async function withReply(body, type, fn) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // A null body: a string body, even "", makes Response add a text/plain Content-Type.
    return new Response(body || null, { status: 200, headers: type ? { "content-type": type } : {} });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

test("#39 classifyReply names each kind from its observed marker", () => {
  for (const c of CASES) assert.equal(classifyReply(c.type, c.body), c.kind, c.kind);
});

test("#39 a non-XML reply is an error with its kind, evidence and 'not no records', and is not retried", async () => {
  for (const c of CASES) {
    const calls = await withReply(c.body, c.type, async () => {
      await assert.rejects(callCheckbookApi({ type_of_data: "Spending" }), (err) => {
        assert.ok(err instanceof CheckbookApiError, c.kind);
        assert.equal(err.kind, c.kind);
        assert.equal(err.status, 200);
        assert.match(err.message, /this is not "no records"/, c.kind);
        assert.match(err.message, c.what, c.kind);
        assert.match(err.message, new RegExp(`HTTP 200, Content-Type ${c.type ? c.type.replace(/[;]/g, "\\$&") : "none"}, ${Buffer.byteLength(c.body)} bytes`), c.kind);
        assert.doesNotMatch(err.message, /Empty response/);
        return true;
      });
    });
    assert.equal(calls, 1, `${c.kind}: one request, no retry`);
  }
});

test("#39 the excerpt is the start of the reply, one line, at most 300 characters", async () => {
  const body = "SQLSTATE[57014]\n\t" + "x".repeat(1000);
  await withReply(body, "text/plain", async () => {
    await assert.rejects(callCheckbookApi({ type_of_data: "Spending" }), (err) => {
      const excerpt = err.message.match(/Start of the reply: "([^"]*)"/)[1];
      assert.equal(excerpt.length, REPLY_EXCERPT_MAX);
      assert.ok(excerpt.startsWith("SQLSTATE[57014] x"));
      assert.doesNotMatch(excerpt, /[\n\t]/);
      return true;
    });
  });
});

test("#39 through a tool: isError, the kind, and no zero count", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    await withReply(fixture("sqlstate-timeout.txt"), "text/html", async () => {
      const res = await client.callTool({
        name: "search_spending",
        arguments: { fiscal_year: "2026", payee_name: "ASSOCIATION OF COMMUNITY EMPLOYMENT PROGRAMS FOR THE HOMELESS" },
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /server_timeout/);
      assert.match(res.content[0].text, /not "no records"/);
      assert.doesNotMatch(res.content[0].text, /total_records/);
    });
  } finally {
    await client.close();
    await server.close();
  }
});
