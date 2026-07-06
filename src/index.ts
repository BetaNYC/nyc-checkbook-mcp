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
        "CAVEAT: the underlying checkbooknyc.com web endpoint is protected by a WAF and renders results " +
        "client-side, so this tool is frequently unavailable server-side. When it is, it returns a " +
        "structured explanation and fallback guidance (use search_contracts/search_spending, or browse " +
        "checkbooknyc.com/smart_search in a browser). The structured search tools only match exact " +
        "vendor names and may miss contracts held by resellers.",
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
          category: {
            type: "string",
            enum: ["expense", "revenue"],
            description: "Contract category (default: expense)",
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
        "Search NYC payroll records by agency, job title, pay frequency, pay date, or amount range. " +
        "Requires fiscal_year or calendar_year. " +
        "NOTE: the Checkbook NYC API does not expose employee names — payroll data is aggregated by " +
        "agency/title/pay date. There is no employee-name search.",
      inputSchema: {
        type: "object",
        properties: {
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2026'. Either fiscal_year or calendar_year is required.",
          },
          calendar_year: {
            type: "string",
            description: "Calendar year, e.g. '2025'. Either fiscal_year or calendar_year is required.",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code, e.g. '846' for Parks",
          },
          title: {
            type: "string",
            description: "Job title (partial match)",
          },
          pay_frequency: {
            type: "string",
            description: "Pay frequency, e.g. 'BI-WEEKLY', 'SUPPLEMENTAL'",
          },
          pay_date_from: {
            type: "string",
            description: "Pay date range start (YYYY-MM-DD)",
          },
          pay_date_to: {
            type: "string",
            description: "Pay date range end (YYYY-MM-DD)",
          },
          amount_min: {
            type: "number",
            description: "Minimum payment amount",
          },
          amount_max: {
            type: "number",
            description: "Maximum payment amount",
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
        "Search NYC revenue data by agency, revenue category/class/source, fund class, or fiscal year.",
      inputSchema: {
        type: "object",
        properties: {
          fiscal_year: {
            type: "string",
            description: "Fiscal year, e.g. '2026'",
          },
          budget_fiscal_year: {
            type: "string",
            description: "Budget fiscal year, e.g. '2026'",
          },
          agency_code: {
            type: "string",
            description: "3-digit agency code",
          },
          revenue_category: {
            type: "string",
            description: "2-character revenue category code (not the category name)",
          },
          revenue_class: {
            type: "string",
            description: "Revenue class code",
          },
          revenue_source: {
            type: "string",
            description: "Revenue source code",
          },
          fund_class: {
            type: "string",
            description: "Fund class code",
          },
          funding_class: {
            type: "string",
            description: "Funding class code",
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
        const { query, limit } = z
          .object({
            query: z.string(),
            limit: z.number().int().min(1).max(100).optional().default(25),
          })
          .parse(args);

        const result = await smartSearch(query, limit);

        if (!result.available) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    query,
                    available: false,
                    reason: result.reason,
                    fallback: result.fallback,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

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
        const { contract_id, status = "registered", category = "expense" } = z
          .object({
            contract_id: z.string(),
            status: z.enum(["registered", "pending"]).optional().default("registered"),
            category: z.enum(["expense", "revenue"]).optional().default("expense"),
          })
          .parse(args);

        const criteria: Criteria[] = [
          { name: "status", type: "value", value: status },
          { name: "category", type: "value", value: category },
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
          .refine((v) => v.fiscal_year || v.issue_date_from, {
            message: "Either fiscal_year or issue_date_from is required.",
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
        // The Budget domain's year criterion is named "year", not "fiscal_year".
        if (input.fiscal_year)
          criteria.push({ name: "year", type: "value", value: input.fiscal_year });
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
            calendar_year: z.string().optional(),
            agency_code: z.string().optional(),
            title: z.string().optional(),
            pay_frequency: z.string().optional(),
            pay_date_from: z.string().optional(),
            pay_date_to: z.string().optional(),
            amount_min: z.number().optional(),
            amount_max: z.number().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .refine((v) => v.fiscal_year || v.calendar_year, {
            message: "Either fiscal_year or calendar_year is required.",
          })
          .parse(args);

        const criteria: Criteria[] = [];
        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.calendar_year)
          criteria.push({ name: "calendar_year", type: "value", value: input.calendar_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.title)
          criteria.push({ name: "title", type: "value", value: input.title });
        if (input.pay_frequency)
          criteria.push({ name: "pay_frequency", type: "value", value: input.pay_frequency });
        if (input.pay_date_from || input.pay_date_to) {
          criteria.push({
            name: "pay_date",
            type: "range",
            start: input.pay_date_from ?? "1990-01-01",
            end: input.pay_date_to ?? "2099-12-31",
          });
        }
        if (input.amount_min !== undefined || input.amount_max !== undefined) {
          criteria.push({
            name: "amount",
            type: "range",
            start: String(input.amount_min ?? 0),
            end: String(input.amount_max ?? 99999999),
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
            budget_fiscal_year: z.string().optional(),
            agency_code: z.string().optional(),
            revenue_category: z.string().optional(),
            revenue_class: z.string().optional(),
            revenue_source: z.string().optional(),
            fund_class: z.string().optional(),
            funding_class: z.string().optional(),
            page: z.number().optional().default(1),
            page_size: z.number().optional().default(50),
          })
          .parse(args);

        const criteria: Criteria[] = [];
        if (input.fiscal_year)
          criteria.push({ name: "fiscal_year", type: "value", value: input.fiscal_year });
        if (input.budget_fiscal_year)
          criteria.push({ name: "budget_fiscal_year", type: "value", value: input.budget_fiscal_year });
        if (input.agency_code)
          criteria.push({ name: "agency_code", type: "value", value: input.agency_code });
        if (input.revenue_category)
          criteria.push({ name: "revenue_category", type: "value", value: input.revenue_category });
        if (input.revenue_class)
          criteria.push({ name: "revenue_class", type: "value", value: input.revenue_class });
        if (input.revenue_source)
          criteria.push({ name: "revenue_source", type: "value", value: input.revenue_source });
        if (input.fund_class)
          criteria.push({ name: "fund_class", type: "value", value: input.fund_class });
        if (input.funding_class)
          criteria.push({ name: "funding_class", type: "value", value: input.funding_class });

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
