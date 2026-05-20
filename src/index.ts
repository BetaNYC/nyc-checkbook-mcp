#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  callCheckbookApi,
  smartSearch,
  DEFAULT_COLUMNS,
  type Criteria,
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

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "nyc-checkbook-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "smart_search",
      description:
        "Full-text search across all Checkbook NYC data — contracts, spending, payroll, budget, revenue. " +
        "Searches the Purpose field and all other text fields. " +
        "IMPORTANT: Use this tool when searching by product name, software name, or keyword (e.g. 'ArchiveSocial', 'Salesforce'). " +
        "The structured search tools only match exact vendor names and may miss contracts held by resellers.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term — product name, vendor name, keyword, or phrase",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 25, max 100)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "search_contracts",
      description:
        "Search NYC registered and pending contracts with structured filters. " +
        "Filter by vendor name, agency, contract ID, date range, amount range, industry, MWBE category, and more. " +
        "NOTE: vendor name must match the prime vendor (reseller), not the software maker. " +
        "Use smart_search to find contracts by product or software name.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["registered", "pending"],
            description: "Contract status (default: registered)",
          },
          category: {
            type: "string",
            enum: ["expense", "revenue", "all"],
            description: "Contract category (default: expense)",
          },
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2024'",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code, e.g. '858' for OTI/DoITT, '002' for DoF",
          },
          vendor_name: {
            type: "string",
            description: "Prime vendor name — first 3 characters are used for matching",
          },
          vendor_code: {
            type: "string",
            description: "Vendor identification code",
          },
          contract_id: {
            type: "string",
            description: "Contract number, e.g. 'CT185820201424467'",
          },
          amount_min: {
            type: "number",
            description: "Minimum current contract amount",
          },
          amount_max: {
            type: "number",
            description: "Maximum current contract amount",
          },
          start_date_from: {
            type: "string",
            description: "Contract start date range begin (YYYY-MM-DD)",
          },
          start_date_to: {
            type: "string",
            description: "Contract start date range end (YYYY-MM-DD)",
          },
          end_date_from: {
            type: "string",
            description: "Contract end date range begin (YYYY-MM-DD)",
          },
          end_date_to: {
            type: "string",
            description: "Contract end date range end (YYYY-MM-DD)",
          },
          award_method: {
            type: "string",
            description: "Award method code",
          },
          mwbe_category: {
            type: "string",
            description: "M/WBE category code",
          },
          industry: {
            type: "string",
            description: "Industry code",
          },
          contract_type: {
            type: "string",
            description: "Contract type code",
          },
          page: {
            type: "number",
            description: "Page number for pagination (default: 1)",
          },
          page_size: {
            type: "number",
            description: "Results per page (default: 50, max: 1000)",
          },
        },
        required: [],
      },
    },
    {
      name: "get_contract",
      description:
        "Look up a single NYC contract by its contract ID. Returns full contract details. " +
        "Use this after finding a contract ID via smart_search or search_contracts.",
      inputSchema: {
        type: "object",
        properties: {
          contract_id: {
            type: "string",
            description: "Contract ID, e.g. 'CT185820201424467' or 'DO185820252009241'",
          },
          status: {
            type: "string",
            enum: ["registered", "pending"],
            description: "Contract status (default: registered)",
          },
        },
        required: ["contract_id"],
      },
    },
    {
      name: "search_spending",
      description:
        "Search NYC spending (check) records. Filter by agency, payee, contract, date range, amount, or expense category. " +
        "Either fiscal_year or issue_date_from is required.",
      inputSchema: {
        type: "object",
        properties: {
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2024'",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code",
          },
          payee_name: {
            type: "string",
            description: "Payee (vendor) name",
          },
          contract_id: {
            type: "string",
            description: "Filter spending by contract ID",
          },
          issue_date_from: {
            type: "string",
            description: "Check issue date range start (YYYY-MM-DD)",
          },
          issue_date_to: {
            type: "string",
            description: "Check issue date range end (YYYY-MM-DD)",
          },
          amount_min: {
            type: "number",
            description: "Minimum check amount",
          },
          amount_max: {
            type: "number",
            description: "Maximum check amount",
          },
          expense_category: {
            type: "string",
            description: "Expense category code",
          },
          spending_category: {
            type: "string",
            description: "'c' for capital, 'e' for expense",
          },
          mwbe_category: {
            type: "string",
            description: "M/WBE category code",
          },
          page: {
            type: "number",
            description: "Page number (default: 1)",
          },
          page_size: {
            type: "number",
            description: "Results per page (default: 50, max: 1000)",
          },
        },
        required: [],
      },
    },
    {
      name: "search_budget",
      description:
        "Search NYC budget data by agency, department, fiscal year, or budget code.",
      inputSchema: {
        type: "object",
        properties: {
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2024'",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code",
          },
          department_code: {
            type: "string",
            description: "Department code",
          },
          budget_code: {
            type: "string",
            description: "Budget code",
          },
          page: {
            type: "number",
            description: "Page number (default: 1)",
          },
          page_size: {
            type: "number",
            description: "Results per page (default: 50, max: 1000)",
          },
        },
        required: [],
      },
    },
    {
      name: "search_payroll",
      description:
        "Search NYC payroll records by agency, employee name, title, or salary range.",
      inputSchema: {
        type: "object",
        properties: {
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2024'",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code",
          },
          last_name: {
            type: "string",
            description: "Employee last name",
          },
          title: {
            type: "string",
            description: "Job title",
          },
          salary_min: {
            type: "number",
            description: "Minimum base salary",
          },
          salary_max: {
            type: "number",
            description: "Maximum base salary",
          },
          page: {
            type: "number",
            description: "Page number (default: 1)",
          },
          page_size: {
            type: "number",
            description: "Results per page (default: 50, max: 1000)",
          },
        },
        required: [],
      },
    },
    {
      name: "search_revenue",
      description:
        "Search NYC revenue data by agency, revenue category, or fiscal year.",
      inputSchema: {
        type: "object",
        properties: {
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2024'",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code",
          },
          budget_code: {
            type: "string",
            description: "Budget code",
          },
          page: {
            type: "number",
            description: "Page number (default: 1)",
          },
          page_size: {
            type: "number",
            description: "Results per page (default: 50, max: 1000)",
          },
        },
        required: [],
      },
    },
    {
      name: "get_agency_spending",
      description:
        "Get all spending for a specific NYC agency in a fiscal year. " +
        "A convenience wrapper around search_spending for agency-level financial overview.",
      inputSchema: {
        type: "object",
        properties: {
          agency_code: {
            type: "string",
            description: "3-digit agency code, e.g. '858' for OTI/DoITT, '040' for NYPD",
          },
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2024'",
          },
          page: {
            type: "number",
            description: "Page number (default: 1)",
          },
          page_size: {
            type: "number",
            description: "Results per page (default: 50, max: 1000)",
          },
        },
        required: ["agency_code", "fiscal_year"],
      },
    },
  ],
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── smart_search ──────────────────────────────────────────────────────
      case "smart_search": {
        const { query, limit = 25 } = z
          .object({ query: z.string(), limit: z.number().optional() })
          .parse(args);

        const result = await smartSearch(query, limit);

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  query,
                  total_results: result.total,
                  returned: result.results.length,
                  results: result.results,
                }
              ),
            },
          ],
        };
      }

      // ── search_contracts ──────────────────────────────────────────────────
      case "search_contracts": {
        const input = z
          .object({
            status: z.enum(["registered", "pending"]).optional().default("registered"),
            category: z.enum(["expense", "revenue", "all"]).optional().default("expense"),
            fiscal_year: z.string().optional(),
            agency_code: z.string().optional(),
            vendor_name: z.string().optional(),
            vendor_code: z.string().optional(),
            contract_id: z.string().optional(),
            amount_min: z.number().optional(),
            amount_max: z.number().optional(),
            start_date_from: z.string().optional(),
            start_date_to: z.string().optional(),
            end_date_from: z.string().optional(),
            end_date_to: z.string().optional(),
            award_method: z.string().optional(),
            mwbe_category: z.string().optional(),
            industry: z.string().optional(),
            contract_type: z.string().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const criteria: Criteria[] = [
          { name: "status", type: "value", value: input.status },
          { name: "category", type: "value", value: input.category },
        ];

        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.vendor_name)
          criteria.push({ name: "prime_vendor", type: "value", value: input.vendor_name });
        if (input.vendor_code)
          criteria.push({ name: "vendor_code", type: "value", value: input.vendor_code });
        if (input.contract_id)
          criteria.push({ name: "contract_id", type: "value", value: input.contract_id });
        if (input.award_method)
          criteria.push({ name: "award_method", type: "value", value: input.award_method });
        if (input.mwbe_category)
          criteria.push({ name: "mwbe_category", type: "value", value: input.mwbe_category });
        if (input.industry)
          criteria.push({ name: "industry", type: "value", value: input.industry });
        if (input.contract_type)
          criteria.push({ name: "contract_type", type: "value", value: input.contract_type });
        if (input.amount_min !== undefined || input.amount_max !== undefined) {
          criteria.push({
            name: "current_amount",
            type: "range",
            start: String(input.amount_min ?? 0),
            end: String(input.amount_max ?? 99999999999),
          });
        }
        if (input.start_date_from || input.start_date_to) {
          criteria.push({
            name: "start_date",
            type: "range",
            start: input.start_date_from ?? "1990-01-01",
            end: input.start_date_to ?? "2099-12-31",
          });
        }
        if (input.end_date_from || input.end_date_to) {
          criteria.push({
            name: "end_date",
            type: "range",
            start: input.end_date_from ?? "1990-01-01",
            end: input.end_date_to ?? "2099-12-31",
          });
        }

        const colKey =
          input.status === "pending" ? "Contracts_pending" : "Contracts";
        const columns = DEFAULT_COLUMNS[colKey] ?? DEFAULT_COLUMNS["Contracts"];

        const pageSize = Math.min(input.page_size, 1000);
        const result = await callCheckbookApi({
          type_of_data: "Contracts",
          records_from: (input.page - 1) * pageSize + 1,
          max_records: pageSize,
          criteria,
          response_columns: columns,
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  total_records: result.total_records,
                  page: input.page,
                  page_size: pageSize,
                  has_more: result.total_records > input.page * pageSize,
                  records: result.records,
                  error: result.error,
                }
              ),
            },
          ],
        };
      }

      // ── get_contract ──────────────────────────────────────────────────────
      case "get_contract": {
        const { contract_id, status = "registered" } = z
          .object({
            contract_id: z.string(),
            status: z.enum(["registered", "pending"]).optional().default("registered"),
          })
          .parse(args);

        const criteria: Criteria[] = [
          { name: "status", type: "value", value: status },
          { name: "category", type: "value", value: "expense" },
          { name: "contract_id", type: "value", value: contract_id },
        ];

        const result = await callCheckbookApi({
          type_of_data: "Contracts",
          records_from: 1,
          max_records: 10,
          criteria,
          response_columns: DEFAULT_COLUMNS["Contracts"],
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                { contract_id, records: result.records, error: result.error }
              ),
            },
          ],
        };
      }

      // ── search_spending ───────────────────────────────────────────────────
      case "search_spending": {
        const input = z
          .object({
            fiscal_year: z.string().optional(),
            agency_code: z.string().optional(),
            payee_name: z.string().optional(),
            contract_id: z.string().optional(),
            issue_date_from: z.string().optional(),
            issue_date_to: z.string().optional(),
            amount_min: z.number().optional(),
            amount_max: z.number().optional(),
            expense_category: z.string().optional(),
            spending_category: z.string().optional(),
            mwbe_category: z.string().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const criteria: Criteria[] = [];

        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.payee_name)
          criteria.push({ name: "payee_name", type: "value", value: input.payee_name });
        if (input.contract_id)
          criteria.push({ name: "contract_id", type: "value", value: input.contract_id });
        if (input.expense_category)
          criteria.push({ name: "expense_category", type: "value", value: input.expense_category });
        if (input.spending_category)
          criteria.push({ name: "spending_category", type: "value", value: input.spending_category });
        if (input.mwbe_category)
          criteria.push({ name: "mwbe_category", type: "value", value: input.mwbe_category });
        if (input.issue_date_from || input.issue_date_to) {
          criteria.push({
            name: "issue_date",
            type: "range",
            start: input.issue_date_from ?? "1990-01-01",
            end: input.issue_date_to ?? "2099-12-31",
          });
        }
        if (input.amount_min !== undefined || input.amount_max !== undefined) {
          criteria.push({
            name: "check_amount",
            type: "range",
            start: String(input.amount_min ?? 0),
            end: String(input.amount_max ?? 99999999999),
          });
        }

        const pageSize = Math.min(input.page_size, 1000);
        const result = await callCheckbookApi({
          type_of_data: "Spending",
          records_from: (input.page - 1) * pageSize + 1,
          max_records: pageSize,
          criteria,
          response_columns: DEFAULT_COLUMNS["Spending"],
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  total_records: result.total_records,
                  page: input.page,
                  page_size: pageSize,
                  has_more: result.total_records > input.page * pageSize,
                  records: result.records,
                  error: result.error,
                }
              ),
            },
          ],
        };
      }

      // ── search_budget ─────────────────────────────────────────────────────
      case "search_budget": {
        const input = z
          .object({
            fiscal_year: z.string().optional(),
            agency_code: z.string().optional(),
            department_code: z.string().optional(),
            budget_code: z.string().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const criteria: Criteria[] = [];
        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.department_code)
          criteria.push({ name: "department_code", type: "value", value: input.department_code });
        if (input.budget_code)
          criteria.push({ name: "budget_code", type: "value", value: input.budget_code });

        const pageSize = Math.min(input.page_size, 1000);
        const result = await callCheckbookApi({
          type_of_data: "Budget",
          records_from: (input.page - 1) * pageSize + 1,
          max_records: pageSize,
          criteria,
          response_columns: DEFAULT_COLUMNS["Budget"],
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  total_records: result.total_records,
                  page: input.page,
                  page_size: pageSize,
                  has_more: result.total_records > input.page * pageSize,
                  records: result.records,
                  error: result.error,
                }
              ),
            },
          ],
        };
      }

      // ── search_payroll ────────────────────────────────────────────────────
      case "search_payroll": {
        const input = z
          .object({
            fiscal_year: z.string().optional(),
            agency_code: z.string().optional(),
            last_name: z.string().optional(),
            title: z.string().optional(),
            salary_min: z.number().optional(),
            salary_max: z.number().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const criteria: Criteria[] = [];
        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.last_name)
          criteria.push({ name: "last_name", type: "value", value: input.last_name });
        if (input.title)
          criteria.push({ name: "title", type: "value", value: input.title });
        if (input.salary_min !== undefined || input.salary_max !== undefined) {
          criteria.push({
            name: "base_salary",
            type: "range",
            start: String(input.salary_min ?? 0),
            end: String(input.salary_max ?? 99999999),
          });
        }

        const pageSize = Math.min(input.page_size, 1000);
        const result = await callCheckbookApi({
          type_of_data: "Payroll",
          records_from: (input.page - 1) * pageSize + 1,
          max_records: pageSize,
          criteria,
          response_columns: DEFAULT_COLUMNS["Payroll"],
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  total_records: result.total_records,
                  page: input.page,
                  page_size: pageSize,
                  has_more: result.total_records > input.page * pageSize,
                  records: result.records,
                  error: result.error,
                }
              ),
            },
          ],
        };
      }

      // ── search_revenue ────────────────────────────────────────────────────
      case "search_revenue": {
        const input = z
          .object({
            fiscal_year: z.string().optional(),
            agency_code: z.string().optional(),
            budget_code: z.string().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const criteria: Criteria[] = [];
        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.budget_code)
          criteria.push({ name: "budget_code", type: "value", value: input.budget_code });

        const pageSize = Math.min(input.page_size, 1000);
        const result = await callCheckbookApi({
          type_of_data: "Revenue",
          records_from: (input.page - 1) * pageSize + 1,
          max_records: pageSize,
          criteria,
          response_columns: DEFAULT_COLUMNS["Revenue"],
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  total_records: result.total_records,
                  page: input.page,
                  page_size: pageSize,
                  has_more: result.total_records > input.page * pageSize,
                  records: result.records,
                  error: result.error,
                }
              ),
            },
          ],
        };
      }

      // ── get_agency_spending ───────────────────────────────────────────────
      case "get_agency_spending": {
        const input = z
          .object({
            agency_code: z.string(),
            fiscal_year: z.string(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const pageSize = Math.min(input.page_size, 1000);
        const result = await callCheckbookApi({
          type_of_data: "Spending",
          records_from: (input.page - 1) * pageSize + 1,
          max_records: pageSize,
          criteria: [
            { name: "agency_code", type: "value", value: input.agency_code },
            { name: "fiscal_year", type: "value", value: input.fiscal_year },
          ],
          response_columns: DEFAULT_COLUMNS["Spending"],
        });

        return {
          content: [
            {
              type: "text",
              text: withDisclaimer(
                {
                  agency_code: input.agency_code,
                  fiscal_year: input.fiscal_year,
                  total_records: result.total_records,
                  page: input.page,
                  page_size: pageSize,
                  has_more: result.total_records > input.page * pageSize,
                  records: result.records,
                  error: result.error,
                }
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
