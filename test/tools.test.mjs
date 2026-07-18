import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerTools,
  contractsCriteria,
  valueCriteria,
  rangeCriterion,
  contractsColumns,
  SUB_VENDOR_COLUMNS,
  VENDOR_NAME_UNSUPPORTED_MESSAGE,
  UNVERIFIED_CONTRACT_FILTERS_MESSAGE,
  CONTRACT_UNVERIFIED_FILTER_KEYS,
  suppliedUnverifiedContractFilters,
  unverifiedContractFiltersEnabled,
  nycedcContractsCriteria,
  nychaContractsCriteria,
} from "../dist/tools.js";
import { DEFAULT_COLUMNS, buildRequestXml } from "../dist/checkbook.js";

// Request parameters the citywide Registered Contracts domain actually accepts,
// transcribed from the CheckbookNYC API config requestParameters for
// contracts_active_expense (superset incl. fiscal_year) and
// contracts_active_expense_all_years, and corroborated by the live API's own
// valid-values error (issue #16, 2026-07-16). Notably ABSENT: any vendor-name
// param (prime_vendor / associated_prime_vendor) — vendors filter by vendor_code.
const VALID_CONTRACTS_CRITERIA = new Set([
  "fiscal_year",
  "agency_code",
  "vendor_code",
  "current_amount",
  "spent_to_date",
  "award_method",
  "expense_category",
  "contract_id",
  "conditional_category",
  "contract_type",
  "start_date",
  "end_date",
  "registration_date",
  "status",
  "category",
  "purpose",
  "pin",
  "apt_pin",
  "mwbe_category",
  "industry",
  "sub_contract_status",
  "contract_includes_sub_vendors",
]);

const EXPECTED_TOOLS = [
  "smart_search",
  "search_contracts",
  "get_contract",
  "search_spending",
  "search_budget",
  "search_payroll",
  "search_revenue",
  "get_agency_spending",
  "search_nycedc_contracts",
  "search_nycha_contracts",
];

test("tools/list exposes the expected tool names", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());

  // Every tool keeps a description and an object input schema
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} has description`);
    assert.equal(tool.inputSchema.type, "object");
  }

  // Spot-check required fields survived the migration
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.smart_search.inputSchema.required, ["query"]);
  assert.deepEqual(byName.get_contract.inputSchema.required, ["contract_id"]);
  assert.deepEqual(
    [...byName.get_agency_spending.inputSchema.required].sort(),
    ["agency_code", "fiscal_year"]
  );

  await client.close();
  await server.close();
});

test("contractsCriteria builds value + range criteria (vendor filtered by vendor_code)", () => {
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    fiscal_year: "2024",
    vendor_code: "ACME123",
    amount_min: 1000,
    start_date_from: "2023-01-01",
  });

  assert.deepEqual(criteria, [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
    { name: "fiscal_year", type: "value", value: "2024" },
    { name: "vendor_code", type: "value", value: "ACME123" },
    { name: "current_amount", type: "range", start: "1000", end: "99999999999" },
    { name: "start_date", type: "range", start: "2023-01-01", end: "2099-12-31" },
  ]);
});

// ─── issue #16: vendor-name request-param + 'year' response-column bug ─────────

test("contractsCriteria never emits an invalid 'prime_vendor' criterion for vendor_name (#16)", () => {
  // The historic bug mapped vendor_name → request param prime_vendor, which the
  // Registered Contracts domain rejects. vendor_name must NOT become a criterion.
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    vendor_name: "Association of Community Employment",
  });
  assert.ok(
    !criteria.some((c) => c.name === "prime_vendor"),
    "prime_vendor must never be sent as a request criterion"
  );
  assert.ok(
    !criteria.some((c) => c.name === "vendor_name" || c.name === "associated_prime_vendor"),
    "no vendor-name request criterion of any spelling"
  );
  // vendor_name contributes nothing; only status + category remain.
  assert.deepEqual(criteria, [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
  ]);
});

test("every criterion contractsCriteria emits is a documented Registered Contracts request param (#16)", () => {
  // Exercise every value + range field at once; assert each emitted name is one
  // the domain actually accepts. This guard is what would have caught prime_vendor.
  const criteria = contractsCriteria({
    status: "registered",
    category: "all",
    fiscal_year: "2024",
    agency_code: "858",
    vendor_name: "ACME",
    vendor_code: "V123",
    contract_id: "CT1",
    award_method: "01",
    mwbe_category: "3",
    industry: "IT",
    contract_type: "MMA",
    amount_min: 1000,
    amount_max: 5000,
    start_date_from: "2023-01-01",
    end_date_to: "2025-01-01",
  });
  for (const c of criteria) {
    assert.ok(
      VALID_CONTRACTS_CRITERIA.has(c.name),
      `emitted criterion '${c.name}' is not an accepted Registered Contracts request param`
    );
  }
});

test("Contracts response columns exclude the rejected 'year' column and are all prime_* / documented (#16)", () => {
  // Live API ('Registered Contracts(expense) All Years') rejects 'year' as a
  // response column (issue #16, 2026-07-16).
  assert.ok(
    !DEFAULT_COLUMNS.Contracts.includes("year"),
    "'year' must not be requested for the citywide Contracts domain"
  );
  // Freeze the exact expected column set so any regression (re-adding year, a
  // typo, a dropped column) is caught.
  assert.deepEqual(DEFAULT_COLUMNS.Contracts, [
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
    "prime_woman_owned_business",
    "prime_emerging_business",
    "mocs_registered",
    "contract_class",
    "parent_contract_id",
    "prime_contract_version",
  ]);
});

test("request XML for a contracts search carries no prime_vendor criterion and no year column (#16)", () => {
  const xml = buildRequestXml({
    type_of_data: "Contracts",
    criteria: contractsCriteria({ status: "registered", category: "expense", vendor_code: "V1" }),
    response_columns: DEFAULT_COLUMNS.Contracts,
  });
  // A <name>prime_vendor</name> would only appear as a criterion here (prime_vendor
  // as a <column> is fine). Assert it is not emitted as a criteria name.
  assert.doesNotMatch(xml, /<criteria><name>prime_vendor<\/name>/);
  assert.doesNotMatch(xml, /<column>year<\/column>/);
});

test("search_contracts with vendor_name returns actionable guidance, not an opaque API error (#16)", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({
    name: "search_contracts",
    arguments: { vendor_name: "Association of Community Employment", page_size: 10 },
  });

  assert.equal(res.isError, true, "vendor_name lookups must fail fast with guidance");
  const text = res.content[0].text;
  // guard() prefixes thrown messages with "Error: "; assert the guidance is carried.
  assert.ok(text.includes(VENDOR_NAME_UNSUPPORTED_MESSAGE), "carries the guidance message");
  assert.match(text, /vendor_code/);
  assert.match(text, /payee_name/);
  assert.doesNotMatch(text, /prime_vendor' is not valid/); // not the opaque upstream 1101

  await client.close();
  await server.close();
});

test("valueCriteria skips undefined and empty values", () => {
  const criteria = valueCriteria(
    { fiscal_year: "2024", agency_code: undefined, budget_code: "" },
    { fiscal_year: "fiscal_year", agency_code: "agency_code", budget_code: "budget_code" }
  );
  assert.deepEqual(criteria, [{ name: "fiscal_year", type: "value", value: "2024" }]);
});

test("rangeCriterion returns undefined when both bounds absent", () => {
  assert.equal(rangeCriterion("issue_date", undefined, undefined, "a", "b"), undefined);
  assert.deepEqual(rangeCriterion("issue_date", undefined, "2024-01-01", "1990-01-01", "2099-12-31"), {
    name: "issue_date",
    type: "range",
    start: "1990-01-01",
    end: "2024-01-01",
  });
});

// ─── Contracts field additions (v1.2.0 — issues #8/#9/#10) ───────────────────
// All tokens confirmed against https://www.checkbooknyc.com/contract-api (2026-07-09).

// Documented sub-vendor / subcontractor columns (#8).
const DOCUMENTED_SUB_VENDOR_COLUMNS = [
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

test("SUB_VENDOR_COLUMNS are exactly the documented sub-vendor tokens (#8)", () => {
  assert.deepEqual(SUB_VENDOR_COLUMNS, DOCUMENTED_SUB_VENDOR_COLUMNS);
});

test("Contracts default columns include the documented WBE/EBE flags (#9)", () => {
  assert.ok(DEFAULT_COLUMNS.Contracts.includes("prime_woman_owned_business"));
  assert.ok(DEFAULT_COLUMNS.Contracts.includes("prime_emerging_business"));
});

test("Contracts default columns include the documented lineage/registration columns (#10)", () => {
  for (const col of ["mocs_registered", "contract_class", "parent_contract_id", "prime_contract_version"]) {
    assert.ok(DEFAULT_COLUMNS.Contracts.includes(col), `missing #10 column: ${col}`);
  }
});

test("contractsColumns appends sub-vendor columns only for registered + include_sub_vendors", () => {
  // Default (no sub-vendors): base Contracts columns, unchanged.
  assert.deepEqual(contractsColumns("registered", false), DEFAULT_COLUMNS.Contracts);

  // Registered + include: base columns followed by the sub-vendor columns.
  const enriched = contractsColumns("registered", true);
  assert.deepEqual(enriched, [...DEFAULT_COLUMNS.Contracts, ...SUB_VENDOR_COLUMNS]);
  // No duplicate columns introduced.
  assert.equal(new Set(enriched).size, enriched.length);

  // Pending never gets sub-vendor columns (different token scheme), even when asked.
  assert.deepEqual(contractsColumns("pending", true), DEFAULT_COLUMNS.Contracts_pending);
  assert.ok(!contractsColumns("pending", true).some((c) => c.startsWith("sub_")));
});

test("request XML emits sub-vendor <column> elements when enriched", () => {
  const xml = buildRequestXml({
    type_of_data: "Contracts",
    response_columns: contractsColumns("registered", true),
  });
  assert.match(xml, /<column>sub_vendor<\/column>/);
  assert.match(xml, /<column>sub_vendor_mwbe_category<\/column>/);
  assert.match(xml, /<column>prime_woman_owned_business<\/column>/);
});

test("contractsCriteria is unchanged by the column additions (no sub-vendor criteria leak)", () => {
  // The sub-vendor / WBE-EBE / misc additions are response columns only — they
  // must not introduce new search criteria. include_sub_vendors is not a filter.
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    include_sub_vendors: true,
  });
  assert.deepEqual(criteria, [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
  ]);
});

// ─── NYCEDC (OGE) + NYCHA contract routing (issue #7) ────────────────────────
// Domain tokens, criteria names, and response columns confirmed against the
// CheckbookNYC API config (checkbook_api/src/config/contracts_oge.json,
// contracts_nycha.json) — 2026-07-09.

test("Contracts_OGE default columns are the documented OGE response tokens", () => {
  for (const col of [
    "other_government_entities",
    "prime_vendor",
    "contract_id",
    "entity_contract_number",
    "commodity_line",
    "budget_name",
    "expense_category",
  ]) {
    assert.ok(DEFAULT_COLUMNS.Contracts_OGE.includes(col), `missing OGE column: ${col}`);
  }
  // OGE has no citywide prime_ / release_ tokens.
  assert.ok(!DEFAULT_COLUMNS.Contracts_OGE.some((c) => c.startsWith("release_")));
});

test("Contracts_NYCHA default columns are the documented NYCHA response tokens", () => {
  for (const col of [
    "release_current_amount",
    "release_original_amount",
    "release_invoiced_amount",
    "contract_current_amount",
    "funding_source",
    "responsibility_center",
    "purchase_order_type",
    "program",
    "project",
    "grant_name",
  ]) {
    assert.ok(DEFAULT_COLUMNS.Contracts_NYCHA.includes(col), `missing NYCHA column: ${col}`);
  }
});

test("nycedcContractsCriteria sends required registered/expense and maps OGE criteria names", () => {
  const criteria = nycedcContractsCriteria({
    fiscal_year: "2024",
    vendor_name: "ACME",
    entity_contract_number: "EDC-123",
    amount_min: 5000,
  });
  assert.deepEqual(criteria, [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
    { name: "fiscal_year", type: "value", value: "2024" },
    // OGE's vendor criterion is prime_vendor.
    { name: "prime_vendor", type: "value", value: "ACME" },
    { name: "entity_contract_number", type: "value", value: "EDC-123" },
    { name: "current_amount", type: "range", start: "5000", end: "99999999999" },
  ]);
});

test("nychaContractsCriteria maps NYCHA criteria names and adds approved_date range", () => {
  const criteria = nychaContractsCriteria({
    fiscal_year: "2024",
    vendor_name: "ACME",
    purchase_order_type: "SA",
    approved_date_from: "2023-01-01",
    approved_date_to: "2023-12-31",
  });
  assert.deepEqual(criteria, [
    { name: "fiscal_year", type: "value", value: "2024" },
    // NYCHA's vendor criterion is vendor_name (not prime_vendor); no status/category.
    { name: "vendor_name", type: "value", value: "ACME" },
    { name: "purchase_order_type", type: "value", value: "SA" },
    { name: "approved_date", type: "range", start: "2023-01-01", end: "2023-12-31" },
  ]);
});

test("request XML routes to the documented entity type_of_data tokens", () => {
  const oge = buildRequestXml({
    type_of_data: "Contracts_OGE",
    criteria: nycedcContractsCriteria({ fiscal_year: "2024" }),
    response_columns: DEFAULT_COLUMNS.Contracts_OGE,
  });
  assert.match(oge, /<type_of_data>Contracts_OGE<\/type_of_data>/);
  assert.match(oge, /<column>entity_contract_number<\/column>/);

  const nycha = buildRequestXml({
    type_of_data: "Contracts_NYCHA",
    criteria: nychaContractsCriteria({ fiscal_year: "2024" }),
    response_columns: DEFAULT_COLUMNS.Contracts_NYCHA,
  });
  assert.match(nycha, /<type_of_data>Contracts_NYCHA<\/type_of_data>/);
  assert.match(nycha, /<column>release_current_amount<\/column>/);
});

// ─── v1.3.2: UNVERIFIED contract filters (issues #6/#8/#10) ───────────────────

test("contractsCriteria emits registration_date range + purpose/pin + sub-vendor filter for registered (#6/#8/#10)", () => {
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    purpose: "consulting",
    pin: "20241234",
    registration_date_from: "2024-01-01",
    registration_date_to: "2024-12-31",
    contract_includes_sub_vendors: "01",
  });
  assert.deepEqual(criteria, [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
    { name: "purpose", type: "value", value: "consulting" },
    { name: "pin", type: "value", value: "20241234" },
    { name: "registration_date", type: "range", start: "2024-01-01", end: "2024-12-31" },
    { name: "contract_includes_sub_vendors", type: "value", value: "01" },
  ]);
});

test("received_date is emitted only for pending; registration_date/sub-vendor only for registered (#6/#10 status gating)", () => {
  // Pending: received_date range appears; registration_date / sub-vendor do NOT.
  const pending = contractsCriteria({
    status: "pending",
    category: "expense",
    received_date_from: "2024-03-01",
    received_date_to: "2024-03-31",
    // These are registered-only; must be ignored under pending status.
    registration_date_from: "2024-01-01",
    contract_includes_sub_vendors: "01",
  });
  assert.ok(pending.some((c) => c.name === "received_date"), "received_date present for pending");
  assert.ok(!pending.some((c) => c.name === "registration_date"), "no registration_date for pending");
  assert.ok(
    !pending.some((c) => c.name === "contract_includes_sub_vendors"),
    "no sub-vendor filter for pending"
  );

  // Registered: received_date must NOT appear even if supplied.
  const registered = contractsCriteria({
    status: "registered",
    category: "expense",
    received_date_from: "2024-03-01",
  });
  assert.ok(!registered.some((c) => c.name === "received_date"), "no received_date for registered");
});

test("every registered-search criterion is a documented Registered Contracts request param, incl. the new filters (#6/#8/#10)", () => {
  const criteria = contractsCriteria({
    status: "registered",
    category: "all",
    fiscal_year: "2024",
    agency_code: "858",
    vendor_code: "V123",
    purpose: "IT",
    pin: "P1",
    registration_date_from: "2023-01-01",
    contract_includes_sub_vendors: "02",
  });
  for (const c of criteria) {
    assert.ok(
      VALID_CONTRACTS_CRITERIA.has(c.name),
      `emitted criterion '${c.name}' is not an accepted Registered Contracts request param`
    );
  }
});

test("Contracts response columns still exclude 'year' AND the deliberately-excluded 'prime_contract_registration_date' (#6 exclusion / #16 regression)", () => {
  assert.ok(!DEFAULT_COLUMNS.Contracts.includes("year"), "'year' must stay excluded");
  assert.ok(
    !DEFAULT_COLUMNS.Contracts.includes("prime_contract_registration_date"),
    "'prime_contract_registration_date' must not be added to the default column set (invalidated by #17)"
  );
});

test("suppliedUnverifiedContractFilters reports exactly the unverified filters present", () => {
  assert.deepEqual(
    suppliedUnverifiedContractFilters({ status: "registered", purpose: "x", agency_code: "858" }),
    ["purpose"]
  );
  assert.deepEqual(
    suppliedUnverifiedContractFilters({ registration_date_from: "2024-01-01", pin: "" }),
    ["registration_date_from"] // empty string is not "supplied"
  );
  assert.deepEqual(suppliedUnverifiedContractFilters({ status: "registered", fiscal_year: "2024" }), []);
});

test("unverifiedContractFiltersEnabled reflects the env flag", () => {
  const prev = process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
  try {
    delete process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
    assert.equal(unverifiedContractFiltersEnabled(), false);
    process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS = "1";
    assert.equal(unverifiedContractFiltersEnabled(), true);
    process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS = "true";
    assert.equal(unverifiedContractFiltersEnabled(), true);
    process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS = "0";
    assert.equal(unverifiedContractFiltersEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
    else process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS = prev;
  }
});

test("CONTRACT_UNVERIFIED_FILTER_KEYS covers exactly the five new filter surfaces", () => {
  assert.deepEqual([...CONTRACT_UNVERIFIED_FILTER_KEYS], [
    "purpose",
    "pin",
    "registration_date_from",
    "registration_date_to",
    "contract_includes_sub_vendors",
    "received_date_from",
    "received_date_to",
  ]);
});

test("search_contracts fails fast with NEEDS-LIVE-VERIFY guidance when an unverified filter is supplied and the flag is off (throws before any network call)", async () => {
  const prev = process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
  delete process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
  try {
    const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
    registerTools(server);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_contracts",
      arguments: { purpose: "consulting", page_size: 10 },
    });

    assert.equal(res.isError, true, "unverified filter must fail fast, not hit the live API");
    const text = res.content[0].text;
    assert.ok(text.includes(UNVERIFIED_CONTRACT_FILTERS_MESSAGE), "carries the guidance message");
    assert.match(text, /CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS/);
    assert.match(text, /purpose/); // names the offending filter

    await client.close();
    await server.close();
  } finally {
    if (prev === undefined) delete process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS;
    else process.env.CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS = prev;
  }
});

test("search_contracts with no unverified filters is unaffected by the gate (vendor_name still fails fast)", async () => {
  // Sanity: the gate only triggers on the new filters. A plain vendor_name call
  // still routes to the existing #17 fail-fast, not the new one.
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({
    name: "search_contracts",
    arguments: { vendor_name: "ACME", page_size: 10 },
  });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes(VENDOR_NAME_UNSUPPORTED_MESSAGE));

  await client.close();
  await server.close();
});
