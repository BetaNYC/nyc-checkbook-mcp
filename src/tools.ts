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

// Request-parameter names accepted by the citywide Registered Contracts domain.
// Transcribed from the CheckbookNYC API config requestParameters for
// contracts_active_expense / contracts_active_expense_all_years
// (NYCComptroller/Checkbook, source/.../checkbook_api/src/config/contracts.json)
// and corroborated by the live API's own valid-values error (issue #16,
// 2026-07-16). CRITICAL: there is NO vendor-*name* request parameter — the
// domain filters vendors only by "vendor_code". "prime_vendor" /
// "associated_prime_vendor" are internal column mappings, NOT accepted filters,
// so vendor_name must not be mapped to a request criterion here. Vendor-name
// lookups are handled explicitly in the search_contracts handler.
const CONTRACT_VALUE_FIELDS: Record<string, string> = {
  fiscal_year: "fiscal_year",
  agency_code: "agency_code",
  vendor_code: "vendor_code",
  contract_id: "contract_id",
  award_method: "award_method",
  mwbe_category: "mwbe_category",
  industry: "industry",
  contract_type: "contract_type",
};

/**
 * Guidance returned when a caller filters contracts by vendor *name*.
 *
 * The Checkbook NYC contracts XML API has no vendor-name request parameter and
 * no vendor-directory domain to resolve a name → vendor_code (verified against
 * the API config: only budget/contracts/payroll/revenue/spending domains
 * exist). Rather than silently drop the filter (which would return unrelated
 * contracts) or send an invalid param (which yields an opaque 1101 error), the
 * handler stops and explains the supported paths.
 */
export const VENDOR_NAME_UNSUPPORTED_MESSAGE =
  "search_contracts cannot filter by vendor name: the Checkbook NYC contracts " +
  "API filters vendors only by 'vendor_code', and offers no name→code lookup. " +
  "Options: (1) pass vendor_code if you know it; (2) use search_spending with " +
  "payee_name to find checks paid to a vendor by name; (3) use smart_search " +
  "for a name/keyword search (note: the smart_search web endpoint is currently " +
  "behind a WAF and is often unavailable server-side).";

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
  // ── UNVERIFIED contract filters (issues #6/#8/#10) ──────────────────────────
  // Config-only, gated at the handler behind CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS.
  // See CONTRACT_UNVERIFIED_FILTER_KEYS / UNVERIFIED_CONTRACT_FILTERS_MESSAGE below.
  purpose?: string;
  pin?: string;
  registration_date_from?: string; // registered-only
  registration_date_to?: string; // registered-only
  contract_includes_sub_vendors?: string; // registered-only
  received_date_from?: string; // pending-only
  received_date_to?: string; // pending-only
  include_sub_vendors?: boolean;
}

// Documented sub-vendor / subcontractor response columns (issue #8), confirmed
// against https://www.checkbooknyc.com/contract-api (2026-07-09). Opt-in only:
// appended when include_sub_vendors is set on a registered-contracts search.
// These use the registered/expense column-token naming, so they are not applied
// to the pending column set (which uses a different token scheme).
export const SUB_VENDOR_COLUMNS: string[] = [
  "sub_vendor",
  "sub_vendor_mwbe_category",
  "sub_contract_purpose",
  "sub_contract_status",
  "sub_contract_current_amount",
  "sub_contract_original_amount",
  "sub_vendor_paid_to_date",
  "sub_contract_registration_date",
  "sub_contract_industry",
  "sub_woman_owned_business",
  "sub_emerging_business",
];

/**
 * Select the response columns for a contracts search.
 *
 * Base set is DEFAULT_COLUMNS.Contracts (registered) or Contracts_pending.
 * Sub-vendor columns are appended only for registered contracts when
 * include_sub_vendors is requested — the pending column set uses a different,
 * incompatible token scheme.
 */
export function contractsColumns(
  status: "registered" | "pending",
  includeSubVendors: boolean
): string[] {
  const base =
    status === "pending" ? DEFAULT_COLUMNS["Contracts_pending"] : DEFAULT_COLUMNS["Contracts"];
  if (includeSubVendors && status !== "pending") {
    return [...base, ...SUB_VENDOR_COLUMNS];
  }
  return base;
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

  // ── UNVERIFIED contract filters (issues #6/#8/#10) ──────────────────────────
  // Transcribed from the CheckbookNYC open-source API config
  // (NYCComptroller/Checkbook, checkbook_api/src/config/contracts.json). NOT
  // verified against the live API. #17 (v1.3.1, 2026-07-16) proved that same
  // open-source config does NOT match the live contracts domain (it had
  // vendor_name→prime_vendor and a bogus `year` column that broke every query),
  // so every token below is treated as UNVERIFIED and gated at the handler behind
  // CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS until the operator live-verifies.
  // `purpose`, `pin`, `registration_date`, and `contract_includes_sub_vendors`
  // DO appear in #17's live-corroborated VALID_CONTRACTS_CRITERIA set; `received_date`
  // does not (it is a pending-domain param #17 never exercised).
  //
  // contractsCriteria stays a pure builder (used by unit tests and by the handler
  // only after the gate passes); the gate lives in the search_contracts handler.
  if (input.purpose !== undefined && input.purpose !== "") {
    criteria.push({ name: "purpose", type: "value", value: String(input.purpose) });
  }
  if (input.pin !== undefined && input.pin !== "") {
    criteria.push({ name: "pin", type: "value", value: String(input.pin) });
  }
  // Status-conditional: registered and pending configs expose different date/status
  // params. Sending a param to the config that does not declare it is rejected, so
  // each is gated to the status whose config declares it (matches the OGE/NYCHA
  // pattern already in this file).
  if (input.status === "registered") {
    const regDate = rangeCriterion(
      "registration_date",
      input.registration_date_from,
      input.registration_date_to,
      "1990-01-01",
      "2099-12-31"
    );
    if (regDate) criteria.push(regDate);

    // issue #8 — sub-vendor status-code filter. Criterion name/type is config-sourced;
    // the accepted 2-char code enumeration is NOT published, so the raw value is
    // passed through verbatim rather than validated.
    if (
      input.contract_includes_sub_vendors !== undefined &&
      input.contract_includes_sub_vendors !== ""
    ) {
      criteria.push({
        name: "contract_includes_sub_vendors",
        type: "value",
        value: String(input.contract_includes_sub_vendors),
      });
    }
  } else if (input.status === "pending") {
    // issue #10 — received_date is a pending-contract concept only; registered
    // contracts use registration_date instead. WEAKEST footing: not in #17's set.
    const recDate = rangeCriterion(
      "received_date",
      input.received_date_from,
      input.received_date_to,
      "1990-01-01",
      "2099-12-31"
    );
    if (recDate) criteria.push(recDate);
  }

  return criteria;
}

// ── UNVERIFIED contract-filter gate (issues #6/#8/#10) ────────────────────────
// The five filters above are transcribed from the CheckbookNYC open-source config
// only. They are NOT verified against the live API, which is exactly the failure
// class #17 fixed (the same config had vendor_name/year wrong and broke every
// contracts query). Until the operator live-verifies them, supplying any of these
// makes search_contracts fail fast with guidance instead of firing an unverified
// token at the live API. The operator enables them, after live-verification, by
// setting CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1 (mirrors the standards §7
// --operator-authorized pattern). Exported for tests.
export const CONTRACT_UNVERIFIED_FILTER_KEYS = [
  "purpose",
  "pin",
  "registration_date_from",
  "registration_date_to",
  "contract_includes_sub_vendors",
  "received_date_from",
  "received_date_to",
] as const;

/** True when the operator has authorized the unverified contract filters. */
export function unverifiedContractFiltersEnabled(): boolean {
  const v = process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
  return v === "1" || v === "true";
}

/** Names of unverified contract filters actually supplied on this input. */
export function suppliedUnverifiedContractFilters(
  input: Record<string, unknown>
): string[] {
  return CONTRACT_UNVERIFIED_FILTER_KEYS.filter(
    (k) => input[k] !== undefined && input[k] !== ""
  );
}

export const UNVERIFIED_CONTRACT_FILTERS_MESSAGE =
  "search_contracts received filter(s) that are transcribed from the CheckbookNYC " +
  "open-source config but have NOT been verified against the live API. That config " +
  "mismatch is exactly what broke every contracts query in v1.3.0 (fixed in #17). " +
  "These filters are therefore disabled pending operator live-verification. To enable " +
  "them after confirming each works against the live API, set the environment variable " +
  "CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1. Unverified filter(s) supplied: ";

// ─── NYCEDC (OGE) + NYCHA contracts (issue #7) ───────────────────────────────
// Criteria names and defaults transcribed verbatim from the CheckbookNYC API
// config (checkbook_api/src/config/contracts_oge.json and contracts_nycha.json,
// searchCriteriaMap / requestParameters) — 2026-07-09. These entities use
// distinct request-criteria names and response columns from citywide Contracts,
// so they get purpose-built tools rather than an overloaded search_contracts.

export interface NycedcContractsInput {
  fiscal_year?: string;
  vendor_name?: string;
  contract_id?: string;
  entity_contract_number?: string;
  other_government_entities_code?: string;
  award_method?: string;
  expense_category?: string;
  budget_name?: string;
  commodity_line?: string;
  pin?: string;
  amount_min?: number;
  amount_max?: number;
  start_date_from?: string;
  start_date_to?: string;
  end_date_from?: string;
  end_date_to?: string;
}

// The OGE contracts config's requiredCriteria: status=registered, category=expense.
export function nycedcContractsCriteria(input: NycedcContractsInput): Criteria[] {
  const criteria: Criteria[] = [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
    ...valueCriteria(input as unknown as Record<string, unknown>, {
      fiscal_year: "fiscal_year",
      vendor_name: "prime_vendor",
      contract_id: "contract_id",
      entity_contract_number: "entity_contract_number",
      other_government_entities_code: "other_government_entities_code",
      award_method: "award_method",
      expense_category: "expense_category",
      budget_name: "budget_name",
      commodity_line: "commodity_line",
      pin: "pin",
    }),
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

export interface NychaContractsInput {
  fiscal_year?: string;
  vendor_name?: string;
  vendor_code?: string;
  contract_id?: string;
  purchase_order_type?: string;
  responsibility_center?: string;
  contract_type?: string;
  award_method?: string;
  industry?: string;
  other_government_entities_code?: string;
  purpose?: string;
  pin?: string;
  amount_min?: number;
  amount_max?: number;
  start_date_from?: string;
  start_date_to?: string;
  end_date_from?: string;
  end_date_to?: string;
  approved_date_from?: string;
  approved_date_to?: string;
}

export function nychaContractsCriteria(input: NychaContractsInput): Criteria[] {
  const criteria: Criteria[] = [
    ...valueCriteria(input as unknown as Record<string, unknown>, {
      fiscal_year: "fiscal_year",
      vendor_name: "vendor_name",
      vendor_code: "vendor_code",
      contract_id: "contract_id",
      purchase_order_type: "purchase_order_type",
      responsibility_center: "responsibility_center",
      contract_type: "contract_type",
      award_method: "award_method",
      industry: "industry",
      other_government_entities_code: "other_government_entities_code",
      purpose: "purpose",
      pin: "pin",
    }),
  ];
  for (const range of [
    rangeCriterion("current_amount", input.amount_min, input.amount_max, "0", "99999999999"),
    rangeCriterion("start_date", input.start_date_from, input.start_date_to, "1990-01-01", "2099-12-31"),
    rangeCriterion("end_date", input.end_date_from, input.end_date_to, "1990-01-01", "2099-12-31"),
    rangeCriterion("approved_date", input.approved_date_from, input.approved_date_to, "1990-01-01", "2099-12-31"),
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
        "Filter by agency, vendor_code, contract ID, date range, amount range, industry, MWBE category, and more. " +
        "NOTE: the contracts API has NO vendor-name filter — vendors are filtered only by vendor_code. " +
        "To find contracts by vendor NAME, use search_spending (payee_name) or smart_search. " +
        "Use smart_search to find contracts by product or software name (many contracts are held by resellers).",
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
          .describe(
            "NOT SUPPORTED as a contracts filter — the Checkbook API has no vendor-name " +
              "parameter and no name→code lookup. Supplying this returns actionable guidance " +
              "(use vendor_code, or search_spending/smart_search for name search). " +
              "Prefer vendor_code."
          ),
        vendor_code: z.string().optional().describe("Vendor identification code (the only vendor filter for contracts)"),
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
        purpose: z
          .string()
          .optional()
          .describe(
            "Contract purpose keyword (server-side 'contains' match). " +
              "NEEDS-LIVE-VERIFY: config-sourced, disabled unless " +
              "CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        pin: z
          .string()
          .optional()
          .describe(
            "Contract PIN / tracking number. NEEDS-LIVE-VERIFY: config-sourced, " +
              "disabled unless CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        registration_date_from: z
          .string()
          .optional()
          .describe(
            "Registration date range begin (YYYY-MM-DD). Registered contracts only. " +
              "NEEDS-LIVE-VERIFY: config-sourced, disabled unless " +
              "CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        registration_date_to: z
          .string()
          .optional()
          .describe(
            "Registration date range end (YYYY-MM-DD). Registered contracts only. " +
              "NEEDS-LIVE-VERIFY: config-sourced, disabled unless " +
              "CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        received_date_from: z
          .string()
          .optional()
          .describe(
            "Received date range begin (YYYY-MM-DD). Pending contracts only (registered " +
              "use registration_date). NEEDS-LIVE-VERIFY: config-sourced and the pending " +
              "domain was not live-tested by #17; disabled unless " +
              "CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        received_date_to: z
          .string()
          .optional()
          .describe(
            "Received date range end (YYYY-MM-DD). Pending contracts only. " +
              "NEEDS-LIVE-VERIFY: config-sourced, disabled unless " +
              "CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        contract_includes_sub_vendors: z
          .string()
          .optional()
          .describe(
            "Advanced: sub-vendor status filter — a 2-character code. Registered contracts " +
              "only. The accepted code values are not published in the Comptroller's API " +
              "config, so the raw code is passed through verbatim. NEEDS-LIVE-VERIFY: " +
              "config-sourced, disabled unless CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1."
          ),
        include_sub_vendors: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include sub-vendor / subcontractor detail columns (sub_vendor, " +
              "sub_vendor_mwbe_category, sub_contract_current_amount, etc.) in the response. " +
              "Applies to registered contracts only; ignored for status='pending'."
          ),
        page: z.number().optional().default(1).describe("Page number for pagination (default: 1)"),
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() => {
        if (input.vendor_name) {
          throw new Error(VENDOR_NAME_UNSUPPORTED_MESSAGE);
        }
        // Fail-fast gate for config-only, live-UNVERIFIED contract filters
        // (issues #6/#8/#10). Refuse to send an unverified token to the live API
        // unless the operator has authorized it after live-verification.
        if (!unverifiedContractFiltersEnabled()) {
          const supplied = suppliedUnverifiedContractFilters(
            input as unknown as Record<string, unknown>
          );
          if (supplied.length > 0) {
            throw new Error(UNVERIFIED_CONTRACT_FILTERS_MESSAGE + supplied.join(", ") + ".");
          }
        }
        return runSearch(
          "Contracts",
          contractsColumns(input.status, input.include_sub_vendors),
          contractsCriteria(input),
          input.page,
          input.page_size
        );
      })
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

  server.registerTool(
    "search_nycedc_contracts",
    {
      description:
        "Search NYCEDC / Other Government Entities (OGE) contracts (Checkbook domain Contracts_OGE). " +
        "These are separate from citywide contracts and cover economic-development-corporation and " +
        "other-government-entity agreements. Registered expense contracts only. Filter by fiscal year, " +
        "vendor, entity contract number, OGE agency code, award method, expense category, budget name, " +
        "commodity line, amount, and date ranges.",
      inputSchema: {
        fiscal_year: fiscalYearSchema,
        vendor_name: z
          .string()
          .optional()
          .describe("Prime vendor name (first 3 characters matched)"),
        contract_id: z.string().optional().describe("Contract number"),
        entity_contract_number: z
          .string()
          .optional()
          .describe("OGE entity contract number"),
        other_government_entities_code: z
          .string()
          .optional()
          .describe("OGE agency code (identifies the other government entity)"),
        award_method: z.string().optional().describe("Award method code"),
        expense_category: z.string().optional().describe("Expense category code"),
        budget_name: z
          .string()
          .optional()
          .describe("Budget name (first 3 characters matched)"),
        commodity_line: z.string().optional().describe("Commodity line code (EDC contracts)"),
        pin: z.string().optional().describe("Contract PIN / tracking number"),
        amount_min: z.number().optional().describe("Minimum current contract amount"),
        amount_max: z.number().optional().describe("Maximum current contract amount"),
        start_date_from: z.string().optional().describe("Start date range begin (YYYY-MM-DD)"),
        start_date_to: z.string().optional().describe("Start date range end (YYYY-MM-DD)"),
        end_date_from: z.string().optional().describe("End date range begin (YYYY-MM-DD)"),
        end_date_to: z.string().optional().describe("End date range end (YYYY-MM-DD)"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() =>
        runSearch(
          "Contracts_OGE",
          DEFAULT_COLUMNS["Contracts_OGE"],
          nycedcContractsCriteria(input),
          input.page,
          input.page_size
        )
      )
  );

  server.registerTool(
    "search_nycha_contracts",
    {
      description:
        "Search NYCHA (New York City Housing Authority) contracts (Checkbook domain Contracts_NYCHA). " +
        "These are separate from citywide contracts and are reported at release / line-item granularity " +
        "(purchase-order releases, funding source, program/project). Filter by fiscal year, vendor, " +
        "purchase-order type, responsibility center, contract type, industry, amount, and date ranges " +
        "(including approved date).",
      inputSchema: {
        fiscal_year: fiscalYearSchema,
        vendor_name: z.string().optional().describe("Vendor name (contains match)"),
        vendor_code: z.string().optional().describe("Vendor number / code"),
        contract_id: z.string().optional().describe("Contract ID"),
        purchase_order_type: z.string().optional().describe("Purchase order type code"),
        responsibility_center: z.string().optional().describe("Responsibility center code"),
        contract_type: z.string().optional().describe("Contract type code"),
        award_method: z.string().optional().describe("Award method code"),
        industry: z.string().optional().describe("Industry type code"),
        other_government_entities_code: z
          .string()
          .optional()
          .describe("NYCHA agency code"),
        purpose: z.string().optional().describe("Contract purpose (contains match)"),
        pin: z.string().optional().describe("PO header ID / PIN"),
        amount_min: z.number().optional().describe("Minimum contract amount"),
        amount_max: z.number().optional().describe("Maximum contract amount"),
        start_date_from: z.string().optional().describe("Start date range begin (YYYY-MM-DD)"),
        start_date_to: z.string().optional().describe("Start date range end (YYYY-MM-DD)"),
        end_date_from: z.string().optional().describe("End date range begin (YYYY-MM-DD)"),
        end_date_to: z.string().optional().describe("End date range end (YYYY-MM-DD)"),
        approved_date_from: z
          .string()
          .optional()
          .describe("Release approved date range begin (YYYY-MM-DD)"),
        approved_date_to: z
          .string()
          .optional()
          .describe("Release approved date range end (YYYY-MM-DD)"),
        page: pageSchema,
        page_size: pageSizeSchema,
      },
    },
    async (input) =>
      guard(() =>
        runSearch(
          "Contracts_NYCHA",
          DEFAULT_COLUMNS["Contracts_NYCHA"],
          nychaContractsCriteria(input),
          input.page,
          input.page_size
        )
      )
  );
}
