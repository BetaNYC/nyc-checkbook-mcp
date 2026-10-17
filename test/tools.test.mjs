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
  nycedcContractsCriteria,
  nychaContractsCriteria,
  nycedcContractsColumns,
  nychaContractsColumns,
  NYCHA_FISCAL_YEAR_COLUMNS,
  OGE_ALL_YEARS_COLUMNS,
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

// Sub-vendor / subcontractor columns (#8), LIVE-VERIFIED 2026-07-31.
//
// The previous version of this test asserted SUB_VENDOR_COLUMNS matched the
// tokens published on /contract-api. That oracle is wrong, and the test passing
// is exactly why the bug shipped: the docs list `sub_contract_registration_date`,
// the live API rejects it with 1106, and one invalid column fails the entire
// request — so every include_sub_vendors=true search errored while this suite was
// green. The oracle is now the live API's own "Valid values are ..." list for
// 'Registered Contracts(expense)'. Do not re-derive this from the docs.
const LIVE_VERIFIED_SUB_VENDOR_COLUMNS = [
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

test("SUB_VENDOR_COLUMNS are exactly the live-verified sub-vendor tokens (#8)", () => {
  assert.deepEqual(SUB_VENDOR_COLUMNS, LIVE_VERIFIED_SUB_VENDOR_COLUMNS);
});

test("SUB_VENDOR_COLUMNS excludes the documented-but-rejected sub_contract_registration_date (#8 regression)", () => {
  // Live API, both registered/expense domain variants (2026-07-31):
  //   1106: Provided response column 'sub_contract_registration_date' value is
  //   not allowed for 'Registered Contracts(expense)' domain.
  // Published on /contract-api, rejected by the API. Same trap as `year` (#16).
  assert.ok(!SUB_VENDOR_COLUMNS.includes("sub_contract_registration_date"));
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

test("contractsColumns appends sub-vendor columns only for registered expense/all + include_sub_vendors", () => {
  const reg = contractsCriteria({ status: "registered", category: "expense" });
  // Default (no sub-vendors): base Contracts columns, unchanged.
  assert.deepEqual(contractsColumns(reg, false), DEFAULT_COLUMNS.Contracts);
  assert.deepEqual(contractsColumns(reg), DEFAULT_COLUMNS.Contracts);

  // Registered + include: base columns followed by the sub-vendor columns.
  const enriched = contractsColumns(reg, true);
  assert.deepEqual(enriched, [...DEFAULT_COLUMNS.Contracts, ...SUB_VENDOR_COLUMNS]);
  // No duplicate columns introduced.
  assert.equal(new Set(enriched).size, enriched.length);

  // Pending never gets sub-vendor columns (different token scheme), even when asked.
  const pend = contractsCriteria({ status: "pending", category: "expense" });
  assert.deepEqual(contractsColumns(pend, true), DEFAULT_COLUMNS.Contracts_pending);
  assert.ok(!contractsColumns(pend, true).some((c) => c.startsWith("sub_")));
});

// ─── Contracts columns per (status, category, fiscal_year) — issue #42 ───────
// The live API resolves a different domain per (status, category). Probe
// 2026-10-16: registered/all lists the same prime_contract_* names as
// registered/expense (sub_* included); registered/revenue lists a plain-name
// vocabulary with no sub_*; every pending shape lists the pending/expense names.
// fiscal_year never changes the selection. Whether each list is valid in its
// live domain is checked by scripts/check-default-columns.mjs (and, against the
// real fixture, by test/check-default-columns.test.mjs).
const CONTRACT_SHAPES = [];
for (const status of ["registered", "pending"]) {
  for (const category of ["expense", "revenue", "all"]) {
    for (const fy of [false, true]) {
      for (const sub of [false, true]) CONTRACT_SHAPES.push({ status, category, fy, sub });
    }
  }
}

function expectedContractsColumns({ status, category, sub }) {
  if (status === "pending") return DEFAULT_COLUMNS.Contracts_pending;
  if (category === "revenue") return DEFAULT_COLUMNS.Contracts_revenue;
  return sub ? [...DEFAULT_COLUMNS.Contracts, ...SUB_VENDOR_COLUMNS] : DEFAULT_COLUMNS.Contracts;
}

test("contractsColumns picks the list for every (status, category, fiscal_year, sub-vendor) shape (#42)", () => {
  assert.equal(CONTRACT_SHAPES.length, 24);
  for (const shape of CONTRACT_SHAPES) {
    const input = { status: shape.status, category: shape.category, ...(shape.fy ? { fiscal_year: "2025" } : {}) };
    const criteria = contractsCriteria(input);
    assert.equal(criteria.some((c) => c.name === "fiscal_year"), shape.fy, JSON.stringify(shape));
    assert.deepEqual(contractsColumns(criteria, shape.sub), expectedContractsColumns(shape), JSON.stringify(shape));
  }
});

test("registered/revenue never sends a prime_contract_* or sub_* column (#42)", () => {
  // The live failure: 'prime_contract_id' rejected for 'Registered Contracts(revenue) All Years'.
  for (const fy of [false, true]) {
    for (const sub of [false, true]) {
      const criteria = contractsCriteria({ status: "registered", category: "revenue", ...(fy ? { fiscal_year: "2025" } : {}) });
      const cols = contractsColumns(criteria, sub);
      assert.ok(!cols.some((c) => c.startsWith("prime_contract") || c.startsWith("sub_")), `fy=${fy} sub=${sub}`);
      assert.ok(!cols.includes("year"), "year is listed only with fiscal_year; not sent");
      assert.ok(cols.includes("contract_id"));
    }
  }
  assert.equal(new Set(DEFAULT_COLUMNS.Contracts_revenue).size, DEFAULT_COLUMNS.Contracts_revenue.length);
});

test("contractsColumns treats missing status/category as the tool defaults (registered, expense)", () => {
  assert.deepEqual(contractsColumns([]), DEFAULT_COLUMNS.Contracts);
  assert.deepEqual(contractsColumns([{ name: "category", type: "value", value: "revenue" }]), DEFAULT_COLUMNS.Contracts_revenue);
  assert.deepEqual(contractsColumns([{ name: "status", type: "value", value: "pending" }]), DEFAULT_COLUMNS.Contracts_pending);
});

test("search_contracts and get_contract send the (status, category) columns on the wire (#42)", async () => {
  const emptyOk =
    "<response><status><result>success</result></status>" +
    "<result_records><record_count>0</record_count></result_records></response>";
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(emptyOk, { status: 200 });
  };
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const columnsSent = (xml) => [...xml.matchAll(/<column>([^<]*)<\/column>/g)].map((m) => m[1]);
  try {
    const calls = [
      ["search_contracts", { category: "revenue", include_sub_vendors: true, page_size: 1 }, DEFAULT_COLUMNS.Contracts_revenue],
      ["search_contracts", { category: "all", include_sub_vendors: true, page_size: 1 }, [...DEFAULT_COLUMNS.Contracts, ...SUB_VENDOR_COLUMNS]],
      ["search_contracts", { status: "pending", category: "revenue", page_size: 1 }, DEFAULT_COLUMNS.Contracts_pending],
      ["get_contract", { contract_id: "X1", category: "revenue" }, DEFAULT_COLUMNS.Contracts_revenue],
      ["get_contract", { contract_id: "X1" }, DEFAULT_COLUMNS.Contracts],
      ["get_contract", { contract_id: "X1", status: "pending", category: "revenue" }, DEFAULT_COLUMNS.Contracts_pending],
    ];
    for (const [name, args, expected] of calls) {
      const before = bodies.length;
      const res = await client.callTool({ name, arguments: args });
      assert.notEqual(res.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(bodies.length, before + 1);
      assert.deepEqual(columnsSent(bodies[bodies.length - 1]), expected, `${name} ${JSON.stringify(args)}`);
    }
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
});

test("request XML emits sub-vendor <column> elements when enriched", () => {
  const xml = buildRequestXml({
    type_of_data: "Contracts",
    response_columns: contractsColumns(contractsCriteria({ status: "registered", category: "expense" }), true),
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
// Domain tokens and criteria names come from the CheckbookNYC API config
// (checkbook_api/src/config/contracts_oge.json, contracts_nycha.json). Response
// columns do NOT: that config listed `year` (NYCHA) and `apt_pin` (OGE)
// unconditionally, and the live API rejects each for one call shape (#40). The
// authority for response columns is the live API's valid-values lists, checked by
// scripts/check-default-columns.mjs against fresh probe output (pre-release step,
// scripts/README.md). Do not add tests here that copy column lists from the config.

// One regression guard per domain for #40: the BASE list is sent for every call
// shape, so it must not carry a column the live API rejects for any shape.
test("Contracts_NYCHA base list does not request 'year' (#40)", () => {
  // Rejected on a vendor_name-only search; listed as valid only with fiscal_year.
  assert.ok(!DEFAULT_COLUMNS.Contracts_NYCHA.includes("year"));
});

test("Contracts_OGE base list does not request 'apt_pin' (#40)", () => {
  // Rejected on a fiscal_year search; listed as valid only without fiscal_year.
  assert.ok(!DEFAULT_COLUMNS.Contracts_OGE.includes("apt_pin"));
});

test("NYCHA columns depend on call shape: 'year' only with fiscal_year (#40)", () => {
  assert.deepEqual(NYCHA_FISCAL_YEAR_COLUMNS, ["year"]);
  const withFy = nychaContractsColumns(nychaContractsCriteria({ fiscal_year: "2025", vendor_name: "ACME" }));
  assert.deepEqual(withFy, [...DEFAULT_COLUMNS.Contracts_NYCHA, ...NYCHA_FISCAL_YEAR_COLUMNS]);
  for (const input of [{}, { vendor_name: "ACME" }, { contract_id: "X" }, { fiscal_year: "" }]) {
    const cols = nychaContractsColumns(nychaContractsCriteria(input));
    assert.deepEqual(cols, DEFAULT_COLUMNS.Contracts_NYCHA, JSON.stringify(input));
  }
});

test("OGE columns depend on call shape: 'apt_pin' only without fiscal_year (#40)", () => {
  assert.deepEqual(OGE_ALL_YEARS_COLUMNS, ["apt_pin"]);
  const withFy = nycedcContractsColumns(nycedcContractsCriteria({ fiscal_year: "2025" }));
  assert.deepEqual(withFy, DEFAULT_COLUMNS.Contracts_OGE);
  for (const input of [{}, { vendor_name: "ACME" }, { contract_id: "X" }, { fiscal_year: "" }]) {
    const cols = nycedcContractsColumns(nycedcContractsCriteria(input));
    assert.deepEqual(cols, [...DEFAULT_COLUMNS.Contracts_OGE, ...OGE_ALL_YEARS_COLUMNS], JSON.stringify(input));
  }
});

test("search_nycha_contracts / search_nycedc_contracts send the shape's columns on the wire (#40)", async () => {
  // Offline: fetch is stubbed with a successful empty response.
  const emptyOk =
    "<response><status><result>success</result></status>" +
    "<result_records><record_count>0</record_count></result_records></response>";
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(emptyOk, { status: 200 });
  };
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const calls = [
      ["search_nycha_contracts", { fiscal_year: "2025" }, "year", true],
      ["search_nycha_contracts", { vendor_name: "ACME" }, "year", false],
      ["search_nycedc_contracts", { fiscal_year: "2025" }, "apt_pin", false],
      ["search_nycedc_contracts", { vendor_name: "ACME" }, "apt_pin", true],
    ];
    for (const [name, args, column, expected] of calls) {
      const before = bodies.length;
      const res = await client.callTool({ name, arguments: { ...args, page_size: 1 } });
      assert.notEqual(res.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(bodies.length, before + 1);
      const sent = bodies[bodies.length - 1].includes(`<column>${column}</column>`);
      assert.equal(sent, expected, `${name} ${JSON.stringify(args)}: <column>${column}</column>`);
    }
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
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

// ─── v1.5.0: UNVERIFIED contract filters (issues #6/#8/#10) ───────────────────

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

test("vendor_name still fails fast (#17)", async () => {
  // The contracts domain has no vendor-name request parameter; a name lookup must
  // stop with guidance rather than silently returning unrelated contracts.
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

const CONTRACT_FILTER_KEYS = [
  "purpose",
  "pin",
  "registration_date_from",
  "registration_date_to",
  "contract_includes_sub_vendors",
  "received_date_from",
  "received_date_to",
];

// ─── v1.4.0 × v1.5.0 interaction ──────────────────────────────────────────────
//
// #19 made every tool schema strict: an undeclared parameter is now REJECTED
// rather than silently dropped. That turns "forgot to declare a filter" from an
// invisible no-op into a hard failure, so every filter this release adds must be
// declared in the advertised schema or it becomes unusable the moment it ships.
// Both changes landed independently (main at 1.4.0, this branch at 1.5.0), so
// this pins the seam between them.

test("every contract filter is declared in the advertised strict schema (#19 × #6/#8/#10)", async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const searchContracts = tools.find((t) => t.name === "search_contracts");
  const declared = Object.keys(searchContracts.inputSchema.properties);

  assert.equal(
    searchContracts.inputSchema.additionalProperties,
    false,
    "search_contracts must still advertise strictness"
  );

  for (const key of CONTRACT_FILTER_KEYS) {
    assert.ok(
      declared.includes(key),
      `${key} is built into the criteria but not declared — under a strict schema ` +
        `an undeclared filter is rejected outright, so it would be unusable`
    );
  }

  // Live-verified 2026-07-28: this filter is an INTEGER. The API rejects a
  // non-numeric value with "is not of data type integer", and delivers that as
  // HTTP 200 with a plain-text body which parses as an empty response — so a
  // regression here would surface to users as a blank result, not an error.
  assert.equal(
    searchContracts.inputSchema.properties.contract_includes_sub_vendors.type,
    "integer",
    "contract_includes_sub_vendors must be advertised as an integer, not a string"
  );

  await client.close();
  await server.close();
});

// ─── Input bounds at the trust boundary ──────────────────────────────────────
//
// Unbounded paging reached the wire as max_records=-5 / records_from=-49: a
// request that cannot succeed, spent from a 1-per-second budget. And the
// sub-vendor flag is capped by the API at 2 characters, rejecting anything longer
// as HTTP 200 with a plain-text body that this client parses as "Empty response"
// — an invisible failure, which is exactly why it is bounded here instead.

test("search_contracts rejects out-of-range paging and sub-vendor flag values", async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);

  const bad = [
    { page_size: 0 },
    { page_size: -5 },
    { page_size: 20001 },
    { page: 0 },
    { page: -3 },
    { status: "registered", contract_includes_sub_vendors: 12345 },
    { status: "registered", contract_includes_sub_vendors: -1 },
  ];

  for (const args of bad) {
    const res = await client.callTool({ name: "search_contracts", arguments: args });
    assert.equal(res.isError, true, `${JSON.stringify(args)} must be rejected, not sent`);
  }

  // The boundary values themselves stay legal.
  const schema = (await client.listTools()).tools.find((t) => t.name === "search_contracts")
    .inputSchema.properties;
  assert.equal(schema.page_size.maximum, 20000);
  assert.equal(schema.page_size.minimum, 1);
  assert.equal(schema.page.minimum, 1);
  assert.equal(schema.contract_includes_sub_vendors.maximum, 99);

  await client.close();
  await server.close();
});
