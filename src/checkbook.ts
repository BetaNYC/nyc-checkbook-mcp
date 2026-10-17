/**
 * Checkbook NYC API client
 *
 * Wraps the XML-based POST API at https://www.checkbooknyc.com/api
 * and the smart search web endpoint at /smart_search/citywide
 *
 * Docs: https://www.checkbooknyc.com/data-feeds/api
 */

import { XMLParser } from "fast-xml-parser";
import { VERSION } from "./version.js";

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

export type DataDomain =
  | "Contracts"
  | "Contracts_OGE"
  | "Contracts_NYCHA"
  | "Spending"
  | "Budget"
  | "Payroll"
  | "Revenue";

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

/**
 * A SUCCESSFUL Checkbook API call. Deliberately carries no `total_records` or
 * `records` on any failure path — failures throw `CheckbookApiError` instead
 * (issue #21). This is the type-level guarantee that an upstream error can never
 * be reported as `total_records: 0` ("unreachable" misread as "no records exist").
 */
export interface ApiSuccess {
  total_records: number;
  records: Record<string, unknown>[];
}

/**
 * Raised for ANY Checkbook API failure — network/timeout, a non-2xx HTTP status
 * (incl. a 403 block or an unfollowed 3xx redirect), or an API-level failure
 * status in the XML. Thrown rather than returned so the count-bearing success
 * shape is never populated on an error (issue #21). The MCP tool layer's `guard()`
 * wrapper turns it into an `isError` result, so a model sees a surfaced error,
 * not an empty result set.
 */
export class CheckbookApiError extends Error {
  readonly status?: number;
  readonly kind: "network" | "redirect" | "http" | "api";
  constructor(message: string, opts: { status?: number; kind: CheckbookApiError["kind"] }) {
    super(message);
    this.name = "CheckbookApiError";
    this.status = opts.status;
    this.kind = opts.kind;
  }
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

// Version derived from package.json in one place (issue #22) so the UA can never
// again drift from the McpServer version / published package. This UA is how the
// Comptroller's office identifies our traffic, so it must be truthful.
const USER_AGENT = `betanyc-checkbook-mcp/${VERSION} (github.com/BetaNYC/nyc-checkbook-mcp)`;
const REQUEST_TIMEOUT_MS = 60_000;

// ─── Rate pacing ─────────────────────────────────────────────────────────────

// The Comptroller's office rate-limits this API to 1 request per second
// (confirmed by their team, 2026-07-28; documented nowhere on checkbooknyc.com).
// Exceeding it does not throttle: their Imperva edge places the client into a
// blocked state that persists past the burst and returns 403 to every client on
// that IP, a browser included.
//
// This is distinct from the retry backoff below. Backoff spaces *retries of one
// call*; the pacer spaces *all calls*, including unrelated ones issued back to
// back by different tools. Both are needed.
const MIN_REQUEST_INTERVAL_MS = 1_100; // 100ms of headroom for clock skew

let paceChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Serializes every outbound request and spaces them at least
 * MIN_REQUEST_INTERVAL_MS apart, process-wide. Awaited before each fetch,
 * including retries, so no code path can burst.
 *
 * KNOWN LIMITATION (issue #28): per-process only. Two clients running at once
 * can still exceed the limit, and no in-process fix addresses that. Whether it
 * matters depends on whether the limit is scoped per IP or per client, which is
 * an open question for the Comptroller's office.
 */
async function schedule(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export function pace(): Promise<void> {
  // .then(schedule, schedule) — the onRejected arm is load-bearing. With only the
  // onFulfilled arm, one rejection anywhere in the chain leaves paceChain
  // permanently rejected, and every later request fails forever with an unrelated
  // error until the process restarts. Pacing must survive its own predecessor.
  paceChain = paceChain.then(schedule, schedule);
  return paceChain;
}

/**
 * Retry policy for {@link fetchWithRetry}. Deliberately conservative: the point
 * of issues #23/#24 is to REDUCE load on a government edge that is actively
 * blocking us, so we cap attempts tightly and always space them out.
 */
export interface RetryPolicy {
  /** Total attempts including the first (so 3 = initial + 2 retries). */
  maxAttempts: number;
  /** Base backoff before jitter, doubled each attempt. */
  baseDelayMs: number;
  /** Ceiling on a single backoff delay (before honoring Retry-After). */
  maxDelayMs: number;
  /** Overall budget for SCHEDULING retries — a new attempt is not started past this. */
  deadlineMs: number;
  /** Per-request timeout (AbortSignal). */
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  deadlineMs: 120_000,
  timeoutMs: REQUEST_TIMEOUT_MS,
};

/** Injection seam for tests ONLY — production uses the real fetch/clock/timers. */
export interface RetryDeps {
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  nowImpl: () => number;
  randomImpl: () => number;
  makeSignal: () => AbortSignal | undefined;
  /** Rate pacer. Injected as a no-op in unit tests so they need no real sleeps. */
  paceImpl: () => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A 3xx we deliberately did NOT follow (issue #23).
 *
 * Node/undici returns the ACTUAL 3xx response for `redirect: "manual"` — real
 * status code (e.g. 302) and inspectable `Location` — NOT a browser-style
 * opaqueredirect. Verified against undici source: "On the web this would return
 * an `opaqueredirect` response, but that doesn't make sense server side"
 * (https://github.com/nodejs/undici/issues/1193). We still defensively match a
 * spec-compliant opaqueredirect (status 0, type set) so the guard holds on any
 * runtime.
 */
export function isRedirectResponse(response: { status: number; type?: string }): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status <= 399);
}

/**
 * Equal-jitter exponential backoff (issue #24). `attempt` is 1-based.
 *
 *   expo  = min(maxDelayMs, baseDelayMs * 2^(attempt-1))
 *   delay = expo/2 + random()*(expo/2)     → always ≥ expo/2 > 0
 *
 * Equal jitter (rather than full jitter) keeps a guaranteed non-zero floor — so
 * there is never an "immediate" retry — while still de-correlating concurrent
 * clients. Algorithm: AWS Architecture Blog, "Exponential Backoff And Jitter".
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random
): number {
  const expo = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return expo / 2 + random() * (expo / 2);
}

/**
 * Parse a `Retry-After` header to milliseconds of delay, or undefined if absent
 * or unparseable. Per RFC 9110 §10.2.3 / MDN, the value is EITHER `delay-seconds`
 * (a non-negative integer) OR an `HTTP-date`. Never returns a negative delay.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  now: () => number = Date.now
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000; // delay-seconds
  const dateMs = Date.parse(trimmed); // HTTP-date
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - now());
}

/**
 * POST/GET with retries that BACK OFF (issue #24) and do NOT follow redirects
 * (issue #23).
 *
 * - `redirect: "manual"` — a 3xx is surfaced, never chased. One logical call was
 *   measured fanning out to ~40 requests against the Checkbook edge before a
 *   terminal 403; that amplification is the harm this closes.
 * - Retries ONLY on 5xx and network/timeout errors (the original trigger set),
 *   but now with equal-jitter exponential backoff, an attempt cap, and an overall
 *   deadline. Immediate zero-backoff retry is exactly the pattern the API
 *   operator named as their block trigger.
 * - NEVER retries a 4xx — 403 is an answer, not a transient failure.
 * - Honors `Retry-After` on a retryable 5xx when present.
 *
 * Returns the terminal Response (2xx, 4xx, or an unfollowed 3xx/5xx); the caller
 * decides what is an error. Rejects only when every attempt hit a network error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: Partial<RetryDeps> = {}
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const now = deps.nowImpl ?? Date.now;
  const random = deps.randomImpl ?? Math.random;
  const makeSignal = deps.makeSignal ?? (() => AbortSignal.timeout(policy.timeoutMs));
  const paceImpl = deps.paceImpl ?? pace;

  const start = now();
  let lastError: unknown;

  /** Sleep before the next attempt if budget remains; false = give up now. */
  const backoffOrGiveUp = async (attempt: number, delayMs: number): Promise<boolean> => {
    if (attempt >= policy.maxAttempts) return false;
    if (now() - start + delayMs > policy.deadlineMs) return false;
    await sleepImpl(delayMs);
    return true;
  };

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    let response: Response;
    try {
      // Rate pacing applies to every attempt, not just the first: a retry is
      // still a request against the 1 req/sec budget.
      await paceImpl();
      response = await fetchImpl(url, { ...init, redirect: "manual", signal: makeSignal() });
    } catch (err) {
      // Network error / per-request timeout — retryable.
      lastError = err;
      if (!(await backoffOrGiveUp(attempt, computeBackoffMs(attempt, policy, random)))) break;
      continue;
    }

    if (isRedirectResponse(response)) return response; // #23: never follow, never retry
    if (response.status >= 400 && response.status <= 499) return response; // #24: never retry 4xx

    if (response.status >= 500) {
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      const delayMs =
        parseRetryAfterMs(response.headers.get("retry-after"), now) ??
        computeBackoffMs(attempt, policy, random);
      if (!(await backoffOrGiveUp(attempt, delayMs))) return response; // out of budget → surface the 5xx
      continue;
    }

    return response; // 2xx
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Call the Checkbook XML API. Returns records on success; THROWS
 * {@link CheckbookApiError} on any failure (issue #21) — never a zero-count
 * "success". A genuinely empty-but-successful result still returns
 * `{ total_records: 0, records: [] }`; only errors throw, so "no matches" and
 * "unreachable" are no longer conflated.
 */
export async function callCheckbookApi(req: ApiRequest): Promise<ApiSuccess> {
  const body = buildRequestXml(req);

  let response: Response;
  try {
    response = await fetchWithRetry(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
      body,
    });
  } catch (err) {
    throw new CheckbookApiError(
      `Request to Checkbook NYC failed: ${err instanceof Error ? err.message : String(err)}`,
      { kind: "network" }
    );
  }

  if (isRedirectResponse(response)) {
    throw new CheckbookApiError(
      `Checkbook NYC returned an unexpected redirect (HTTP ${response.status || "opaque"}) which this client does not follow; the endpoint is likely behind a WAF/interstitial. This is an error, not an empty result set.`,
      { status: response.status, kind: "redirect" }
    );
  }

  if (!response.ok) {
    throw new CheckbookApiError(
      `Checkbook NYC returned HTTP ${response.status}: ${response.statusText}. This is an error, not an empty result set.`,
      { status: response.status, kind: "http" }
    );
  }

  const parsed = parseResponse(await response.text());
  if (!parsed.success) {
    throw new CheckbookApiError(parsed.error ?? "Unknown Checkbook API error", { kind: "api" });
  }
  return { total_records: parsed.total_records, records: parsed.records };
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
  "Use the structured tools instead (search_spending with payee_name for checks " +
  "paid to a vendor by name, or search_contracts with vendor_code / agency_code " +
  "— note contracts have no vendor-name filter), or browse the search in a web " +
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
    // NOTE: "year" is intentionally NOT a response column for the citywide
    // Registered Contracts domain. The live API ('Registered Contracts(expense)
    // All Years') rejects it — "Provided response column 'year' value is not
    // allowed ... Valid values are '...prime_contract_id,...prime_vendor,...'"
    // (observed 2026-07-16, issue #16). The domain's response vocabulary is the
    // prime_contract_* / prime_vendor set.
    // Added v1.2.0 — documented Contracts response columns confirmed against
    // https://www.checkbooknyc.com/contract-api (2026-07-09). WBE/EBE flags
    // (issue #9) and low-priority lineage/registration columns (issue #10).
    "prime_woman_owned_business",
    "prime_emerging_business",
    "mocs_registered",
    "contract_class",
    "parent_contract_id",
    "prime_contract_version",
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
  // NYCEDC / Other Government Entities (OGE) contracts. Domain token
  // "Contracts_OGE"; supports registered expense contracts only. Derived from
  // the CheckbookNYC API config (checkbook_api/src/config/contracts_oge.json,
  // rowElements, 2026-07-09), then corrected against the live API (issue #40):
  // the config lists "apt_pin". The live API rejected it on a fiscal_year search
  // ('Registered Contracts_oge(expense)', 2026-10-15) and lists it as valid
  // without fiscal_year ('... All Years', probe 2026-10-16). This base list is
  // what every call shape sends; one rejected column fails the whole call, so do
  // NOT add "apt_pin" here. It is appended only for calls without fiscal_year, by
  // nycedcContractsColumns() / OGE_ALL_YEARS_COLUMNS in tools.ts. "year" is
  // valid in both. Check changes with scripts/check-default-columns.mjs, not
  // against the config.
  Contracts_OGE: [
    "other_government_entities",
    "prime_vendor",
    "contract_id",
    "version",
    "year",
    "parent_contract_id",
    "purpose",
    "original_amount",
    "current_amount",
    "spent_to_date",
    "pin",
    "contract_type",
    "award_method",
    "expense_category",
    "start_date",
    "end_date",
    "document_code",
    "contract_industry",
    "commodity_line",
    "entity_contract_number",
    "budget_name",
  ],
  // NYCHA (New York City Housing Authority) contracts. Domain token
  // "Contracts_NYCHA"; release/line-item granularity. Derived from the
  // CheckbookNYC API config (checkbook_api/src/config/contracts_nycha.json,
  // rowElements, 2026-07-09), then corrected against the live API (issue #40):
  // the config lists "year". The live API rejected it on a vendor_name-only
  // search (2026-10-15) and lists it as valid with fiscal_year (probe
  // 2026-10-16). This base list is what every call shape sends; one rejected
  // column fails the whole call, so do NOT add "year" here. It is appended only
  // for calls with fiscal_year, by nychaContractsColumns() /
  // NYCHA_FISCAL_YEAR_COLUMNS in tools.ts, so results carry year only then.
  // Check changes with scripts/check-default-columns.mjs, not against the config.
  Contracts_NYCHA: [
    "contract_id",
    "purchase_order_type",
    "record_type",
    "number_of_releases",
    "quantity_ordered",
    "release_number",
    "item_description",
    "item_category",
    "shipment_number",
    "start_date",
    "end_date",
    "approved_date",
    "line_current_amount",
    "line_number",
    "line_original_amount",
    "line_invoiced_amount",
    "release_current_amount",
    "release_original_amount",
    "release_invoiced_amount",
    "contract_current_amount",
    "contract_original_amount",
    "contract_invoiced_amount",
    "purpose",
    "vendor",
    "location",
    "contract_type",
    "award_method",
    "grant_name",
    "expenditure_type",
    "industry",
    "funding_source",
    "responsibility_center",
    "pin",
    "program",
    "project",
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
