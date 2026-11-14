/**
 * whats_changed and about_betanyc, the two tools BetaNYC is adding to each of its MCP servers
 * (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7).
 *
 * betanyc-tools.ts is a copy of the workspace's canonical file: never edit it here. It defines
 * both tools in plain JSON Schema. McpServer.registerTool takes zod schemas, so this file
 * registers the two tools through that documented API with zod input schemas equivalent to
 * the module's (same names, types, optional fields, pattern and limits; `tag` is any string,
 * because the module accepts it in any case), and the handlers return the module's answers
 * (text plus structuredContent) unchanged. test/betanyc-tools.test.mjs compares the
 * advertised schemas with the module's field by field, so a change on either side fails.
 *
 * No outputSchema is registered: registerTool would need the module's nested output schema
 * rewritten in zod, a second hand-kept copy of it. structuredContent is still returned, and
 * the tests validate it against the module's own outputSchema.
 *
 * WHATS-CHANGED.md ships in the npm package (package.json `files`), one level above dist/.
 * The tools read it locally and never touch the network.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ABOUT_BETANYC_TOOL,
  MAX_LIMIT,
  WHATS_CHANGED_TOOL,
  createBetanycTools,
} from "./betanyc-tools.js";
import { VERSION } from "./version.js";

export const betanyc = createBetanycTools({
  serverName: "nyc-checkbook-mcp",
  version: VERSION,
  repoUrl: "https://github.com/BetaNYC/nyc-checkbook-mcp",
  whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
});

/** The module's own JSON Schema property, for its description and pattern. */
function moduleProperty(name: string): { description: string; pattern?: string } {
  const props = WHATS_CHANGED_TOOL.inputSchema.properties as Record<string, { description: string; pattern?: string }>;
  return props[name];
}

// The messages are the module's own, so an argument error reads the same here as on the
// other BetaNYC servers that have these tools. zod checks the format; the module still checks that a date is real.
const SINCE_MESSAGE = "since must be a real date written YYYY-MM-DD, for example 2026-11-01.";
const LIMIT_MESSAGE = `limit must be a whole number from 1 to ${MAX_LIMIT}.`;

/** zod input schemas equivalent to the module's JSON input schemas (compared in the tests). */
export const BETANYC_INPUT_SCHEMAS = {
  whats_changed: z
    .object({
      since: z
        .string()
        .regex(new RegExp(moduleProperty("since").pattern ?? "^\\d{4}-\\d{2}-\\d{2}$"), SINCE_MESSAGE)
        .optional()
        .describe(moduleProperty("since").description),
      tag: z.string().optional().describe(moduleProperty("tag").description),
      limit: z
        .number({ invalid_type_error: LIMIT_MESSAGE })
        .int(LIMIT_MESSAGE)
        .min(1, LIMIT_MESSAGE)
        .max(MAX_LIMIT, LIMIT_MESSAGE)
        .optional()
        .describe(moduleProperty("limit").description),
    })
    .strict(),
  about_betanyc: z.object({}).strict(),
};

/** Register both tools on an McpServer, through registerTool. */
export function registerBetanycTools(server: McpServer): void {
  for (const def of [WHATS_CHANGED_TOOL, ABOUT_BETANYC_TOOL]) {
    const name = def.name as keyof typeof BETANYC_INPUT_SCHEMAS;
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: BETANYC_INPUT_SCHEMAS[name],
        annotations: def.annotations,
      },
      async (args: unknown) => betanyc.call(name, args) as CallToolResult
    );
  }
}
