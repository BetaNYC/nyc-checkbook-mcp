import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRequestXml,
  parseResponse,
  classifySmartSearchResponse,
  DEFAULT_COLUMNS,
} from "../dist/checkbook.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(fixtures, name), "utf8");

// ─── XML request construction ────────────────────────────────────────────────

test("builds Budget request with 'year' criterion (not fiscal_year)", () => {
  const xml = buildRequestXml({
    type_of_data: "Budget",
    criteria: [{ name: "year", type: "value", value: "2026" }],
    response_columns: DEFAULT_COLUMNS.Budget,
  });
  assert.match(xml, /<type_of_data>Budget<\/type_of_data>/);
  assert.match(
    xml,
    /<criteria><name>year<\/name><type>value<\/type><value>2026<\/value><\/criteria>/
  );
  assert.doesNotMatch(xml, /fiscal_year/);
});

test("builds range criteria with start/end", () => {
  const xml = buildRequestXml({
    type_of_data: "Payroll",
    criteria: [
      { name: "fiscal_year", type: "value", value: "2026" },
      { name: "amount", type: "range", start: "100", end: "500000" },
    ],
  });
  assert.match(
    xml,
    /<criteria><name>amount<\/name><type>range<\/type><start>100<\/start><end>500000<\/end><\/criteria>/
  );
});

test("escapes XML special characters in values", () => {
  const xml = buildRequestXml({
    type_of_data: "Contracts",
    criteria: [{ name: "prime_vendor", type: "value", value: "A&B <Co>" }],
  });
  assert.match(xml, /<value>A&amp;B &lt;Co&gt;<\/value>/);
});

test("emits response_columns as <column> elements", () => {
  const xml = buildRequestXml({
    type_of_data: "Revenue",
    response_columns: ["agency", "recognized"],
  });
  assert.match(
    xml,
    /<response_columns><column>agency<\/column><column>recognized<\/column><\/response_columns>/
  );
});

// ─── Documented criteria/column names per domain ─────────────────────────────
// Valid names enumerated by the live API's 1101 error messages (2026-07-06).

const VALID_BUDGET_CRITERIA = [
  "year", "budget_code", "budget_code_id", "budget_code_name", "agency_code",
  "department_code", "expense_category", "adopted", "modified",
  "pre_encumbered", "encumbered", "accrued_expense", "cash_expense",
  "conditional_category", "post_adjustment",
];
const VALID_PAYROLL_CRITERIA = [
  "fiscal_year", "calendar_year", "agency_code", "pay_frequency", "pay_date",
  "amount", "amount_type", "gross_pay", "base_pay", "other_payments",
  "overtime_payments", "gross_pay_ytd", "title", "title_exact",
];
const VALID_REVENUE_CRITERIA = [
  "budget_fiscal_year", "fiscal_year", "agency_code", "revenue_class",
  "revenue_class_name", "fund_class", "funding_class", "revenue_category",
  "revenue_source", "conditional_category", "revenue_source_name",
  "recognized", "adopted", "modified",
];

// Response tag names observed in live API responses (2026-07-06).
const OBSERVED_BUDGET_COLUMNS = [
  "agency", "year", "department", "expense_category", "budget_code",
  "budget_name", "modified", "adopted", "committed", "pre_encumbered",
  "encumbered", "cash_expense", "post_adjustment", "accrued_expense",
];
const OBSERVED_PAYROLL_COLUMNS = [
  "agency", "title", "pay_frequency", "pay_date", "payroll_type",
  "annual_salary", "hourly_rate", "gross_pay", "base_pay", "other_payments",
  "overtime_payments", "gross_pay_ytd", "fiscal_year", "calendar_year",
];
const OBSERVED_REVENUE_COLUMNS = [
  "agency", "revenue_category", "revenue_source", "fund_class",
  "funding_class", "revenue_class", "budget_fiscal_year", "fiscal_year",
  "adopted", "modified", "recognized", "closing_classification_name",
];

test("Budget default columns are all documented names", () => {
  for (const col of DEFAULT_COLUMNS.Budget) {
    assert.ok(OBSERVED_BUDGET_COLUMNS.includes(col), `invalid Budget column: ${col}`);
  }
  assert.ok(VALID_BUDGET_CRITERIA.includes("year"));
});

test("Payroll default columns are all documented names and contain no name fields", () => {
  for (const col of DEFAULT_COLUMNS.Payroll) {
    assert.ok(OBSERVED_PAYROLL_COLUMNS.includes(col), `invalid Payroll column: ${col}`);
  }
  assert.ok(!DEFAULT_COLUMNS.Payroll.includes("last_name"));
  assert.ok(!DEFAULT_COLUMNS.Payroll.includes("first_name"));
  assert.ok(!DEFAULT_COLUMNS.Payroll.includes("base_salary"));
  assert.ok(!VALID_PAYROLL_CRITERIA.includes("last_name"));
});

test("Revenue default columns are all documented names and exclude budget_code", () => {
  for (const col of DEFAULT_COLUMNS.Revenue) {
    assert.ok(OBSERVED_REVENUE_COLUMNS.includes(col), `invalid Revenue column: ${col}`);
  }
  assert.ok(!DEFAULT_COLUMNS.Revenue.includes("budget_code"));
  assert.ok(!VALID_REVENUE_CRITERIA.includes("budget_code"));
});

// ─── Response parsing + numeric coercion ─────────────────────────────────────

test("parses a real Budget response fixture", () => {
  const res = parseResponse(fixture("budget-response.xml"));
  assert.equal(res.success, true);
  assert.equal(res.total_records, 12397);
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].agency, "Department of Parks and Recreation");
});

test("preserves leading zeros and long IDs (no numeric coercion)", () => {
  const xml = `<?xml version="1.0"?><response><status><result>success</result></status>
    <result_records><record_count>1</record_count><spending_transactions><transaction>
      <agency_code>040</agency_code>
      <document_id>20260140001234567890</document_id>
      <check_amount>123.45</check_amount>
    </transaction></spending_transactions></result_records></response>`;
  const res = parseResponse(xml);
  assert.equal(res.records[0].agency_code, "040");
  assert.equal(res.records[0].document_id, "20260140001234567890");
  assert.equal(res.records[0].check_amount, "123.45");
});

test("surfaces API failure messages", () => {
  const xml = `<?xml version="1.0"?><response><status><result>failure</result>
    <messages><message><code>1101</code><description>Provided request parameter 'budget_code' is not valid for 'Revenue' domain.</description></message></messages>
    </status></response>`;
  const res = parseResponse(xml);
  assert.equal(res.success, false);
  assert.match(res.error, /not valid for 'Revenue' domain/);
});

// ─── smart_search response classification ────────────────────────────────────
// Fixtures are the actual responses observed live on 2026-07-06.

test("classifies the real Incapsula 403 block page as unusable", () => {
  const html = fixture("smart-search-incapsula-403.html");
  const check = classifySmartSearchResponse(403, html);
  assert.equal(check.usable, false);
  assert.match(check.reason, /WAF/);
});

test("classifies the Incapsula block page as unusable even with HTTP 200", () => {
  const html = fixture("smart-search-incapsula-403.html");
  const check = classifySmartSearchResponse(200, html);
  assert.equal(check.usable, false);
  assert.match(check.reason, /Incapsula/);
});

test("classifies the 'Loading' interstitial as unusable", () => {
  const html = fixture("smart-search-loading-302.html");
  const check = classifySmartSearchResponse(200, html);
  assert.equal(check.usable, false);
});

test("classifies HTML with no transaction data as unusable", () => {
  const check = classifySmartSearchResponse(200, "<html><body>Search results</body></html>");
  assert.equal(check.usable, false);
  assert.match(check.reason, /client-side/);
});

test("classifies server-rendered transaction text as usable", () => {
  const check = classifySmartSearchResponse(
    200,
    "TRANSACTION #1: Contracts\nAGENCY: Parks\nShowing: 1 to 1 of 1 entries"
  );
  assert.equal(check.usable, true);
});
