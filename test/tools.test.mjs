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
];

test("tools/list exposes the same 8 tool names", async () => {
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
