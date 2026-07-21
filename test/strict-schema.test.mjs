/**
 * Issue #19 — unknown parameters must be rejected, not silently dropped.
 *
 * Two layers, both asserted here:
 *   (a) the advertised inputSchema in tools/list carries additionalProperties:false,
 *       so the CALLING model knows an invented parameter is invalid; and
 *   (b) the server refuses an unknown key at parse time, so anything that slips
 *       past the advertised contract raises instead of being stripped.
 *
 * No network: fetch is stubbed with a fixture. Before the fix, the behavioral
 * test reaches the stub and returns bulk contract rows — which is the bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, VENDOR_NAME_UNSUPPORTED_MESSAGE } from "../dist/tools.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CONTRACTS_XML = readFileSync(join(fixtures, "contracts-response.xml"), "utf8");

/** Connect a client to a server with the real tools registered. */
async function connect() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Replace global fetch with a fixture-backed stub. Returns { calls, restore }.
 * Any live call to checkbooknyc.com would be a test defect, so this both keeps
 * the suite hermetic and lets a test assert the API was never reached.
 */
function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(CONTRACTS_XML, { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("every tool advertises additionalProperties:false (#19)", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();

  assert.ok(tools.length > 0, "tools were registered");
  for (const tool of tools) {
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} must advertise additionalProperties:false so a calling model ` +
        `knows an invented parameter is invalid`
    );
  }

  await close();
});

test("search_contracts with the undeclared 'vendor' key errors and names vendor_name (#19)", async () => {
  const fetchStub = stubFetch();
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "search_contracts",
      arguments: { vendor: "Community League of the Heights", page_size: 3 },
    });

    const text = res.content[0].text;
    assert.equal(
      res.isError,
      true,
      "an undeclared parameter must raise, not be silently dropped and answered"
    );
    // The failure this guards against: 5,755,099 unrelated rows presented as an answer.
    assert.doesNotMatch(text, /total_records/, "must not return contract rows");
    assert.equal(fetchStub.calls.length, 0, "must not reach the Checkbook API at all");
    // The guess must land on the real parameter, and on the same three alternatives
    // a correct vendor_name call already offers.
    assert.match(text, /vendor_name/, "names the declared parameter");
    assert.ok(
      text.includes(VENDOR_NAME_UNSUPPORTED_MESSAGE),
      "carries the vendor-name guidance rather than a bare unrecognized-key error"
    );
  } finally {
    await close();
    fetchStub.restore();
  }
});

test("an unknown key on any other tool is refused too (#19)", async () => {
  const fetchStub = stubFetch();
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "search_budget",
      arguments: { fiscal_year: "2026", bogus_unknown_param: "x" },
    });
    assert.equal(res.isError, true, "unknown key must raise");
    assert.match(res.content[0].text, /bogus_unknown_param/, "names the offending key");
    assert.equal(fetchStub.calls.length, 0, "must not reach the Checkbook API");
  } finally {
    await close();
    fetchStub.restore();
  }
});

// ─── Regression guards: strictness must not break declared parameters ─────────

test("a valid search_contracts call still runs and returns records (#19)", async () => {
  const fetchStub = stubFetch();
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "search_contracts",
      arguments: { vendor_code: "V123", fiscal_year: "2024", page_size: 3 },
    });
    assert.notEqual(res.isError, true, "declared parameters must still work");
    const text = res.content[0].text;
    assert.match(text, /"total_records": 5755099/);
    assert.match(text, /UNRELATED IT VENDOR INC/);
    assert.equal(fetchStub.calls.length, 1, "one upstream request");
    // Defaults survive .strict(): status/category are still applied.
    assert.match(fetchStub.calls[0].body, /<name>status<\/name>/);
    assert.match(fetchStub.calls[0].body, /<name>vendor_code<\/name>/);
  } finally {
    await close();
    fetchStub.restore();
  }
});

test("vendor_name still returns VENDOR_NAME_UNSUPPORTED_MESSAGE (#19 regression on #16)", async () => {
  const fetchStub = stubFetch();
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "search_contracts",
      arguments: { vendor_name: "Community League of the Heights", page_size: 3 },
    });
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes(VENDOR_NAME_UNSUPPORTED_MESSAGE));
    assert.equal(fetchStub.calls.length, 0, "fail-fast before any upstream call");
  } finally {
    await close();
    fetchStub.restore();
  }
});
