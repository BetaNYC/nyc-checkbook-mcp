// about_data: "where does this data come from?" (betanyc-ai-workspace
// platform/system/about-data-standard.md). The answer comes from DATA-SOURCES.json through
// BetaNYC's shared module (src/betanyc-tools.ts, a copy: never edit it here). These tests keep
// three promises: every tool has a documented source, so a new tool cannot ship unexplained;
// every Checkbook source is the Comptroller's record, passed on with its values unchanged; and
// smart_search's source never reads as "fetched when you ask" while the tool is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import {
  betanycTools,
  SERVER_INSTRUCTIONS,
  SMART_SEARCH_OFF_REASON,
} from "../dist/betanyc.js";
import {
  assertEveryToolExplained,
  BETANYC_INSTRUCTIONS,
  SHARED_MODULE_VERSION,
} from "../dist/betanyc-tools.js";

const DS_TEXT = readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8");
const API_TOPICS = ["spending", "contracts", "budget", "payroll", "revenue", "nycedc-contracts", "nycha-contracts"];

async function listedToolNames() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "about-data-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

const ask = (args, smartSearch = false) => betanycTools({ smartSearch }).call("about_data", args);
const one = (r, topic) => r.structuredContent.sources.find((s) => s.topic === topic);

test("shared module 1.3.7", () => {
  assert.equal(SHARED_MODULE_VERSION, "1.3.7");
});

test("every tool says where its data comes from, so a new tool cannot ship unexplained", async () => {
  const names = await listedToolNames();
  assert.ok(names.includes("about_data"));
  assertEveryToolExplained(DS_TEXT, names);
  assert.throws(() => assertEveryToolExplained(DS_TEXT, [...names, "brand_new_tool"]), /brand_new_tool/);
});

test("every source names its source, publisher, link and whether it is official", () => {
  const r = ask({});
  assert.notEqual(r.isError, true);
  assert.deepEqual(r.structuredContent.topics, [...API_TOPICS, "smart-search"]);
  for (const s of r.structuredContent.sources) {
    assert.equal(s.publisher, "Office of the New York City Comptroller", s.topic);
    assert.ok(s.source && s.source_url.startsWith("https://www.checkbooknyc.com/"), s.topic);
    assert.equal(s.official, true, s.topic);
  }
  assert.equal(r.structuredContent.contact_email, "lab@beta.nyc");
  assert.match(r.content[0].text, /Questions or error reports about this data, to BetaNYC: lab@beta\.nyc/);
});

test("the API sources: the Comptroller's record, fetched live, values unchanged", () => {
  for (const topic of API_TOPICS) {
    const s = one(ask({ topic }), topic);
    assert.equal(s.as_of_status, "live", topic);
    assert.equal(s.figures_official, true, `${topic}: XML to JSON and a set list of fields change no value`);
    assert.equal(s.source_url, "https://www.checkbooknyc.com/data-feeds/api", topic);
    assert.equal(s.report_errors.in_the_data, "https://groups.google.com/group/checkbooknyc", topic);
  }
});

test("a tool name as the topic gives the sources behind that tool", () => {
  const r = ask({ topic: "get_agency_spending" });
  assert.deepEqual(r.structuredContent.sources.map((s) => s.topic), ["spending"]);
  const payroll = one(ask({ topic: "PAYROLL" }), "payroll");
  assert.ok(payroll.coverage.known_gaps.some((g) => /No employee names/.test(g)));
});

test("smart search off (the default): its source is not available on this server", () => {
  const s = one(ask({ topic: "smart_search" }), "smart-search");
  assert.equal(s.as_of_status, "unavailable");
  assert.equal(s.as_of, `not available on this server: ${SMART_SEARCH_OFF_REASON}`);
  // the other sources are untouched
  assert.equal(one(ask({ topic: "spending" }), "spending").as_of_status, "live");
});

test("smart search on: its source is fetched when you ask", () => {
  const s = one(ask({ topic: "smart-search" }, true), "smart-search");
  assert.equal(s.as_of_status, "live");
});

test("a bad topic is an error that lists the topics; an unknown key is refused by name", () => {
  const bad = ask({ topic: "parking-tickets" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /spending/);
  const extra = ask({ verbose: true });
  assert.equal(extra.isError, true);
  assert.match(extra.content[0].text, /verbose/);
});

test("the server's instructions tell the AI app to call about_data", () => {
  assert.ok(SERVER_INSTRUCTIONS.includes(BETANYC_INSTRUCTIONS));
  assert.match(SERVER_INSTRUCTIONS, /Checkbook NYC/);
});
