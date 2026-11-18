// #57: every failure is an isError result with a plain sentence on what went wrong and what
// to try, no stack trace, and at most 500 characters of the API's own words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, failure, VENDOR_NAME_UNSUPPORTED_MESSAGE } from "../dist/tools.js";
import { UPSTREAM_BODY_MAX } from "../dist/betanyc-tools.js";
import { freshUpstream } from "./helpers/upstream.mjs";

const STACK = /^\s*at\s+\S/m;
const TRY = /Try |Check |Stop calling|Wait |Give one|Omit |Options:|Use the structured tools|[Rr]eport it (at|to)/;
const LONG = "x".repeat(2000);
const failXml = (d) =>
  `<response><status><result>failure</result><messages><message><code>1101</code><description>${d}</description></message></messages></status></response>`;

const CASES = [
  { name: "network error", fetch: async () => { throw new TypeError("fetch failed"); } },
  { name: "HTTP 403", fetch: async () => new Response("blocked", { status: 403 }), want: /stopped sending requests to Checkbook NYC until it is restarted/ },
  // After the 403 the process is locked (#51): nothing is sent, and the answer still says what to do.
  { name: "locked after a 403", locked: true, fetch: async () => assert.fail("a locked server sent a request"), want: /must be restarted/ },
  { name: "HTTP 503", fetch: async () => new Response("down", { status: 503 }), want: /Try again in a few minutes/ },
  { name: "API refusal, long message", fetch: async () => new Response(failXml(LONG), { status: 200 }), want: /cut at 500 characters/ },
  { name: "not the API's XML", fetch: async () => new Response("SQLSTATE[57014]: Query canceled", { status: 200 }), want: /Try a narrower search/ },
];

async function connect() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "errors-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function assertPlainFailure(res, label) {
  assert.equal(res.isError, true, label);
  const text = res.content.map((c) => c.text).join("\n");
  assert.doesNotMatch(text, STACK, `${label}: no stack trace`);
  assert.match(text, TRY, `${label}: says what to try`);
  const upstream = text.split("\nThe source said: ")[1] ?? "";
  assert.ok([...upstream.replace(/… \(cut at \d+ characters\)$/, "")].length <= UPSTREAM_BODY_MAX, `${label}: upstream text cut`);
  return text;
}

test("#57 every Checkbook failure is a plain, cut, stack-free isError with what to try", async () => {
  const { client, close } = await connect();
  const original = globalThis.fetch;
  try {
    for (const c of CASES) {
      if (!c.locked) freshUpstream();
      globalThis.fetch = c.fetch;
      const res = await client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", page_size: 1 } });
      const text = assertPlainFailure(res, c.name);
      if (c.want) assert.match(text, c.want, c.name);
      assert.doesNotMatch(text, /x{501}/, `${c.name}: never more than 500 characters of upstream text`);
    }
  } finally {
    globalThis.fetch = original;
    await close();
  }
});

test("#57 refused inputs are guidance, not errors from a bug", async () => {
  const { client, close } = await connect();
  try {
    for (const [name, args] of [
      ["search_contracts", { vendor_name: "Acme" }],
      ["search_spending", {}],
      ["search_payroll", {}],
      ["smart_search", { query: "Salesforce" }],
    ]) {
      const text = assertPlainFailure(await client.callTool({ name, arguments: args }), name);
      assert.doesNotMatch(text, /The tool failed/, name);
    }
    const res = await client.callTool({ name: "search_contracts", arguments: { vendor_name: "Acme" } });
    assert.ok(res.content[0].text.includes(VENDOR_NAME_UNSUPPORTED_MESSAGE));
  } finally {
    await close();
  }
});

test("#57 an unexpected error says where to report it and carries no stack", () => {
  const err = new TypeError("Cannot read properties of undefined");
  const text = failure(err).content[0].text;
  assert.match(text, /^Error: The tool failed: Cannot read properties of undefined\. Try again; if it keeps failing, report it at https:\/\/github\.com\/BetaNYC\/nyc-checkbook-mcp\/issues$/);
  assert.doesNotMatch(text, STACK);
});
