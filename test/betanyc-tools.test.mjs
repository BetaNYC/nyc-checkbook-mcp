// whats_changed and about_betanyc, the two tools BetaNYC is adding to each of its MCP servers
// (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7). They read this repo's
// WHATS-CHANGED.md and never touch the network. This server uses McpServer, so src/betanyc.ts
// registers them with registerTool and zod input schemas equivalent to the module's JSON
// Schemas; the first test compares the two field by field so either side drifting fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { registerTools } from "../dist/tools.js";
import { betanyc } from "../dist/betanyc.js";
import { SHARED_MODULE_VERSION, BETANYC_TOOLS } from "../dist/betanyc-tools.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const whatsChanged = readFileSync(new URL("../WHATS-CHANGED.md", import.meta.url), "utf8");
const REPO = "https://github.com/BetaNYC/nyc-checkbook-mcp";
const SOURCE = `${REPO}/blob/HEAD/WHATS-CHANGED.md`;
// Dated entries only: the tool leaves out an "## Unreleased:" entry (the version waiting for its tag).
const entryCount = (whatsChanged.match(/^## [0-9]{4}-[0-9]{2}-[0-9]{2}: /gm) ?? []).length;
const unreleased = (whatsChanged.match(/^## Unreleased: /gm) ?? []).length;
const CHECKBOOK_TOOLS = 10; // registered by registerCheckbookTools, smart_search included

const textOf = (r) => r.content[0].text;

/** Validate structuredContent against the module's own outputSchema, with the SDK's validator. */
const ajv = new AjvJsonSchemaValidator();
function assertMatchesModuleOutputSchema(name, structured) {
  const def = BETANYC_TOOLS.find((t) => t.name === name);
  const result = ajv.getValidator(def.outputSchema)(structured);
  assert.equal(result.valid, true, `${name}: ${result.errorMessage}`);
}

/** A client connected in memory to a server with the real tools registered. */
async function connect() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: pkg.version });
  registerTools(server);
  const client = new Client({ name: "betanyc-tools-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("tools/list advertises the two shared tools with input schemas equal to the module's, field by field", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, CHECKBOOK_TOOLS + 2);
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, "tool names are unique");
    for (const def of BETANYC_TOOLS) {
      const t = tools.find((x) => x.name === def.name);
      assert.ok(t, def.name);
      assert.equal(t.title, def.title, `${def.name} title`);
      assert.equal(t.description, def.description, `${def.name} description`);
      assert.deepEqual(t.annotations, def.annotations, `${def.name} annotations`);
      const got = t.inputSchema;
      const want = def.inputSchema;
      assert.equal(got.type, want.type, `${def.name} type`);
      assert.equal(got.additionalProperties, want.additionalProperties, `${def.name} additionalProperties`);
      assert.deepEqual(got.required ?? [], want.required ?? [], `${def.name}: the same fields are required (none)`);
      assert.deepEqual(Object.keys(got.properties).sort(), Object.keys(want.properties).sort(), `${def.name} property names`);
      for (const [prop, w] of Object.entries(want.properties)) {
        // Every keyword the module declares (type, pattern, minimum, maximum, description),
        // and no extra keyword on our side that would narrow it (for example an enum on tag).
        assert.deepEqual(got.properties[prop], w, `${def.name}.${prop}`);
      }
      // Only $schema may be added by the SDK's zod-to-JSON-Schema conversion.
      const extra = Object.keys(got).filter((k) => !(k in want) && k !== "$schema");
      assert.deepEqual(extra, [], `${def.name}: no extra top-level keywords`);
    }
  } finally {
    await close();
  }
});

test("whats_changed answers from this repo's WHATS-CHANGED.md, with every entry valid", async () => {
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: "whats_changed", arguments: { limit: 50 } });
    assert.notEqual(r.isError, true, textOf(r));
    const s = r.structuredContent;
    assert.deepEqual(s.server, { name: "nyc-checkbook-mcp", version: pkg.version });
    assert.equal(s.source, SOURCE);
    assert.equal(s.history_begins, "2026-05-21");
    assert.equal(s.total_matching, entryCount);
    assert.equal(s.returned, entryCount);
    assertMatchesModuleOutputSchema("whats_changed", s);
    if (unreleased) assert.match(s.note, /not released yet/, "the note says an unreleased entry is left out");
    else assert.equal(s.note, null);
    assert.doesNotMatch(s.note ?? "", /error/, "no entry was left out for an error");
    for (const e of s.entries) {
      assert.ok(e.url.startsWith(`${SOURCE}#${e.date}-`), e.url);
      for (const l of e.links) assert.match(l.url, /^https:\/\//, `${e.title}: ${l.url}`);
    }
  } finally {
    await close();
  }
});

test("the version in package.json has its own MCP entry, dated or Unreleased (release protocol)", async () => {
  assert.ok(unreleased <= 1);
  assert.match(whatsChanged, new RegExp(`- \\*\\*MCP version:\\*\\* \\[nyc-checkbook-mcp ${pkg.version.replace(/\./g, "\\.")}\\]`));
  const r = betanyc.call("whats_changed", { tag: "mcp", limit: 50 });
  assert.equal(r.structuredContent.filters.tag, "MCP", "any case is accepted; answers use the canonical spelling");
  assert.equal(r.structuredContent.returned, entryCount, "every entry in this repo is an MCP entry");
});

test("whats_changed filters: Correction entries carry advice for people who used the old answers", () => {
  const r = betanyc.call("whats_changed", { tag: "Correction" });
  assert.ok(r.structuredContent.returned >= 3);
  for (const e of r.structuredContent.entries) {
    assert.ok(e.tags.includes("Correction"));
    assert.ok(e.if_you_used_the_old_numbers, e.title);
  }
  const since = betanyc.call("whats_changed", { since: "2026-10-01" });
  assert.ok(since.structuredContent.returned >= 1);
  for (const e of since.structuredContent.entries) assert.ok(e.date >= "2026-10-01", e.date);
});

test("whats_changed rejects bad arguments by name, through the server's tools/call", async () => {
  // zod (registerTool) rejects the format, the range and unknown keys, with the module's
  // wording where zod lets us set it; the module still checks that a date is a real day and
  // that a tag is one of the four.
  const { client, close } = await connect();
  try {
    for (const [args, re] of [
      [{ since: "last week" }, /since must be a real date/],
      [{ since: "2026-02-30" }, /since must be a real date/],
      [{ tag: "Parks" }, /tag must be one of/],
      [{ limit: 51 }, /limit must be a whole number from 1 to 50/],
      [{ limit: 2.5 }, /limit must be a whole number from 1 to 50/],
      [{ limit: "5" }, /limit must be a whole number from 1 to 50/],
      [{ vendor_name: "x" }, /vendor_name/],
    ]) {
      const r = await client.callTool({ name: "whats_changed", arguments: args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(textOf(r), re, JSON.stringify(args));
    }
    const lower = await client.callTool({ name: "whats_changed", arguments: { tag: "correction" } });
    assert.notEqual(lower.isError, true, "any case is accepted for tag");
    assert.equal(lower.structuredContent.filters.tag, "Correction");
  } finally {
    await close();
  }
});

test("about_betanyc names the server, its version, and where to report a bug or ask for a feature", async () => {
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: "about_betanyc", arguments: {} });
    assert.notEqual(r.isError, true, textOf(r));
    const s = r.structuredContent;
    assert.deepEqual(s.server, {
      name: "nyc-checkbook-mcp",
      version: pkg.version,
      repository: REPO,
      shared_module_version: SHARED_MODULE_VERSION,
    });
    assert.equal(s.built_by, "BetaNYC, a project of the Fund for the City of New York");
    assert.deepEqual(s.bugs_and_requests, { issues: `${REPO}/issues`, new_issue: `${REPO}/issues/new` });
    assert.equal(s.whats_changed, SOURCE);
    assertMatchesModuleOutputSchema("about_betanyc", s);
    const bad = await client.callTool({ name: "about_betanyc", arguments: { verbose: true } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /verbose/);
  } finally {
    await close();
  }
});

test("the Checkbook tools still go through McpServer: its zod validation and its unknown-tool error", async () => {
  // No network: smart_search is off by default and answers before any request, and the
  // zod check rejects the unknown key before the handler runs.
  const { client, close } = await connect();
  try {
    const off = await client.callTool({ name: "smart_search", arguments: { query: "x" } });
    assert.equal(off.isError, true);
    assert.match(textOf(off), /CHECKBOOK_ENABLE_SMART_SEARCH/);
    const strict = await client.callTool({ name: "search_budget", arguments: { fiscal_year: "2026", bogus: 1 } });
    assert.equal(strict.isError, true);
    assert.match(textOf(strict), /bogus/);
    // McpServer turns its own "not found" error into an isError result.
    const missing = await client.callTool({ name: "no_such_tool", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /no_such_tool not found/);
  } finally {
    await close();
  }
});

test("over stdio, the built server answers both tools with structuredContent", async () => {
  // No outputSchema is registered (src/betanyc.ts), so the client does not validate; the
  // answers are checked against the module's outputSchema here.
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore" });
  const client = new Client({ name: "betanyc-tools-test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, CHECKBOOK_TOOLS + 2);
    const wc = await client.callTool({ name: "whats_changed", arguments: { limit: 3 } });
    assert.equal(wc.structuredContent.returned, 3);
    assertMatchesModuleOutputSchema("whats_changed", wc.structuredContent);
    const about = await client.callTool({ name: "about_betanyc", arguments: {} });
    assert.equal(about.structuredContent.server.version, pkg.version);
    assertMatchesModuleOutputSchema("about_betanyc", about.structuredContent);
  } finally {
    await client.close();
  }
});

test("WHATS-CHANGED.md ships in the npm package", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes("WHATS-CHANGED.md"), files.join(", "));
  assert.ok(files.includes("dist/betanyc-tools.js"));
  assert.ok(files.includes("dist/betanyc.js"));
});
