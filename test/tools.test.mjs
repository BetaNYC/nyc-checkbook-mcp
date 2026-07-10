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
  nycedcContractsCriteria,
  nychaContractsCriteria,
} from "../dist/tools.js";
import { DEFAULT_COLUMNS, buildRequestXml } from "../dist/checkbook.js";

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

test("contractsCriteria builds value + range criteria like the old handler", () => {
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    fiscal_year: "2024",
    vendor_name: "ACME",
    amount_min: 1000,
    start_date_from: "2023-01-01",
  });

  assert.deepEqual(criteria, [
    { name: "status", type: "value", value: "registered" },
    { name: "category", type: "value", value: "expense" },
    { name: "fiscal_year", type: "value", value: "2024" },
    { name: "prime_vendor", type: "value", value: "ACME" },
    { name: "current_amount", type: "range", start: "1000", end: "99999999999" },
    { name: "start_date", type: "range", start: "2023-01-01", end: "2099-12-31" },
  ]);
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

// ─── Config-confirmed Contracts field gaps (issues #6 / #8 / #10) ────────────
// Tokens confirmed against the CheckbookNYC API config
// (NYCComptroller/Checkbook: source/web/modules/custom/checkbook_api/src/config/contracts.json),
// which is the authoritative token source. No live API calls.

test("#6 — prime_contract_registration_date is in the default Contracts columns", () => {
  // contracts_active_expense.displayConfiguration.xml.overrideColumns + rowElements.
  assert.ok(DEFAULT_COLUMNS.Contracts.includes("prime_contract_registration_date"));
  // Still no duplicates in the default column set.
  assert.equal(new Set(DEFAULT_COLUMNS.Contracts).size, DEFAULT_COLUMNS.Contracts.length);
});

test("#6 — registration_date range criterion is added for registered contracts", () => {
  // contracts_active_expense.requestParameters.registration_date = range/date.
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    registration_date_from: "2023-01-01",
    registration_date_to: "2023-12-31",
  });
  assert.deepEqual(
    criteria.find((c) => c.name === "registration_date"),
    { name: "registration_date", type: "range", start: "2023-01-01", end: "2023-12-31" }
  );
});

test("#6/#10 — registration_date is not sent for pending; received_date is not sent for registered", () => {
  // Pending config declares received_date, not registration_date (contracts_pending.requestParameters).
  const pending = contractsCriteria({
    status: "pending",
    category: "expense",
    registration_date_from: "2023-01-01",
    received_date_from: "2024-06-01",
  });
  assert.equal(pending.find((c) => c.name === "registration_date"), undefined);
  assert.deepEqual(
    pending.find((c) => c.name === "received_date"),
    { name: "received_date", type: "range", start: "2024-06-01", end: "2099-12-31" }
  );

  // Registered config declares registration_date, not received_date.
  const registered = contractsCriteria({
    status: "registered",
    category: "expense",
    received_date_from: "2024-06-01",
  });
  assert.equal(registered.find((c) => c.name === "received_date"), undefined);
});

test("#8 — contract_includes_sub_vendors value criterion is passed through for registered only", () => {
  // requestParameters.contract_includes_sub_vendors = {valueType:"value",dataType:"text",maxLength:"2"}.
  // The accepted code enumeration is not published in the config, so the raw
  // caller value is passed through verbatim (this test asserts wiring, not a valid code).
  const registered = contractsCriteria({
    status: "registered",
    category: "expense",
    contract_includes_sub_vendors: "01",
  });
  assert.deepEqual(
    registered.find((c) => c.name === "contract_includes_sub_vendors"),
    { name: "contract_includes_sub_vendors", type: "value", value: "01" }
  );

  // Pending config does not declare contract_includes_sub_vendors — must not be sent.
  const pending = contractsCriteria({
    status: "pending",
    category: "expense",
    contract_includes_sub_vendors: "01",
  });
  assert.equal(pending.find((c) => c.name === "contract_includes_sub_vendors"), undefined);
});

test("#10 — purpose and pin are universal value criteria", () => {
  const criteria = contractsCriteria({
    status: "registered",
    category: "expense",
    purpose: "consulting",
    pin: "20231234",
  });
  assert.deepEqual(criteria.find((c) => c.name === "purpose"), {
    name: "purpose",
    type: "value",
    value: "consulting",
  });
  assert.deepEqual(criteria.find((c) => c.name === "pin"), {
    name: "pin",
    type: "value",
    value: "20231234",
  });
});

test("request XML emits the config-confirmed criteria and registration_date column", () => {
  const xml = buildRequestXml({
    type_of_data: "Contracts",
    criteria: contractsCriteria({
      status: "registered",
      category: "expense",
      registration_date_from: "2023-01-01",
      contract_includes_sub_vendors: "01",
      pin: "20231234",
    }),
    response_columns: DEFAULT_COLUMNS.Contracts,
  });
  assert.match(xml, /<name>registration_date<\/name><type>range<\/type>/);
  assert.match(xml, /<name>contract_includes_sub_vendors<\/name><type>value<\/type>/);
  assert.match(xml, /<name>pin<\/name>/);
  assert.match(xml, /<column>prime_contract_registration_date<\/column>/);

  const pendingXml = buildRequestXml({
    type_of_data: "Contracts",
    criteria: contractsCriteria({
      status: "pending",
      category: "expense",
      received_date_from: "2024-06-01",
    }),
  });
  assert.match(pendingXml, /<name>received_date<\/name><type>range<\/type>/);
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
