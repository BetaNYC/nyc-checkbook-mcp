// #37: the README table and the agency_code examples in tool descriptions named the
// wrong agencies (040 is Education, not NYPD). Every code they name must be one
// Checkbook NYC itself returned for it: one search_budget call per code, 2026-10-12
// and 13, recorded in issue #37. A code not in this list must be checked the same way
// before it is added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { SERVER_INSTRUCTIONS } from "../dist/betanyc.js";

const CHECKED = {
  "002": /Mayoralty/,
  "040": /Education/,
  "056": /Police|NYPD/,
  "057": /Fire|FDNY/,
  "071": /Homeless/,
  "072": /Correction/,
  "127": /Financial Information Services/,
  "801": /Small Business/,
  "826": /Environmental Protection|DEP/,
  "836": /Finance/, // Checkbook NYC's agency list only (2026-11-18, commit 20cc263), no search_budget call
  "841": /Transportation|DOT/,
  "846": /Parks/,
  "856": /Citywide Administrative|DCAS/,
  "858": /OTI|DoITT|Technology and Innovation/,
};

function assertChecked(code, name, where) {
  assert.ok(Object.hasOwn(CHECKED, code), `${where}: code ${code} was never checked against Checkbook NYC`);
  assert.match(name, CHECKED[code], `${where}: code ${code} is not "${name}"`);
}

test("#37 the README's agency table names only checked codes, each with its own agency", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("## Common agency codes")[1].split("\n## ")[0];
  const rows = [...section.matchAll(/^\| `(\d{3})` \| (.+) \|$/gm)];
  assert.ok(rows.length >= 10);
  for (const [, code, name] of rows) assertChecked(code, name, "README table");
  for (const [, code, name] of readme.matchAll(/get_agency_spending\("(\d{3})", "\d{4}"\)\s+\/\/ (.+)/g)) {
    assertChecked(code, name, "README example");
  }
});

test("#37 every agency code example in the tool descriptions and the server instructions is a checked code", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const text = JSON.stringify((await client.listTools()).tools) + SERVER_INSTRUCTIONS;
    const examples = [...text.matchAll(/'(\d{3})' for ([A-Za-z/]+)/g)];
    assert.ok(examples.length > 0);
    for (const [, code, name] of examples) assertChecked(code, name, "tool description");
  } finally {
    await client.close();
    await server.close();
  }
});
