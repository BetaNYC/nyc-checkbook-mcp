/**
 * whats_changed, about_betanyc and about_data, the three tools BetaNYC adds to each of its MCP
 * servers (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7 and
 * platform/system/about-data-standard.md § 3).
 *
 * betanyc-tools.ts is a copy of the workspace's canonical file: never edit it here. It defines
 * the tools in plain JSON Schema. McpServer.registerTool takes zod schemas, so this file
 * registers them through that documented API with zod input schemas equivalent to the
 * module's (same names, types, optional fields, pattern and limits; `tag` is any string,
 * because the module accepts it in any case; `topic` is any string, because the module checks
 * it against this server's topics), and the handlers return the module's answers (text plus
 * structuredContent) unchanged. test/betanyc-tools.test.mjs compares the advertised schemas
 * with the module's field by field, so a change on either side fails.
 *
 * No outputSchema is registered: registerTool would need the module's nested output schemas
 * rewritten in zod, a second hand-kept copy of them. structuredContent is still returned, and
 * the tests validate it against the module's own outputSchema.
 *
 * WHATS-CHANGED.md, DATA-SOURCES.json and data.json ship in the npm package (package.json
 * `files`), one level above dist/. The tools read them locally and never touch the network.
 * Every Checkbook source is fetched live, so no freshness hook is needed. smart_search is off
 * unless CHECKBOOK_ENABLE_SMART_SEARCH is set (#25); when it is off, about_data says its
 * source is not available on this server instead of "fetched when you ask" (added in module 1.3.6,
 * unavailableSources).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ABOUT_BETANYC_TOOL,
  ABOUT_DATA_TOOL,
  BETANYC_INSTRUCTIONS,
  MAX_LIMIT,
  WHATS_CHANGED_TOOL,
  createBetanycTools,
} from "./betanyc-tools.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "nyc-checkbook-mcp";
export const REPO_URL = "https://github.com/BetaNYC/nyc-checkbook-mcp";

/** The DATA-SOURCES.json source behind smart_search, and why it is unavailable when off. */
export const SMART_SEARCH_SOURCE = "smart-search";
export const SMART_SEARCH_OFF_REASON = "smart search is off (CHECKBOOK_ENABLE_SMART_SEARCH is not set)";

/** The server's MCP instructions: what it covers, then the shared module's own instructions
 * (call about_data, about_betanyc and whats_changed). */
export const SERVER_INSTRUCTIONS =
  "NYC spending, contracts, budget, payroll and revenue from Checkbook NYC, the NYC Comptroller's " +
  "financial transparency site, by BetaNYC. " +
  BETANYC_INSTRUCTIONS;

/** The shared tools for one server. Throws at startup if DATA-SOURCES.json does not describe
 * this server. `smartSearch` is whether smart_search is turned on (smartSearchEnabled()). */
export function betanycTools(opts: { smartSearch: boolean }) {
  return createBetanycTools({
    serverName: SERVER_NAME,
    version: VERSION,
    repoUrl: REPO_URL,
    whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
    dataSourcesPath: new URL("../DATA-SOURCES.json", import.meta.url),
    ...(opts.smartSearch ? {} : { unavailableSources: { [SMART_SEARCH_SOURCE]: SMART_SEARCH_OFF_REASON } }),
  });
}

/** The shared tools as a server with the default settings has them (smart search off). */
export const betanyc = betanycTools({ smartSearch: false });

/** The module's own JSON Schema property, for its description and pattern. */
function moduleProperty(name: string): { description: string; pattern?: string } {
  const props = WHATS_CHANGED_TOOL.inputSchema.properties as Record<string, { description: string; pattern?: string }>;
  return props[name];
}

const topicProperty = (ABOUT_DATA_TOOL.inputSchema.properties as Record<string, { description: string }>).topic;

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
  // Any string: the module checks the topic against this server's topics, in any case, and
  // refuses a long one without echoing it.
  about_data: z.object({ topic: z.string().optional().describe(topicProperty.description) }).strict(),
};

/** Register the three tools on an McpServer, through registerTool. The titles, descriptions
 * (about_data's lists this server's topics) and annotations are the module's own. */
export function registerBetanycTools(server: McpServer, opts: { smartSearch: boolean }): void {
  const shared = betanycTools(opts);
  for (const def of shared.tools) {
    const name = def.name as keyof typeof BETANYC_INPUT_SCHEMAS;
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: BETANYC_INPUT_SCHEMAS[name],
        annotations: def.annotations,
      },
      async (args: unknown) => shared.call(name, args) as CallToolResult
    );
  }
}
