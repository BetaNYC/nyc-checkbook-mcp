// Print the names of every tool the built server lists, as a JSON array, for
// `whats_changed.py about-data check --tools-file` (CI and the release workflow).
// Runs the real registration in memory: no network, no stdio. Needs `npm run build` first.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";

const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
registerTools(server);
const client = new Client({ name: "list-tools", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();
console.log(JSON.stringify(tools.map((t) => t.name)));
await client.close();
await server.close();
