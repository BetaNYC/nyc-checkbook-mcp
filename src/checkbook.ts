/**
 * Checkbook NYC API client
 *
 * Wraps the XML-based POST API at https://www.checkbooknyc.com/api
 * and the smart search web endpoint at /smart_search/citywide
 *
 * Docs: https://www.checkbooknyc.com/data-feeds/api
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";

const API_ENDPOINT = "https://www.checkbooknyc.com/api";
const SMART_SEARCH_ENDPOINT = "https://www.checkbooknyc.com/smart_search/citywide";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  format: false,
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type DataDomain =
  | "Contracts"
  | "Contracts_OGE"
  | "Contracts_NYCHA"
  | "Spending"
  | "Spending_OGE"
  | "Spending_NYCHA"
  | "Budget"
  | "Payroll"
  | "Payroll_NYCHA"
  | "Revenue";

export type CriteriaType = "value" | "range";

export interface Criteria {
  name: string;
  type: CriteriaType;
  value?: string;
  start?: string;
  end?: string;
}

export interface ApiRequest {
  type_of_data: DataDomain;
  records_from?: number;
  max_records?: number;
  criteria?: Criteria[];
  response_columns?: string[];
}

export interface ApiResponse {
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

function buildRequestXml(req: ApiRequest): string {
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

function parseResponse(xmlText: string): ApiResponse {
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

export async function callCheckbookApi(req: ApiRequest): Promise<ApiResponse> {
  const body = buildRequestXml(req);

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body,
  });

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

export interface SmartSearchResult {
  type: string;
  fields: Record<string, string>;
}

export async function smartSearch(
  query: string,
  limit = 25
): Promise<{ total: number; results: SmartSearchResult[] }> {
  const url = `${SMART_SEARCH_ENDPOINT}?search_term=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: { Accept: "text/html" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();

  // Parse results from the page text — extract structured transaction blocks
  const results: SmartSearchResult[] = [];

  // Match TRANSACTION blocks
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

  // Extract total count from "Showing: X to Y of Z entries"
  const countMatch = html.match(/Showing:\s*\d+\s*to\s*\d+\s*of\s*(\d+)\s*entries/i);
  const total = countMatch ? parseInt(countMatch[1], 10) : results.length;

  return { total, results };
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
  Budget: [
    "agency_name",
    "department_name",
    "expense_category",
    "adopted_budget",
    "modified_budget",
    "pre_encumbered",
    "encumbered",
    "accrued_expense",
    "cash_expense",
    "post_adjustment",
    "year",
    "budget_code",
  ],
  Payroll: [
    "agency_name",
    "last_name",
    "first_name",
    "title",
    "base_salary",
    "pay_date",
    "amount",
    "other_payments",
    "year",
  ],
  Revenue: [
    "agency_name",
    "revenue_category",
    "revenue_class",
    "budget_code",
    "adopted_budget",
    "modified_budget",
    "recognized",
    "year",
  ],
};
