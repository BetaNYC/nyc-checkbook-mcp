/**
 * Checkbook NYC API client
 *
 * Wraps the XML-based POST API at https://www.checkbooknyc.com/api
 * and the smart search web endpoint at /smart_search/citywide
 *
 * Docs: https://www.checkbooknyc.com/data-feeds/api
 */

import { XMLParser } from "fast-xml-parser";

const API_ENDPOINT = "https://www.checkbooknyc.com/api";
const SMART_SEARCH_ENDPOINT = "https://www.checkbooknyc.com/smart_search/citywide";

// parseTagValue must stay false: numeric-looking codes ("040" agency codes,
// long contract/document IDs) would otherwise be coerced to numbers, dropping
// leading zeros and losing precision. All values are returned as strings.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type DataDomain = "Contracts" | "Spending" | "Budget" | "Payroll" | "Revenue";

type CriteriaType = "value" | "range";

export interface Criteria {
  name: string;
  type: CriteriaType;
  value?: string;
  start?: string;
  end?: string;
}

interface ApiRequest {
  type_of_data: DataDomain;
  records_from?: number;
  max_records?: number;
  criteria?: Criteria[];
  response_columns?: string[];
}

interface ApiResponse {
  success: boolean;
  total_records: number;
  records: Record<string, unknown>[];
  error?: string;
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

/** Encode special XML characters in string values */
function encodeXmlValue(val: string): string {
  return val
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildRequestXml(req: ApiRequest): string {
  const criteriaXml = (req.criteria ?? [])
    .map((c) => {
      if (c.type === "range") {
        return `<criteria><name>${c.name}</name><type>range</type><start>${encodeXmlValue(c.start ?? "")}</start><end>${encodeXmlValue(c.end ?? "")}</end></criteria>`;
      }
      return `<criteria><name>${c.name}</name><type>value</type><value>${encodeXmlValue(c.value ?? "")}</value></criteria>`;
    })
    .join("");

  const columnsXml = (req.response_columns ?? [])
    .map((col) => `<column>${col}</column>`)
    .join("");

  return `<request><type_of_data>${req.type_of_data}</type_of_data><records_from>${req.records_from ?? 1}</records_from><max_records>${req.max_records ?? 1000}</max_records>${criteriaXml ? `<search_criteria>${criteriaXml}</search_criteria>` : ""}${columnsXml ? `<response_columns>${columnsXml}</response_columns>` : ""}</request>`;
}

export function parseResponse(xmlText: string): ApiResponse {
  try {
    const parsed = xmlParser.parse(xmlText);
    const response = parsed?.response;

    if (!response) {
      return { success: false, total_records: 0, records: [], error: "Empty response" };
    }

    const status = response?.status?.result;
    if (status !== "success") {
      const messages = response?.status?.messages?.message;
      const errMsg = Array.isArray(messages)
        ? messages.map((m: Record<string, unknown>) => m.description).join("; ")
        : messages?.description ?? "Unknown error";
      return { success: false, total_records: 0, records: [], error: errMsg };
    }

    const resultRecords = response?.result_records;
    if (!resultRecords) {
      return { success: true, total_records: 0, records: [] };
    }

    const totalRecords = parseInt(String(resultRecords?.record_count ?? "0"), 10);

    // Extract the transaction array — key name varies by domain
    const transactionKey = Object.keys(resultRecords).find((k) => k !== "record_count");
    if (!transactionKey) {
      return { success: true, total_records: totalRecords, records: [] };
    }

    const transactions = resultRecords[transactionKey];
    const transactionArray: Record<string, unknown>[] = [];

    if (transactions && typeof transactions === "object") {
      const inner = (transactions as Record<string, unknown>)["transaction"];
      if (Array.isArray(inner)) {
        transactionArray.push(...inner);
      } else if (inner && typeof inner === "object") {
        transactionArray.push(inner as Record<string, unknown>);
      }
    }

    return { success: true, total_records: totalRecords, records: transactionArray };
  } catch (err) {
    return {
      success: false,
      total_records: 0,
      records: [],
      error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Core API call ────────────────────────────────────────────────────────────

const USER_AGENT =
  "betanyc-checkbook-mcp/1.0.1 (github.com/BetaNYC/nyc-checkbook-mcp)";
const REQUEST_TIMEOUT_MS = 60_000;

/** POST with a 60s timeout; retries once on 5xx or network failure. */
async function fetchWithRetry(
  url: string,
  init: RequestInit
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 500 && attempt === 0) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt === 1) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function callCheckbookApi(req: ApiRequest): Promise<ApiResponse> {
  const body = buildRequestXml(req);

  let response: Response;
  try {
    response = await fetchWithRetry(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
      body,
    });
  } catch (err) {
    return {
      success: false,
      total_records: 0,
      records: [],
      error: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      success: false,
      total_records: 0,
      records: [],
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  }

  const text = await response.text();
  return parseResponse(text);
}

// ─── Smart search (web endpoint) ─────────────────────────────────────────────

interface SmartSearchResult {
  type: string;
  fields: Record<string, string>;
}

export interface SmartSearchOutcome {
  available: boolean;
  total: number;
  results: SmartSearchResult[];
  reason?: string;
  fallback?: string;
}

/**
 * Detect whether a smart_search HTTP response is usable server-side.
 *
 * Verified live 2026-07-06: checkbooknyc.com fronts /smart_search with an
 * Imperva/Incapsula WAF that answers non-browser clients with a JavaScript
 * challenge (302 "Loading" interstitial, then 403 with an _Incapsula_Resource
 * iframe). The results grid itself is also rendered client-side by
 * JavaScript, so even a passed challenge would return no data in the raw
 * HTML. This function classifies those failure shapes.
 */
export function classifySmartSearchResponse(
  status: number,
  html: string
): { usable: boolean; reason?: string } {
  if (status >= 400) {
    return { usable: false, reason: `HTTP ${status} (WAF challenge or error)` };
  }
  if (/_Incapsula_Resource|Incapsula incident ID/i.test(html)) {
    return { usable: false, reason: "Blocked by Incapsula WAF JavaScript challenge" };
  }
  if (!/TRANSACTION #\d+:/.test(html)) {
    return {
      usable: false,
      reason: "Response contains no result data (results are rendered client-side by JavaScript)",
    };
  }
  return { usable: true };
}

const SMART_SEARCH_UNAVAILABLE_FALLBACK =
  "Use the structured tools instead (search_contracts with vendor_name, " +
  "search_spending with payee_name, etc.), or browse the search in a web " +
  "browser at https://www.checkbooknyc.com/smart_search";

/**
 * Attempt a smart search against the Checkbook NYC web endpoint.
 *
 * NOTE: as of 2026-07-06 this endpoint is not usable server-side (Incapsula
 * WAF JS challenge + client-side-rendered results). The request is still
 * attempted in case access is restored, but callers should expect
 * `available: false` with a structured reason and fallback guidance.
 */
export async function smartSearch(
  query: string,
  limit = 25
): Promise<SmartSearchOutcome> {
  const url = `${SMART_SEARCH_ENDPOINT}?search_term=${encodeURIComponent(query)}`;

  let status: number;
  let html: string;
  try {
    const response = await fetchWithRetry(url, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
    });
    status = response.status;
    html = await response.text();
  } catch (err) {
    return {
      available: false,
      total: 0,
      results: [],
      reason: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      fallback: SMART_SEARCH_UNAVAILABLE_FALLBACK,
    };
  }

  const check = classifySmartSearchResponse(status, html);
  if (!check.usable) {
    return {
      available: false,
      total: 0,
      results: [],
      reason: check.reason,
      fallback: SMART_SEARCH_UNAVAILABLE_FALLBACK,
    };
  }

  // Best-effort parse if the endpoint ever returns server-rendered results.
  const results: SmartSearchResult[] = [];
  const transactionPattern =
    /TRANSACTION #\d+:\s*(\w+[\w\s]*?)\n([\s\S]*?)(?=TRANSACTION #\d+:|Showing:|$)/g;

  let match;
  while ((match = transactionPattern.exec(html)) !== null && results.length < limit) {
    const type = match[1].trim();
    const block = match[2];

    const fields: Record<string, string> = {};
    const fieldPattern = /^([A-Z][A-Z\s\/]+?):\s*(.+)$/gm;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(block)) !== null) {
      fields[fieldMatch[1].trim()] = fieldMatch[2].trim();
    }

    if (Object.keys(fields).length > 0) {
      results.push({ type, fields });
    }
  }

  const countMatch = html.match(/Showing:\s*\d+\s*to\s*\d+\s*of\s*(\d+)\s*entries/i);
  const total = countMatch ? parseInt(countMatch[1], 10) : results.length;

  return { available: true, total, results };
}

// ─── Default response columns per domain ────────────────────────────────────

export const DEFAULT_COLUMNS: Record<string, string[]> = {
  Contracts: [
    "prime_contract_id",
    "prime_vendor",
    "prime_contract_purpose",
    "prime_contracting_agency",
    "prime_contract_current_amount",
    "prime_contract_original_amount",
    "prime_vendor_spent_to_date",
    "prime_contract_start_date",
    "prime_contract_end_date",
    "prime_contract_award_method",
    "prime_contract_type",
    "prime_vendor_mwbe_category",
    "prime_contract_industry",
    "prime_contract_pin",
    "year",
  ],
  Contracts_pending: [
    "contract_id",
    "prime_vendor",
    "purpose",
    "agency",
    "current_amount",
    "original_amount",
    "start_date",
    "end_date",
    "award_method",
    "contract_type",
    "industry",
    "pin",
    "received_date",
  ],
  Spending: [
    "agency",
    "payee_name",
    "contract_id",
    "contract_purpose",
    "check_amount",
    "issue_date",
    "expense_category",
    "spending_category",
    "document_id",
    "mwbe_category",
    "fiscal_year",
    "budget_code",
  ],
  // Budget/Payroll/Revenue column names verified live against the API
  // (2026-07-06): invalid names are rejected with error code 1101.
  Budget: [
    "agency",
    "department",
    "expense_category",
    "budget_code",
    "budget_name",
    "adopted",
    "modified",
    "committed",
    "pre_encumbered",
    "encumbered",
    "accrued_expense",
    "cash_expense",
    "post_adjustment",
    "year",
  ],
  Payroll: [
    "agency",
    "title",
    "pay_frequency",
    "pay_date",
    "payroll_type",
    "annual_salary",
    "hourly_rate",
    "gross_pay",
    "base_pay",
    "other_payments",
    "overtime_payments",
    "gross_pay_ytd",
    "fiscal_year",
    "calendar_year",
  ],
  Revenue: [
    "agency",
    "revenue_category",
    "revenue_source",
    "revenue_class",
    "fund_class",
    "funding_class",
    "budget_fiscal_year",
    "fiscal_year",
    "adopted",
    "modified",
    "recognized",
  ],
};
