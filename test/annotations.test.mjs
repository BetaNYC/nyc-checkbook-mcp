// #50: every tool says it only reads (readOnlyHint) and whether it reaches outside
// (openWorldHint), so an AI app can tell the user without asking. Checked on the real
// tools/list a client sees, so a tool registered without annotations fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { assertEveryToolAnnotated, BETANYC_TOOL_NAMES } from "../dist/betanyc-tools.js";

async function listTools() {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "annotations-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("every tool is annotated read-only, with openWorldHint", async () => {
  const tools = await listTools();
  assertEveryToolAnnotated(tools);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
  // The check itself fails on a tool without annotations.
  assert.throws(() => assertEveryToolAnnotated([...tools, { name: "bare_tool" }]), /bare_tool/);
});

test("every Checkbook tool calls the live API (openWorldHint true) and has a title", async () => {
  for (const t of (await listTools()).filter((t) => !BETANYC_TOOL_NAMES.includes(t.name))) {
    assert.equal(t.annotations.openWorldHint, true, t.name);
    assert.ok(t.annotations.title, t.name);
  }
});
