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
const API_CHANGES =
  "converted from XML to JSON; asks for fewer fields than the API offers; spaces trimmed from the ends of values; rows not dropped or reordered";

/** "2026-11-18 13:05 EST", New York wall-clock time to the minute (shared module 1.5.1). */
function nyMinute(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

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
      const json = JSON.parse(text.split("\n\n")[0]);
      assert.equal(json.source.source, src.source_name, name);
      assert.equal(json.source.publisher, src.publisher.name, name);
      assert.equal(json.source.source_url, src.source_url, name);
      assert.equal(json.source.as_of_kind, "retrieved", name);
      assert.ok(Date.parse(json.source.as_of) >= before - 1000, `${name}: as_of is the time of the request`);
      assert.equal(json.source.retrieved_at, json.source.as_of, `${name}: retrieved_at is the same instant`);
      // Shared module 1.5.1: the source line gives the fetch time in New York time, to the minute.
      // 1.5.2: about_data says BetaNYC modified these sources, so every answer says so too.
      const ny = nyMinute(new Date(json.source.retrieved_at));
      assert.match(text, new RegExp(`\\n\\nBetaNYC modified this data: ${API_CHANGES}\\. This copy should not be considered the official record\\. Fetched from the source for this answer at ${ny} \\(New York time\\)\\. Official record: .*${src.publisher.name}.*, ${src.source_url.replace(/[.]/g, "\\.")}`), name);
      assert.doesNotMatch(text, /\nSource: /, `${name}: no bare Source line`);
      assert.deepEqual(json.source.changed_by_betanyc, { kind: "modified-by-betanyc", detail: API_CHANGES }, name);
    }
  });
});

test("a live answer's Source line gives the fetch time in New York time, standard and daylight", () => {
  const winter = answerProvenance("search_spending", new Date("2026-11-18T18:05:42Z"));
  assert.match(winter.text, /Fetched from the source for this answer at 2026-11-18 13:05 EST \(New York time\)\./);
  assert.equal(winter.provenance.as_of, "2026-11-18T18:05:42.000Z");
  assert.equal(winter.provenance.retrieved_at, "2026-11-18T18:05:42.000Z");
  assert.equal(winter.provenance.as_of_kind, "retrieved");
  const summer = answerProvenance("search_spending", new Date("2026-07-04T03:30:00Z"));
  assert.match(summer.text, /Fetched from the source for this answer at 2026-07-03 23:30 EDT \(New York time\)\./);
});

test("answerProvenance throws for a tool DATA-SOURCES.json does not cover", () => {
  assert.throws(() => answerProvenance("no_such_tool"), /no usable source for no_such_tool/);
});

test("#54 a large result says which records it holds and which page comes next", async () => {
  await withServer(reply(19139, 50), async (client) => {
    const p1 = JSON.parse((await client.callTool({ name: "search_spending", arguments: { fiscal_year: "2025" } })).content[0].text.split("\n\n")[0]);
    assert.equal(p1.total_records, 19139);
    assert.equal(p1.records.length, 50);
    assert.equal(p1.showing, "Showing records 1 to 50 of 19,139. For the next 50, call again with page=2 (page_size up to 20,000).");
    const p3 = JSON.parse((await client.callTool({ name: "search_spending", arguments: { fiscal_year: "2025", page: 3 } })).content[0].text.split("\n\n")[0]);
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
    const json = JSON.parse(text.split("\n\n")[0]);
    assert.equal(json.total_records, 14);
    assert.match(json.showing, /^Showing the first 10 of 14 records for this contract\. For all of them, use search_contracts with contract_id="CT1"/);
  });
  await withServer(reply(2, 2), async (client) => {
    const json = JSON.parse((await client.callTool({ name: "get_contract", arguments: { contract_id: "CT1" } })).content[0].text.split("\n\n")[0]);
    assert.equal(json.showing, "Showing records 1 to 2 of 2, the last of them.");
  });
});

// ─── Review of #65: each answer's label agrees with about_data ──────────────

/** about_data's answer for a source (officialKind in the shared module). */
const kindOf = (s) => (!s.official ? "produced-by-betanyc" : s.changes?.changed || s.changes?.steps?.length ? "modified-by-betanyc" : "published-as-is");

test("review of #65: every tool's answer says what about_data says about its source", () => {
  for (const s of DS.sources) {
    for (const tool of s.tools) {
      const p = answerProvenance(tool, new Date("2026-11-18T18:05:42Z"));
      const kind = kindOf(s);
      assert.equal(p.provenance.changed_by_betanyc?.kind ?? "published-as-is", kind, `${tool}: about_data says ${kind}`);
      if (kind === "modified-by-betanyc") {
        assert.match(p.text, /^BetaNYC modified this data: .+\. This copy should not be considered the official record\. .* Official record: /, tool);
        assert.doesNotMatch(p.text, /^Source: /, `${tool}: no bare Source line`);
      }
    }
  }
});

test("review of #65: the API sources' detail says values are trimmed, not 'every value unchanged'", () => {
  const api = DS.sources.filter((s) => s.id !== "smart-search");
  assert.equal(api.length, 7);
  for (const s of api) {
    assert.doesNotMatch(s.changes.detail, /every value unchanged/, s.id);
    assert.match(s.changes.detail, /trims spaces from the start and end of each value/, s.id);
    assert.match(s.changes.detail, /Records are not left out or reordered/, s.id);
  }
  assert.match(answerProvenance("search_spending").text, /spaces trimmed from the ends of values/);
});

test("review of #65: smart_search's label says it leaves results out, and how it changes them", () => {
  const s = DS.sources.find((x) => x.id === "smart-search");
  assert.ok(s.changes.steps.includes("filtered"), "the standard's word for leaving records out");
  assert.match(s.changes.detail, /A result with no field it can read is left out/);
  assert.match(s.changes.detail, /Only the first line of each value is kept/);
  assert.match(s.changes.detail, /the later value replaces the earlier one/);
  assert.match(s.changes.detail, /total_results is the number of results the server read, not the site's own count/);
  const p = answerProvenance("smart_search", new Date("2026-11-18T18:05:42Z"));
  assert.equal(p.provenance.changed_by_betanyc.kind, "modified-by-betanyc");
  for (const re of [/results with no readable fields left out/, /only the first line of a value kept/, /a field name seen twice keeps its last value/, /total_results is this server's own count/]) {
    assert.match(p.text, re);
  }
});
