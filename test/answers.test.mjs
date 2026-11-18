// #52, #53, #54: every data answer names its source and publisher, gives a link and an
// as-of (the time of the request: every Checkbook tool asks the live API), and every list
// says which records it holds and how to get the rest. No network: fetch is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, showing, answerProvenance } from "../dist/tools.js";
import { BETANYC_TOOL_NAMES } from "../dist/betanyc-tools.js";

const DS = JSON.parse(readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8"));

/** A success reply: `count` matches, `rows` transactions on this page. */
function reply(count, rows) {
  const tx = Array.from({ length: rows }, (_, i) => `<transaction><agency>A</agency><n>${i + 1}</n></transaction>`).join("");
  return `<response><status><result>success</result></status><result_records><record_count>${count}</record_count><t>${tx}</t></result_records></response>`;
}

async function withServer(body, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "answers-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
}

const ARGS = {
  search_contracts: { page_size: 50 },
  get_contract: { contract_id: "CT185820201424467" },
  search_spending: { fiscal_year: "2025" },
  search_budget: { fiscal_year: "2025" },
  search_payroll: { fiscal_year: "2025" },
  search_revenue: { fiscal_year: "2025" },
  get_agency_spending: { agency_code: "858", fiscal_year: "2025" },
  search_nycedc_contracts: {},
  search_nycha_contracts: {},
};

test("#52 #53 every Checkbook data answer has its source, publisher, link and a retrieval as-of", async () => {
  await withServer(reply(3, 3), async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => !BETANYC_TOOL_NAMES.includes(n) && n !== "smart_search");
    assert.deepEqual(names.sort(), Object.keys(ARGS).sort(), "every Checkbook tool is covered here");
    for (const name of names) {
      const before = Date.now();
      const res = await client.callTool({ name, arguments: ARGS[name] });
      assert.notEqual(res.isError, true, `${name}: ${res.content[0].text}`);
      const text = res.content[0].text;
      const src = DS.sources.find((s) => s.tools.includes(name));
      const json = JSON.parse(text.slice(0, text.indexOf("\n\nSource: ")));
      assert.equal(json.source.source, src.source_name, name);
      assert.equal(json.source.publisher, src.publisher.name, name);
      assert.equal(json.source.source_url, src.source_url, name);
      assert.equal(json.source.as_of_kind, "retrieved", name);
      assert.ok(Date.parse(json.source.as_of) >= before - 1000, `${name}: as_of is the time of the request`);
      assert.match(text, new RegExp(`\\n\\nSource: .*${src.publisher.name}.* As of ${json.source.as_of.replace(/[.]/g, "\\.")} \\(fetched from the source for this answer\\)\\. Link: ${src.source_url.replace(/[.]/g, "\\.")}`), name);
    }
  });
});

test("answerProvenance throws for a tool DATA-SOURCES.json does not cover", () => {
  assert.throws(() => answerProvenance("no_such_tool"), /no usable source for no_such_tool/);
});

test("#54 a large result says which records it holds and which page comes next", async () => {
  await withServer(reply(19139, 50), async (client) => {
    const p1 = JSON.parse((await client.callTool({ name: "search_spending", arguments: { fiscal_year: "2025" } })).content[0].text.split("\n\nSource: ")[0]);
    assert.equal(p1.total_records, 19139);
    assert.equal(p1.records.length, 50);
    assert.equal(p1.showing, "Showing records 1 to 50 of 19,139. For the next 50, call again with page=2 (page_size up to 20,000).");
    const p3 = JSON.parse((await client.callTool({ name: "search_spending", arguments: { fiscal_year: "2025", page: 3 } })).content[0].text.split("\n\nSource: ")[0]);
    assert.match(p3.showing, /^Showing records 101 to 150 of 19,139\. For the next 50, call again with page=4/);
  });
});

test("#54 showing: the last page, a short last page, no matches, and a page past the end", () => {
  assert.equal(showing(120, 3, 50, 20), "Showing records 101 to 120 of 120, the last of them.");
  assert.equal(showing(130, 2, 50, 50), "Showing records 51 to 100 of 130. For the next 30, call again with page=3 (page_size up to 20,000).");
  assert.equal(showing(0, 1, 50, 0), "No records match.");
  assert.equal(showing(5, 2, 50, 0), "No records on page 2: there are 5, so the last page at page_size=50 is 1.");
});

test("#54 get_contract says when a contract has more records than it shows", async () => {
  await withServer(reply(14, 10), async (client) => {
    const text = (await client.callTool({ name: "get_contract", arguments: { contract_id: "CT1" } })).content[0].text;
    const json = JSON.parse(text.split("\n\nSource: ")[0]);
    assert.equal(json.total_records, 14);
    assert.match(json.showing, /^Showing the first 10 of 14 records for this contract\. For all of them, use search_contracts with contract_id="CT1"/);
  });
  await withServer(reply(2, 2), async (client) => {
    const json = JSON.parse((await client.callTool({ name: "get_contract", arguments: { contract_id: "CT1" } })).content[0].text.split("\n\nSource: ")[0]);
    assert.equal(json.showing, "Showing records 1 to 2 of 2, the last of them.");
  });
});
