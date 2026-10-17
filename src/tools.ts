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

// The API's own ceiling. Note the practical limit for an MCP response is the
// caller's context window, not this number, which is why the default stays 50.
export const MAX_RECORDS_PER_CALL = 20_000;


export async function runSearch(
  domain: DataDomain,
  columns: string[],
  criteria: Criteria[],
  page: number,
  page_size: number,
  extra?: Record<string, unknown>
): Promise<CallToolResult> {
  // The API accepts up to 20,000 records per call (confirmed by the
  // Comptroller's office, 2026-07-28). We previously clamped to 1,000, which
  // silently capped anyone asking for more and wasted the 1 req/sec budget by
  // forcing extra calls. Same bug class as New-York-City-Budget#42.
  const pageSize = Math.min(page_size, MAX_RECORDS_PER_CALL);
  const result = await callCheckbookApi({
    type_of_data: domain,
    records_from: (page - 1) * pageSize + 1,
    max_records: pageSize,
    criteria,
    response_columns: columns,
  });

  // No `error` field here: callCheckbookApi THROWS on any upstream failure
  // (issue #21), which guard() turns into an isError result. So total_records is
  // only ever reported for a genuine success — a real 0 means "no matching
  // records", never "the request failed".
  return textResult({
    ...extra,
    total_records: result.total_records,
    page,
    page_size: pageSize,
    has_more: result.total_records > page * pageSize,
    records: result.records,
  });
}

// ─── Shared schema fragments ─────────────────────────────────────────────────

// Bounded, not clamped. #19 established that this server rejects bad input rather
// than silently coercing it; an unbounded page/page_size reached the wire as
// max_records=-5 or records_from=-49, spending a request from a 1/sec budget on a
// call that cannot succeed.
const pageSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .default(1)
  .describe("Page number, 1-based (default: 1)");
const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_RECORDS_PER_CALL)
  .optional()
  .default(50)
  .describe("Results per page (default: 50, max: 20000)");
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
/**
 * Registered revenue + fiscal_year is a known upstream defect (#42): the API
 * reports a match count (399 for FY2025) and returns no rows for ANY response
 * column set, contract_id alone included (live, 2026-10-16). search_contracts
 * refuses that shape before sending a request, rather than spending one from
 * the 1 req/sec budget on a reply that can only be the silent-empty error.
 */
export const REVENUE_FISCAL_YEAR_UNSUPPORTED_MESSAGE =
  "search_contracts cannot search registered revenue contracts by fiscal_year: " +
  "this is a known Checkbook NYC API limitation (#42). The API reports a match " +
  "count for that shape but returns no records, whatever columns are requested. " +
  "Omit fiscal_year and filter by date range instead (start_date_from/_to, " +
  "end_date_from/_to, or registration_date_from/_to). No request was sent.";

/** True for the shape REVENUE_FISCAL_YEAR_UNSUPPORTED_MESSAGE refuses, judged from the criteria to be sent. */
export function isRegisteredRevenueFiscalYear(criteria: Criteria[]): boolean {
  return (
    (criterionValue(criteria, "status") ?? "registered") === "registered" &&
    criterionValue(criteria, "category") === "revenue" &&
    sendsFiscalYear(criteria)
  );
}

export const VENDOR_NAME_UNSUPPORTED_MESSAGE =
  "search_contracts cannot filter by vendor name: the Checkbook NYC contracts " +
  "API filters vendors only by 'vendor_code', and offers no name→code lookup. " +
  "Options: (1) pass vendor_code if you know it; (2) use search_spending with " +
  "payee_name to find checks paid to a vendor by name, then read the contract " +
  "ID from those results and pass it to search_contracts(contract_id) or " +
  "get_contract.";

// ─── Strict input schemas (issue #19) ────────────────────────────────────────

/**
 * Guidance for the undeclared parameter name a caller is most likely to guess.
 *
 * `vendor` is not a parameter, so zod used to strip it and the vendor_name guard
 * below never fired — search_contracts(vendor="…") returned 5,755,099 unrelated
 * rows (issue #19). A one-word typo defeated a deliberate guard.
 */
const VENDOR_ALIAS_HINT =
  "'vendor' is not a parameter of search_contracts — the declared parameter is " +
  `'vendor_name'. ${VENDOR_NAME_UNSUPPORTED_MESSAGE}`;

/**
 * Build a tool inputSchema that REJECTS unknown keys instead of stripping them.
 *
 * zod strips unknown keys by default, so an invented parameter vanished silently
 * and the tool answered a different question with real, correctly formatted data
 * — undetectable by the calling model. `.strict()` makes it a parse error, which
 * the SDK raises before the handler runs. Passing a full ZodObject (rather than a
 * raw shape) is supported: the SDK's getZodSchemaObject returns a schema instance
 * unchanged and only wraps bare raw shapes.
 *
 * `aliases` maps a guess we have actually observed to guidance naming the real
 * parameter, so the caller lands on the fix rather than a bare unrecognized-key error.
 */
export function strictSchema<T extends z.ZodRawShape>(
  shape: T,
  aliases: Record<string, string> = {}
) {
  return z
    .object(shape, {
      errorMap: (issue, ctx) => {
        if (issue.code !== z.ZodIssueCode.unrecognized_keys) return { message: ctx.defaultError };
        const hints = issue.keys.map((k) => aliases[k]).filter(Boolean);
        return { message: hints.length ? `${ctx.defaultError}. ${hints.join(" ")}` : ctx.defaultError };
      },
    })
    .strict();
}

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
  // ── Contract filters, live-verified 2026-07-28 (issues #6/#8/#10) ───────────
  // All five live-verified against the API on 2026-07-28 (see CHANGELOG 1.6.0);
  // the CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS gate they sat behind is gone.
  purpose?: string;
  pin?: string;
  registration_date_from?: string; // registered-only
  registration_date_to?: string; // registered-only
  contract_includes_sub_vendors?: number; // registered-only, integer flag (1 = has sub-vendors)
  received_date_from?: string; // pending-only
  received_date_to?: string; // pending-only
  include_sub_vendors?: boolean;
}

// Sub-vendor / subcontractor response columns (issue #8), LIVE-VERIFIED against
// the API on 2026-07-31. Opt-in only: appended when include_sub_vendors is set on
// a registered-contracts search. These use the registered/expense column-token
// naming, so they are not applied to the pending column set (which uses a
// different token scheme).
//
// The oracle here is the live API's own "Valid values are ..." list, NOT
// https://www.checkbooknyc.com/contract-api. The published docs list
// `sub_contract_registration_date`, which the live API rejects with error 1106 on
// BOTH registered/expense domain variants (fiscal-year-scoped and "All Years").
// Because one invalid column fails the whole request, that single token made
// every include_sub_vendors=true search error out in v1.2.0–v1.6.0. Same class of
// docs-vs-live defect as `year` in #16 — see the exclusion test in tools.test.mjs.
//
// This is now the complete set: all 13 sub_* tokens the live domain accepts.
export const SUB_VENDOR_COLUMNS: string[] = [
  "sub_vendor",
  "sub_vendor_mwbe_category",
  "sub_contract_purpose",
  "sub_contract_status",
  "sub_contract_current_amount",
  "sub_contract_original_amount",
  "sub_vendor_paid_to_date",
  "sub_contract_industry",
  "sub_contract_start_date",
  "sub_contract_end_date",
  "sub_contract_reference_id",
  "sub_woman_owned_business",
  "sub_emerging_business",
];

function criterionValue(criteria: Criteria[], name: string): string | undefined {
  return criteria.find((x) => x.name === name)?.value;
}

/**
 * Select the response columns for a citywide Contracts call (search_contracts,
 * get_contract), given the criteria it sends (issue #42).
 *
 * The live API resolves a different domain per (status, category), and the
 * column vocabularies differ (probe 2026-10-16):
 *
 *   registered + expense | all  -> DEFAULT_COLUMNS.Contracts (prime_contract_*)
 *   registered + revenue        -> DEFAULT_COLUMNS.Contracts_revenue
 *   pending + any category      -> DEFAULT_COLUMNS.Contracts_pending
 *
 * fiscal_year does not change the selection: for every shape, each chosen
 * column is in the live list both with and without fiscal_year.
 *
 * Sub-vendor columns are appended only for registered expense/all when
 * include_sub_vendors is requested. The pending and registered/revenue domains
 * list no sub_* columns, so the flag is ignored there.
 *
 * Decided from the built criteria, not the tool input, so what is decided
 * matches what is sent. A missing status/category means the tools' defaults
 * (registered, expense).
 */
export function contractsColumns(criteria: Criteria[], includeSubVendors = false): string[] {
  const status = criterionValue(criteria, "status") ?? "registered";
  const category = criterionValue(criteria, "category") ?? "expense";
  if (status === "pending") return DEFAULT_COLUMNS["Contracts_pending"];
  if (category === "revenue") return DEFAULT_COLUMNS["Contracts_revenue"];
  const base = DEFAULT_COLUMNS["Contracts"];
  return includeSubVendors ? [...base, ...SUB_VENDOR_COLUMNS] : base;
}

// ─── Call-shape-dependent columns (issue #40) ────────────────────────────────
// The live API resolves a different column vocabulary for the same type_of_data
// depending on whether fiscal_year is among the criteria sent. These columns are
// valid in one shape only, so they are added for that shape and never otherwise.
// Source: the live API's own valid-values lists, never the published config
// (which lists NYCHA `year` only in its fiscal-year block, matching the API, but
// lists OGE `apt_pin` in both blocks, which the API does not). Checked by scripts/check-default-columns.mjs
// against the probe variant for each shape.

/**
 * Contracts_NYCHA columns valid only WITH fiscal_year. Listed by the live
 * 'Contracts_nycha' domain when fiscal_year is sent (probe 2026-10-16); rejected
 * with 1106 on a vendor_name-only search (2026-10-15).
 */
export const NYCHA_FISCAL_YEAR_COLUMNS: string[] = ["year"];

/**
 * Contracts_OGE columns valid only WITHOUT fiscal_year. Listed by
 * 'Registered Contracts_oge(expense) All Years' (probe 2026-10-16); rejected with
 * 1106 by 'Registered Contracts_oge(expense)' on a fiscal_year search (2026-10-15).
 */
export const OGE_ALL_YEARS_COLUMNS: string[] = ["apt_pin"];

function sendsFiscalYear(criteria: Criteria[]): boolean {
  return criteria.some((c) => c.name === "fiscal_year");
}

/** Response columns for a NYCHA contracts search, given the criteria it sends. */
export function nychaContractsColumns(criteria: Criteria[]): string[] {
  const base = DEFAULT_COLUMNS["Contracts_NYCHA"];
  return sendsFiscalYear(criteria) ? [...base, ...NYCHA_FISCAL_YEAR_COLUMNS] : base;
}

/** Response columns for an NYCEDC/OGE contracts search, given the criteria it sends. */
export function nycedcContractsColumns(criteria: Criteria[]): string[] {
  const base = DEFAULT_COLUMNS["Contracts_OGE"];
  return sendsFiscalYear(criteria) ? base : [...base, ...OGE_ALL_YEARS_COLUMNS];
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

  // ── Contract filters, live-verified 2026-07-28 (issues #6/#8/#10) ───────────
  // Originally transcribed from the CheckbookNYC open-source API config and shipped
  // disabled, because #17 (v1.3.1) proved that same config does NOT match the live
  // contracts domain. All five have now been checked against the live API and the
  // gate is gone. Method: send a deliberately invalid criteria name and read the
  // API's own "Valid values are ..." list, then confirm each filter actually
  // narrows a known baseline (an accepted-but-ignored filter returns the baseline
  // count unchanged — the silent-drop failure this guards against).
  //
  // The API's valid-parameter lists also confirm the status gating below:
  //   registered: ... registration_date, purpose, pin, contract_includes_sub_vendors
  //   pending:    ... received_date,     purpose, pin
  // `received_date` had the weakest prior evidence (#17 never exercised the pending
  // domain) and is valid there.
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

    // issue #8 — sub-vendor flag. Live-verified 2026-07-28: this is an INTEGER,
    // not the 2-character status code the Comptroller's open-source config implied.
    // 1 returned 3,246 of 19,139 registered/expense FY2025; 0 returned 0. A
    // non-numeric value is rejected with "is not of data type integer", delivered
    // as HTTP 200 with a plain-text body that parses as an empty response.
    if (input.contract_includes_sub_vendors !== undefined) {
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

// ─── smart_search hard-gate (issue #25) ──────────────────────────────────────
// /smart_search is NOT a supported Checkbook NYC API endpoint. It is a
// WAF-fronted (Incapsula), JavaScript-rendered web page — confirmed with the NYC
// Comptroller's office as not-a-supported-endpoint — so the server does NOT call
// it by default. The tool stays registered (so a calling model still discovers it
// and its guidance, and tools/list is unchanged — no breaking surface change),
// but by default the handler fails fast WITHOUT any network call. An operator can
// opt in with CHECKBOOK_ENABLE_SMART_SEARCH=1 (mirrors the standards §7 operator-authorized gate
// above). Gating rather than removing keeps this a minor, not a major, change.

/** True when the operator has opted into the unsupported smart_search endpoint (issue #25). */
export function smartSearchEnabled(): boolean {
  const v = process.env.CHECKBOOK_ENABLE_SMART_SEARCH;
  return v === "1" || v === "true";
}

export const SMART_SEARCH_DISABLED_MESSAGE =
  "smart_search is disabled by default. The checkbooknyc.com /smart_search endpoint " +
  "is NOT a supported Checkbook NYC API endpoint (confirmed with the NYC Comptroller's " +
  "office) — it is a WAF-fronted, JavaScript-rendered web page, not a documented API — so " +
  "this server does not call it by default. Use the structured tools instead: " +
  "search_spending(payee_name=…) to find checks paid to a named vendor, search_contracts " +
  "(by vendor_code / agency_code) for contracts, or the budget/payroll/revenue tools. To opt " +
  "in anyway (it will almost always report unavailable behind the WAF), set the environment " +
  "variable CHECKBOOK_ENABLE_SMART_SEARCH=1.";

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
        "DISABLED BY DEFAULT (opt in with CHECKBOOK_ENABLE_SMART_SEARCH=1). The " +
        "checkbooknyc.com /smart_search endpoint is not a supported Checkbook NYC API " +
        "endpoint — it is a WAF-fronted, JavaScript-rendered web page — so this server " +
        "does not call it by default. Prefer the structured tools: search_spending" +
        "(payee_name=…) to find checks paid to a named vendor, search_contracts for " +
        "contract filters. When disabled (or when opted-in but WAF-blocked) this returns " +
        "structured fallback guidance rather than data.",
      inputSchema: strictSchema({
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
      }),
    },
    async ({ query, limit }) =>
      guard(async () => {
        // Hard-gate (issue #25): do not touch the unsupported endpoint unless the
        // operator has explicitly opted in. Fail fast BEFORE any network call.
        if (!smartSearchEnabled()) {
          return errorResult({
            query,
            available: false,
            reason: SMART_SEARCH_DISABLED_MESSAGE,
          });
        }
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
        "To find contracts by vendor NAME, use search_spending (payee_name) for checks paid to a named vendor. " +
        "Many contracts are held by resellers, so a product/software name may not match the contract's own vendor. " +
        "KNOWN API LIMITATION: registered revenue contracts (category 'revenue') with fiscal_year return no rows " +
        "from Checkbook NYC (a match count, no records), so the tool refuses that combination without sending a request; omit fiscal_year and filter by dates instead.",
      inputSchema: strictSchema({
        status: z
          .enum(["registered", "pending"])
          .optional()
          .default("registered")
          .describe("Contract status (default: registered)"),
        category: z
          .enum(["expense", "revenue", "all"])
          .optional()
          .default("expense")
          .describe(
            "Contract category (default: expense). Record field names follow the API's own " +
              "domain and differ by shape: registered expense/all use prime_contract_* names " +
              "(prime_contract_id, prime_contract_purpose, ...); registered revenue and every " +
              "pending search use plain names (contract_id, purpose, agency, ...). Records are " +
              "returned as the API sends them, not normalized."
          ),
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
              "(use vendor_code, or search_spending with payee_name for name search). " +
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
              "Live-verified 2026-07-28. purpose='software' returned 168 of 19,139 registered/expense FY2025."
          ),
        pin: z
          .string()
          .optional()
          .describe(
            "Contract PIN / tracking number. Live-verified 2026-07-28. An exact PIN returned exactly 1 record."
          ),
        registration_date_from: z
          .string()
          .optional()
          .describe(
            "Registration date range begin (YYYY-MM-DD). Registered contracts only. " +
              "Live-verified 2026-07-28."
          ),
        registration_date_to: z
          .string()
          .optional()
          .describe(
            "Registration date range end (YYYY-MM-DD). Registered contracts only. " +
              "Live-verified 2026-07-28. A 6-month range returned 9,599 of 19,139."
          ),
        received_date_from: z
          .string()
          .optional()
          .describe(
            "Received date range begin (YYYY-MM-DD). Pending contracts only (registered " +
              "use registration_date). Live-verified 2026-07-28. An open-ended range returned the full pending set."
          ),
        received_date_to: z
          .string()
          .optional()
          .describe(
            "Received date range end (YYYY-MM-DD). Pending contracts only. Live-verified 2026-07-28."
          ),
        contract_includes_sub_vendors: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe(
            "Sub-vendor flag: 1 = contracts that include sub-vendors. Registered contracts " +
              "only. Live-verified 2026-07-28. 1 returned 3,246 of 19,139 registered/expense FY2025; 0 returned 0. " +
              "This is an INTEGER, not a status code — the API rejects a non-numeric value " +
              "with \"is not of data type integer\", and it does so as HTTP 200 with a " +
              "plain-text (non-XML) body, which parses as an empty response. Note the " +
              "response column of the same name reports 'N/A', so an observed column value " +
              "cannot be fed back in as a filter value."
          ),
        include_sub_vendors: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include sub-vendor / subcontractor detail columns (sub_vendor, " +
              "sub_vendor_mwbe_category, sub_contract_current_amount, etc.) in the response. " +
              "Applies to registered expense/all contracts only; ignored for status='pending' " +
              "and for category='revenue', whose domains list no sub-vendor columns."
          ),
        page: pageSchema,
        page_size: pageSizeSchema,
      }, { vendor: VENDOR_ALIAS_HINT }),
    },
    async (input) =>
      guard(() => {
        if (input.vendor_name) {
          throw new Error(VENDOR_NAME_UNSUPPORTED_MESSAGE);
        }
        const criteria = contractsCriteria(input);
        if (isRegisteredRevenueFiscalYear(criteria)) {
          // Fail fast, no network call (#42 upstream limitation).
          throw new Error(REVENUE_FISCAL_YEAR_UNSUPPORTED_MESSAGE);
        }
        return runSearch(
          "Contracts",
          contractsColumns(criteria, input.include_sub_vendors),
          criteria,
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
        "Use this after finding a contract ID via search_contracts or search_spending. " +
        "Field names follow status/category, as in search_contracts: registered expense uses " +
        "prime_contract_* names, registered revenue and pending use plain names (contract_id, purpose, ...).",
      inputSchema: strictSchema({
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
      }),
    },
    async ({ contract_id, status, category }) =>
      guard(async () => {
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
          // Per (status, category), as search_contracts does (#42). Sending the
          // expense list for category=revenue failed every revenue lookup.
          response_columns: contractsColumns(criteria),
        });
        // No `error` field: an upstream failure throws (issue #21) and is
        // surfaced by guard(), so `records` is only ever a genuine result set.
        return textResult({ contract_id, records: result.records });
      })
  );

  server.registerTool(
    "search_spending",
    {
      description:
        "Search NYC spending (check) records. Filter by agency, payee, contract, date range, amount, or expense category. " +
        "Either fiscal_year or issue_date_from is required.",
      inputSchema: strictSchema({
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
      }),
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
      inputSchema: strictSchema({
        fiscal_year: fiscalYearSchema,
        agency_code: agencyCodeSchema,
        department_code: z.string().optional().describe("Department code"),
        budget_code: z.string().optional().describe("Budget code"),
        page: pageSchema,
        page_size: pageSizeSchema,
      }),
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
      inputSchema: strictSchema({
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
      }),
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
      inputSchema: strictSchema({
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
      }),
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
      inputSchema: strictSchema({
        agency_code: z
          .string()
          .describe("3-digit agency code, e.g. '858' for OTI/DoITT, '040' for NYPD"),
        fiscal_year: z.string().describe("Fiscal year, e.g. '2024'"),
        page: pageSchema,
        page_size: pageSizeSchema,
      }),
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
      inputSchema: strictSchema({
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
      }),
    },
    async (input) =>
      guard(() => {
        const criteria = nycedcContractsCriteria(input);
        return runSearch(
          "Contracts_OGE",
          nycedcContractsColumns(criteria),
          criteria,
          input.page,
          input.page_size
        );
      })
  );

  server.registerTool(
    "search_nycha_contracts",
    {
      description:
        "Search NYCHA (New York City Housing Authority) contracts (Checkbook domain Contracts_NYCHA). " +
        "These are separate from citywide contracts and are reported at release / line-item granularity " +
        "(purchase-order releases, funding source, program/project). Filter by fiscal year, vendor, " +
        "purchase-order type, responsibility center, contract type, industry, amount, and date ranges " +
        "(including approved date). Results carry a year field only when you filter by fiscal_year; " +
        "without fiscal_year they carry no year or fiscal-year field. When the year matters, filter by " +
        "fiscal_year (one call per year). start_date, end_date, and approved_date are per record.",
      inputSchema: strictSchema({
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
      }),
    },
    async (input) =>
      guard(() => {
        const criteria = nychaContractsCriteria(input);
        return runSearch(
          "Contracts_NYCHA",
          nychaContractsColumns(criteria),
          criteria,
          input.page,
          input.page_size
        );
      })
  );
}
