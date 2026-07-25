#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

// Version comes from ./version.js (single source, read from package.json) so the
// McpServer version, the User-Agent, and package.json can never drift (issue #22).
const server = new McpServer({ name: "nyc-checkbook-mcp", version: VERSION });

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
