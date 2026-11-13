/**
 * whats_changed and about_betanyc, the two tools every BetaNYC MCP server carries
 * (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7).
 *
 * betanyc-tools.ts is a copy of the workspace's canonical file: never edit it here. It defines
 * both tools with plain JSON Schema (inputSchema and outputSchema) and validates its own
 * arguments, so every BetaNYC server advertises exactly the same tools. McpServer.registerTool
 * only takes zod schemas (SDK 1.29.0, server/mcp.js `getZodSchemaObject`), so the two tools are
 * not registered through it. Instead, `withBetanycTools` lets McpServer install its own
 * tools/list and tools/call handlers as usual, records them, and replaces them with handlers
 * that answer the two shared tools and pass every other request to McpServer's.
 *
 * WHATS-CHANGED.md ships in the npm package (package.json `files`), one level above dist/.
 * The tools read it locally and never touch the network.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createBetanycTools } from "./betanyc-tools.js";
import { VERSION } from "./version.js";

export const betanyc = createBetanycTools({
  serverName: "nyc-checkbook-mcp",
  version: VERSION,
  repoUrl: "https://github.com/BetaNYC/nyc-checkbook-mcp",
  whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestHandler = (request: any, extra: any) => unknown;

/**
 * Run `registerOwnTools` (this server's McpServer.registerTool calls), then add the two
 * shared tools. Throws at startup if McpServer did not install its tool handlers through
 * `server.server.setRequestHandler`, so an SDK change shows when the server starts.
 */
export function withBetanycTools(server: McpServer, registerOwnTools: (server: McpServer) => void): void {
  const lowLevel = server.server;
  const captured = new Map<unknown, RequestHandler>();
  const original = lowLevel.setRequestHandler;
  // An own property shadows the prototype method only while this server's tools register.
  lowLevel.setRequestHandler = ((schema: unknown, handler: RequestHandler) => {
    captured.set(schema, handler);
    return original.call(lowLevel, schema as never, handler as never);
  }) as typeof original;
  try {
    registerOwnTools(server);
  } finally {
    delete (lowLevel as { setRequestHandler?: unknown }).setRequestHandler;
  }

  const listOwn = captured.get(ListToolsRequestSchema);
  const callOwn = captured.get(CallToolRequestSchema);
  if (!listOwn || !callOwn) {
    throw new Error(
      "withBetanycTools: McpServer did not install its tools/list and tools/call handlers " +
        "through setRequestHandler while the tools registered. The MCP SDK may have changed; " +
        "see src/betanyc.ts."
    );
  }

  lowLevel.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const own = (await listOwn(request, extra)) as ListToolsResult;
    const clash = own.tools.find((t) => betanyc.handles(t.name));
    if (clash) throw new Error(`withBetanycTools: this server already has a tool named ${clash.name}`);
    return { ...own, tools: [...own.tools, ...(betanyc.tools as unknown as Tool[])] };
  });

  lowLevel.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    if (betanyc.handles(name)) return betanyc.call(name, args) as CallToolResult;
    return (await callOwn(request, extra)) as CallToolResult;
  });
}
