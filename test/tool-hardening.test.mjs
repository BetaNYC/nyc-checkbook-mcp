/**
 * Tool-layer hardening — issues #21 (error surfaces, never an empty set) and
 * #25 (smart_search hard-gated off by default).
 *
 * ALL OFFLINE. globalThis.fetch is stubbed; a real call to checkbooknyc.com would
 * be a test defect, and several tests assert `calls.length === 0` to prove the
 * network was never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerTools,
  smartSearchEnabled,
  SMART_SEARCH_DISABLED_MESSAGE,
} from "../dist/tools.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const INCAPSULA_403 = readFileSync(join(fixtures, "smart-search-incapsula-403.html"), "utf8");

async function connect() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0.0.0" });
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

/** Stub globalThis.fetch; records calls, returns whatever `handler` produces. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  })();
}

// ─── #21: a mocked 403 must SURFACE as an error, not resolve to an empty set ──

test("#21 search_spending on a 403 is an error, NOT total_records:0", async () => {
  const fetchStub = stubFetch(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }));
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "search_spending",
      arguments: { fiscal_year: "2024" },
    });
    assert.equal(res.isError, true, "an unreachable/blocked upstream must surface as an error");
    const text = res.content[0].text;
    // The core defect this guards: "unreachable" read as "no records exist."
    assert.doesNotMatch(text, /"total_records":\s*0/, "must not report a zero count on failure");
    assert.match(text, /403/, "carries the real HTTP status");
    assert.ok(fetchStub.calls.length >= 1, "it did attempt the request");
  } finally {
    await close();
    fetchStub.restore();
  }
});

test("#21 get_contract on a 403 is an error, NOT an empty records array", async () => {
  const fetchStub = stubFetch(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }));
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "get_contract",
      arguments: { contract_id: "CT185820201424467" },
    });
    assert.equal(res.isError, true, "a blocked lookup must not look like 'contract not found'");
    const text = res.content[0].text;
    assert.doesNotMatch(text, /"records":\s*\[\s*\]/, "must not present an empty result set on failure");
    assert.match(text, /403/);
  } finally {
    await close();
    fetchStub.restore();
  }
});

test("#21 a successful empty result still reports total_records:0 through the tool layer", async () => {
  // Distinguishes 'no matches' (a valid zero) from 'error' (now surfaced). This is
  // the behavior that must be PRESERVED by the #21 fix.
  const emptyOk =
    "<response><status><result>success</result></status>" +
    "<result_records><record_count>0</record_count></result_records></response>";
  const fetchStub = stubFetch(async () => new Response(emptyOk, { status: 200 }));
  const { client, close } = await connect();
  try {
    const res = await client.callTool({
      name: "search_spending",
      arguments: { fiscal_year: "2024" },
    });
    assert.notEqual(res.isError, true, "a real, successful zero is not an error");
    assert.match(res.content[0].text, /"total_records":\s*0/, "genuine zero is reported honestly");
  } finally {
    await close();
    fetchStub.restore();
  }
});

// ─── #25: smart_search hard-gated off by default ─────────────────────────────

test("#25 smartSearchEnabled reflects CHECKBOOK_ENABLE_SMART_SEARCH", async () => {
  await withEnv("CHECKBOOK_ENABLE_SMART_SEARCH", undefined, async () => {
    assert.equal(smartSearchEnabled(), false);
  });
  await withEnv("CHECKBOOK_ENABLE_SMART_SEARCH", "1", async () => assert.equal(smartSearchEnabled(), true));
  await withEnv("CHECKBOOK_ENABLE_SMART_SEARCH", "true", async () => assert.equal(smartSearchEnabled(), true));
  await withEnv("CHECKBOOK_ENABLE_SMART_SEARCH", "0", async () => assert.equal(smartSearchEnabled(), false));
});

test("#25 disabled by default: smart_search fails fast with guidance and NEVER calls the endpoint", async () => {
  await withEnv("CHECKBOOK_ENABLE_SMART_SEARCH", undefined, async () => {
    const fetchStub = stubFetch(async () => new Response(INCAPSULA_403, { status: 403 }));
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "smart_search", arguments: { query: "Salesforce" } });
      assert.equal(res.isError, true, "the disabled tool surfaces an error, not data");
      const text = res.content[0].text;
      assert.ok(
        text.includes(SMART_SEARCH_DISABLED_MESSAGE) || /CHECKBOOK_ENABLE_SMART_SEARCH/.test(text),
        "carries the opt-in guidance"
      );
      assert.equal(fetchStub.calls.length, 0, "MUST NOT touch the unsupported endpoint by default (#25)");
    } finally {
      await close();
      fetchStub.restore();
    }
  });
});

test("#25 opted in: smart_search reaches the endpoint (and reports WAF-unavailable)", async () => {
  await withEnv("CHECKBOOK_ENABLE_SMART_SEARCH", "1", async () => {
    const fetchStub = stubFetch(async () => new Response(INCAPSULA_403, { status: 403 }));
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "smart_search", arguments: { query: "Salesforce" } });
      assert.equal(res.isError, true, "still unavailable behind the WAF — but now because it tried");
      assert.ok(fetchStub.calls.length >= 1, "opt-in actually reaches the endpoint");
      assert.match(res.content[0].text, /WAF|Incapsula|unavailable/i);
    } finally {
      await close();
      fetchStub.restore();
    }
  });
});

test("#25 smart_search stays registered in tools/list (gate is not a removal — no breaking surface change)", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.ok(
      tools.some((t) => t.name === "smart_search"),
      "the tool remains discoverable; only its default behavior changed"
    );
  } finally {
    await close();
  }
});
