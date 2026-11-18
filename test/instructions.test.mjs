// #59: text several tools share is said once, in the server instructions, not repeated in
// each tool description. The instructions keep the shared about_data paragraph.
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

test("#59 no tool or parameter description repeats it", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "instructions-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const text = JSON.stringify((await client.listTools()).tools);
    for (const [what, re] of Object.entries(SHARED)) assert.doesNotMatch(text, re, `${what} is repeated in a tool`);
  } finally {
    await client.close();
    await server.close();
  }
});
