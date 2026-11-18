// #59: text several tools share is said in full once, in the server instructions, not repeated
// in each tool description. The instructions keep the shared about_data paragraph. Since the
// review of epic #49, the tools that need a hint also carry a short one (some AI apps ignore
// server instructions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { SERVER_INSTRUCTIONS, CHECKBOOK_GUIDE } from "../dist/betanyc.js";
import { BETANYC_INSTRUCTIONS } from "../dist/betanyc-tools.js";

// Each shared explanation: a phrase from it, which must be in the instructions once and in
// no tool or parameter description.
const SHARED = {
  "vendor names": /held by resellers/g,
  "contract field names": /prime_contract_\* names/g,
  "agency code examples": /'\d{3}' for /g,
  "fiscal year": /July 1 to June 30/g,
};

test("#59 shared guidance is in the server instructions once, with the about_data paragraph", async () => {
  assert.ok(SERVER_INSTRUCTIONS.includes(BETANYC_INSTRUCTIONS));
  assert.ok(SERVER_INSTRUCTIONS.includes(CHECKBOOK_GUIDE));
  for (const [what, re] of Object.entries(SHARED)) {
    assert.ok((SERVER_INSTRUCTIONS.match(re) ?? []).length >= 1, `${what} is in the instructions`);
  }
  for (const what of ["vendor names", "contract field names", "fiscal year"]) {
    assert.equal((SERVER_INSTRUCTIONS.match(SHARED[what]) ?? []).length, 1, `${what} is said once`);
  }
});

async function listTools() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "instructions-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("#59 the long explanations are not repeated in the tools", async () => {
  const text = JSON.stringify(await listTools());
  for (const what of ["vendor names", "fiscal year"]) assert.doesNotMatch(text, SHARED[what], `${what} is repeated in a tool`);
});

// Some AI apps ignore server instructions, so the tools that need a hint carry a short one
// too (review of epic #49): agency code examples, where to look up a vendor's contracts, and
// the contract field names.
test("#49 each tool that needs a hint carries a short one of its own", async () => {
  const tools = await listTools();
  const param = (t, p) => t.inputSchema.properties?.[p]?.description ?? "";
  const withAgency = tools.filter((t) => t.inputSchema.properties?.agency_code);
  assert.ok(withAgency.length >= 6, "the tools that take agency_code");
  for (const t of withAgency) assert.match(param(t, "agency_code"), /e\.g\. '\d{3}' for /, `${t.name}: agency code example`);

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const contracts = byName.search_contracts;
  assert.match(contracts.description, /search_spending payee_name, then its contract_id/, "search_contracts: vendor names");
  assert.match(param(contracts, "vendor_name"), /search_spending payee_name/, "search_contracts.vendor_name");
  assert.match(param(byName.search_spending, "payee_name"), /contract_id/, "search_spending.payee_name");
  for (const name of ["search_nycedc_contracts", "search_nycha_contracts"]) {
    assert.match(param(byName[name], "vendor_name"), /reseller/, `${name}.vendor_name`);
  }
  for (const where of [param(contracts, "category"), byName.get_contract.description]) {
    assert.match(where, /prime_contract_\*.*plain names/, "contract field names");
  }
});
