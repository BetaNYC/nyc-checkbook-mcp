/**
 * Tool registration for the NYC Checkbook MCP server.
 *
 * Zod schemas here are the single source of truth for each tool's input
 * schema — the SDK's McpServer converts them to JSON Schema for tools/list.
 *
 * The domain contracts (criteria names, response columns, required-field
 * rules, and the smart_search availability handling) match the live
 * CheckbookNYC API as verified in PR #4 (2026-07-06): the Budget year
 * criterion is "year" (not "fiscal_year"); payroll exposes no employee-name
 * fields; smart_search returns a structured unavailability result when the
 * WAF/JS-rendered web endpoint is unusable server-side.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  callCheckbookApi,
  smartSearch,
  DEFAULT_COLUMNS,
  type Criteria,
  type DataDomain,
} from "./checkbook.js";

// ─── Disclaimer ──────────────────────────────────────────────────────────────

const DISCLAIMER =
  "\n\n---\n⚠️ Data disclaimer: Results are sourced from Checkbook NYC, " +
  "published by the NYC Office of the Comptroller. Accuracy depends on data " +
  "submitted by City agencies to the Comptroller's office. Records may be " +
  "incomplete, delayed, or reflect amendments. Verify critical figures " +
  "directly at checkbooknyc.com or via FOIL request to the relevant agency.";

function withDisclaimer(json: unknown): string {
  return JSON.stringify(json, null, 2) + DISCLAIMER;
}

function textResult(json: unknown): CallToolResult {
  return { content: [{ type: "text", text: withDisclaimer(json) }] };
}

function errorResult(json: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    isError: true,
  };
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

// ─── Criteria construction ───────────────────────────────────────────────────

/** Map of input field name → API criteria name, applied for truthy values. */
export function valueCriteria(
  input: Record<string, unknown>,
  map: Record<string, string>
): Criteria[] {
  const out: Criteria[] = [];
  for (const [key, name] of Object.entries(map)) {
    const v = input[key];
    if (v !== undefined && v !== "") {
      out.push({ name, type: "value", value: String(v) });
    }
  }
  return out;
}

/** Build a range criterion if either bound is provided; missing bounds get defaults. */
export function rangeCriterion(
  name: string,
  start: string | number | undefined,
  end: string | number | undefined,
  defaultStart: string,
  defaultEnd: string
): Criteria | undefined {
  const s = start === undefined || start === "" ? undefined : String(start);
  const e = end === undefined || end === "" ? undefined : String(end);
  if (s === undefined && e === undefined) return undefined;
  return { name, type: "range", start: s ?? defaultStart, end: e ?? defaultEnd };
}

// ─── Shared search runner ────────────────────────────────────────────────────

export async function runSearch(
  domain: DataDomain,
  columns: string[],
  criteria: Criteria[],
  page: number,
  page_size: number,
  extra?: Record<string, unknown>
): Promise<CallToolResult> {
  const pageSize = Math.min(page_size, 1000);
  const result = await callCheckbookApi({
    type_of_data: domain,
    records_from: (page - 1) * pageSize + 1,
    max_records: pageSize,
    criteria,
    response_columns: columns,
  });

  return textResult({
    ...extra,
    total_records: result.total_records,
    page,
    page_size: pageSize,
    has_more: result.total_records > page * pageSize,
    records: result.records,
    error: result.error,
  });
}

// ─── Shared schema fragments ─────────────────────────────────────────────────

const pageSchema = z.number().optional().default(1).describe("Page number (default: 1)");
const pageSizeSchema = z
  .number()
  .optional()
  .default(50)
  .describe("Results per page (default: 50, max: 1000)");
const fiscalYearSchema = z.string().optional().describe("Fiscal year, e.g. '2024'");
const agencyCodeSchema = z.string().optional().describe("3-digit agency code");

// ─── Contracts criteria (exported for tests) ─────────────────────────────────

const CONTRACT_VALUE_FIELDS: Record<string, string> = {
  fiscal_year: "fiscal_year",
  agency_code: "agency_code",
  vendor_name: "prime_vendor",
  vendor_code: "vendor_code",
  contract_id: "contract_id",
  award_method: "award_method",
  mwbe_category: "mwbe_category",
  industry: "industry",
  contract_type: "contract_type",
};

export interface ContractsSearchInput {
  status: "registered" | "pending";
  category: "expense" | "revenue" | "all";
  fiscal_year?: string;
  agency_code?: string;
  vendor_name?: string;
  vendor_code?: string;
  contract_id?: string;
  amount_min?: number;
  amount_max?: number;
  start_date_from?: string;
  start_date_to?: string;
  end_date_from?: string;
  end_date_to?: string;
  award_method?: string;
  mwbe_category?: string;
  industry?: string;
  contract_type?: string;
}

export function contractsCriteria(input: ContractsSearchInput): Criteria[] {
  const criteria: Criteria[] = [
    { name: "status", type: "value", value: input.status },
    { name: "category", type: "value", value: input.category },
    ...valueCriteria(input as unknown as Record<string, unknown>, CONTRACT_VALUE_FIELDS),
  ];
  for (const range of [
    rangeCriterion("current_amount", input.amount_min, input.amount_max, "0", "99999999999"),
    rangeCriterion("start_date", input.start_date_from, input.start_date_to, "1990-01-01", "2099-12-31"),
    rangeCriterion("end_date", input.end_date_from, input.end_date_to, "1990-01-01", "2099-12-31"),
  ]) {
    if (range) criteria.push(range);
  }
  return criteria;
}

// ─── Tool registration ───────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  server.registerTool(
    "smart_search",
    {
      description:
        "Full-text search across all Checkbook NYC data — contracts, spending, payroll, budget, revenue. " +
        "CAVEAT: the underlying checkbooknyc.com web endpoint is protected by a WAF and renders results " +
        "client-side, so this tool is frequently unavailable server-side. When it is, it returns a " +
        "structured explanation and fallback guidance (use search_contracts/search_spending, or browse " +
        "checkbooknyc.com/smart_search in a browser). The structured search tools only match exact " +
        "vendor names and may miss contracts held by resellers.",
      inputSchema: {
        query: z
          .string()
          .describe("Search term — product name, vendor name, keyword, or phrase"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results to return (default 25, max 100)"),
      },
    },
    async ({ query, limit }) =>
      guard(async () => {
        const result = await smartSearch(query, limit ?? 25);
        if (!result.available) {
          return errorResult({
            query,
            available: false,
            reason: result.reason,
            fallback: result.fallback,
          });
        }
        return textResult({
          query,
          total_results: result.total,
          returned: result.results.length,
          results: result.results,
        });
      })
  );

  server.registerTool(
    "search_contracts",
    {
      description:
        "Search NYC registered and pending contracts with structured filters. " +
        "Filter by vendor name, agency, contract ID, date range, amount range, industry, MWBE category, and more. " +
        "NOTE: vendor name must match the prime vendor (reseller), not the software maker. " +
        "Use smart_search to find contracts by product or software name.",
      inputSchema: {
        status: z
          .enum(["registered", "pending"])
          .optional()
          .default("registered")
          .describe("Contract status (default: registered)"),
        category: z
          .enum(["expense", "revenue", "all"])
          .optional()
          .default("expense")
          .describe("Contract category (default: expense)"),
        fiscal_year: fiscalYearSchema,
        agency_code: z
          .string()
          .optional()
          .describe("3-digit agency code, e.g. '858' for OTI/DoITT, '002' for DoF"),
        vendor_name: z
          .string()
          .optional()
          .describe("Prime vendor name — first 3 characters are used for matching"),
        vendor_code: z.string().optional().describe("Vendor identification code"),
        contract_id: z
          .string()
          .optional()
          .describe("Contract number, e.g. 'CT185820201424467'"),
        amount_min: z.number().optional().describe("Minimum current contract amount"),
        amount_max: z.number().optional().describe("Maximum current contract amount"),
        start_date_from: z
          .string()
          .optional()
          .describe("Contract start date range begin (YYYY-MM-DD)"),
        start_date_to: z
          .string()
          .optional()
          .describe("Contract start date range end (YYYY-MM-DD)"),
        end_date_from: z
          .string()
          .optional()
          .describe("Contract end date range begin (YYYY-MM-DD)"),
        end_date_to: z
          .string()
          .optional()
          .describe("Contract end date range end (YYYY-MM-DD)"),
        award_method: z.string().optional().describe("Award method code"),
        mwbe_category: z.string().optional().describe("M/WBE category code"),
        industry: z.string().optional().describe("Industry code"),
        contract_type: z.string().optional().describe("Contract type code"),
        page: z.number().optional().default(1).describe("Page number for pagination (default: 1)"),
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() =>
        runSearch(
          "Contracts",
          DEFAULT_COLUMNS[input.status === "pending" ? "Contracts_pending" : "Contracts"],
          contractsCriteria(input),
          input.page,
          input.page_size
        )
      )
  );

  server.registerTool(
    "get_contract",
    {
      description:
        "Look up a single NYC contract by its contract ID. Returns full contract details. " +
        "Use this after finding a contract ID via smart_search or search_contracts.",
      inputSchema: {
        contract_id: z
          .string()
          .describe("Contract ID, e.g. 'CT185820201424467' or 'DO185820252009241'"),
        status: z
          .enum(["registered", "pending"])
          .optional()
          .default("registered")
          .describe("Contract status (default: registered)"),
        category: z
          .enum(["expense", "revenue"])
          .optional()
          .default("expense")
          .describe("Contract category (default: expense)"),
      },
    },
    async ({ contract_id, status, category }) =>
      guard(async () => {
        const result = await callCheckbookApi({
          type_of_data: "Contracts",
          records_from: 1,
          max_records: 10,
          criteria: [
            { name: "status", type: "value", value: status },
            { name: "category", type: "value", value: category },
            { name: "contract_id", type: "value", value: contract_id },
          ],
          response_columns: DEFAULT_COLUMNS["Contracts"],
        });
        return textResult({ contract_id, records: result.records, error: result.error });
      })
  );

  server.registerTool(
    "search_spending",
    {
      description:
        "Search NYC spending (check) records. Filter by agency, payee, contract, date range, amount, or expense category. " +
        "Either fiscal_year or issue_date_from is required.",
      inputSchema: {
        fiscal_year: fiscalYearSchema,
        agency_code: agencyCodeSchema,
        payee_name: z.string().optional().describe("Payee (vendor) name"),
        contract_id: z.string().optional().describe("Filter spending by contract ID"),
        issue_date_from: z
          .string()
          .optional()
          .describe("Check issue date range start (YYYY-MM-DD)"),
        issue_date_to: z
          .string()
          .optional()
          .describe("Check issue date range end (YYYY-MM-DD)"),
        amount_min: z.number().optional().describe("Minimum check amount"),
        amount_max: z.number().optional().describe("Maximum check amount"),
        expense_category: z.string().optional().describe("Expense category code"),
        spending_category: z.string().optional().describe("'c' for capital, 'e' for expense"),
        mwbe_category: z.string().optional().describe("M/WBE category code"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() => {
        if (!input.fiscal_year && !input.issue_date_from) {
          throw new Error("Either fiscal_year or issue_date_from is required.");
        }
        const criteria = valueCriteria(input, {
          fiscal_year: "fiscal_year",
          agency_code: "agency_code",
          payee_name: "payee_name",
          contract_id: "contract_id",
          expense_category: "expense_category",
          spending_category: "spending_category",
          mwbe_category: "mwbe_category",
        });
        for (const range of [
          rangeCriterion("issue_date", input.issue_date_from, input.issue_date_to, "1990-01-01", "2099-12-31"),
          rangeCriterion("check_amount", input.amount_min, input.amount_max, "0", "99999999999"),
        ]) {
          if (range) criteria.push(range);
        }
        return runSearch("Spending", DEFAULT_COLUMNS["Spending"], criteria, input.page, input.page_size);
      })
  );

  server.registerTool(
    "search_budget",
    {
      description: "Search NYC budget data by agency, department, fiscal year, or budget code.",
      inputSchema: {
        fiscal_year: fiscalYearSchema,
        agency_code: agencyCodeSchema,
        department_code: z.string().optional().describe("Department code"),
        budget_code: z.string().optional().describe("Budget code"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() =>
        runSearch(
          "Budget",
          DEFAULT_COLUMNS["Budget"],
          // The Budget domain's year criterion is named "year", not "fiscal_year".
          valueCriteria(input, {
            fiscal_year: "year",
            agency_code: "agency_code",
            department_code: "department_code",
            budget_code: "budget_code",
          }),
          input.page,
          input.page_size
        )
      )
  );

  server.registerTool(
    "search_payroll",
    {
      description:
        "Search NYC payroll records by agency, job title, pay frequency, pay date, or amount range. " +
        "Requires fiscal_year or calendar_year. " +
        "NOTE: the Checkbook NYC API does not expose employee names — payroll data is aggregated by " +
        "agency/title/pay date. There is no employee-name search.",
      inputSchema: {
        fiscal_year: z
          .string()
          .optional()
          .describe("Fiscal year, e.g. '2026'. Either fiscal_year or calendar_year is required."),
        calendar_year: z
          .string()
          .optional()
          .describe("Calendar year, e.g. '2025'. Either fiscal_year or calendar_year is required."),
        agency_code: z
          .string()
          .optional()
          .describe("3-digit agency code, e.g. '846' for Parks"),
        title: z.string().optional().describe("Job title (partial match)"),
        pay_frequency: z
          .string()
          .optional()
          .describe("Pay frequency, e.g. 'BI-WEEKLY', 'SUPPLEMENTAL'"),
        pay_date_from: z.string().optional().describe("Pay date range start (YYYY-MM-DD)"),
        pay_date_to: z.string().optional().describe("Pay date range end (YYYY-MM-DD)"),
        amount_min: z.number().optional().describe("Minimum payment amount"),
        amount_max: z.number().optional().describe("Maximum payment amount"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() => {
        if (!input.fiscal_year && !input.calendar_year) {
          throw new Error("Either fiscal_year or calendar_year is required.");
        }
        const criteria = valueCriteria(input, {
          fiscal_year: "fiscal_year",
          calendar_year: "calendar_year",
          agency_code: "agency_code",
          title: "title",
          pay_frequency: "pay_frequency",
        });
        const payDate = rangeCriterion("pay_date", input.pay_date_from, input.pay_date_to, "1990-01-01", "2099-12-31");
        if (payDate) criteria.push(payDate);
        const amount = rangeCriterion("amount", input.amount_min, input.amount_max, "0", "99999999");
        if (amount) criteria.push(amount);
        return runSearch("Payroll", DEFAULT_COLUMNS["Payroll"], criteria, input.page, input.page_size);
      })
  );

  server.registerTool(
    "search_revenue",
    {
      description:
        "Search NYC revenue data by agency, revenue category/class/source, fund class, or fiscal year.",
      inputSchema: {
        fiscal_year: z.string().optional().describe("Fiscal year, e.g. '2026'"),
        budget_fiscal_year: z.string().optional().describe("Budget fiscal year, e.g. '2026'"),
        agency_code: agencyCodeSchema,
        revenue_category: z
          .string()
          .optional()
          .describe("2-character revenue category code (not the category name)"),
        revenue_class: z.string().optional().describe("Revenue class code"),
        revenue_source: z.string().optional().describe("Revenue source code"),
        fund_class: z.string().optional().describe("Fund class code"),
        funding_class: z.string().optional().describe("Funding class code"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() =>
        runSearch(
          "Revenue",
          DEFAULT_COLUMNS["Revenue"],
          valueCriteria(input, {
            fiscal_year: "fiscal_year",
            budget_fiscal_year: "budget_fiscal_year",
            agency_code: "agency_code",
            revenue_category: "revenue_category",
            revenue_class: "revenue_class",
            revenue_source: "revenue_source",
            fund_class: "fund_class",
            funding_class: "funding_class",
          }),
          input.page,
          input.page_size
        )
      )
  );

  server.registerTool(
    "get_agency_spending",
    {
      description:
        "Get all spending for a specific NYC agency in a fiscal year. " +
        "A convenience wrapper around search_spending for agency-level financial overview.",
      inputSchema: {
        agency_code: z
          .string()
          .describe("3-digit agency code, e.g. '858' for OTI/DoITT, '040' for NYPD"),
        fiscal_year: z.string().describe("Fiscal year, e.g. '2024'"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async ({ agency_code, fiscal_year, page, page_size }) =>
      guard(() =>
        runSearch(
          "Spending",
          DEFAULT_COLUMNS["Spending"],
          [
            { name: "agency_code", type: "value", value: agency_code },
            { name: "fiscal_year", type: "value", value: fiscal_year },
          ],
          page,
          page_size,
          { agency_code, fiscal_year }
        )
      )
  );
}
