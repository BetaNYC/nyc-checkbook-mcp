// #56: the tool list and the server instructions are sent to the model on every turn, so
// their size is a cost. Same measure as nyc-311-mcp's test/tool-size.test.mjs
// (toolListSize: JSON of tools/list plus the instructions), on the tools/list a client sees.
//
// Measured 2026-11-18 at 23,122 characters (13 tools, shared module 1.5.0, annotations on
// every tool); the budget is that plus about 4%. If a change needs more, raise it on purpose
// with a dated line here saying why, and put text several tools share in the server
// instructions rather than in each description.
// 2026-11-18, #59: shared text moved from the descriptions into the instructions, which also
// gained the fiscal-year rule and checked agency-code examples; 23,532 characters, budget kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { SERVER_INSTRUCTIONS } from "../dist/betanyc.js";
import { toolListSize } from "../dist/betanyc-tools.js";

const BUDGET_CHARS = 24_000;

test("tools/list plus server instructions stay within the size budget", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "tool-size-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    const size = toolListSize(tools, SERVER_INSTRUCTIONS);
    assert.ok(size <= BUDGET_CHARS, `tools/list JSON + instructions is ${size} characters, over the ${BUDGET_CHARS} budget`);
  } finally {
    await client.close();
    await server.close();
  }
});
