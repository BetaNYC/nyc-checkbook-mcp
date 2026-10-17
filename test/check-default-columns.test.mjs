// Offline tests for scripts/check-default-columns.mjs. No network.
//
// test/fixtures/probe-results-sample.txt is real API output (provenance in its
// header): a snapshot, not a live oracle. These tests prove the parser and the
// comparison logic; whether today's DEFAULT_COLUMNS match today's live API is
// answered only by running the probe and the checker (see scripts/README.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseProbeResults,
  checkDefaultColumns,
  formatReport,
  COLUMN_CHECKS,
} from "../scripts/check-default-columns.mjs";
import { DEFAULT_COLUMNS } from "../dist/checkbook.js";
import {
  SUB_VENDOR_COLUMNS,
  NYCHA_FISCAL_YEAR_COLUMNS,
  OGE_ALL_YEARS_COLUMNS,
  contractsColumns,
  contractsCriteria,
} from "../dist/tools.js";

const sections = parseProbeResults(
  readFileSync(new URL("./fixtures/probe-results-sample.txt", import.meta.url), "utf8")
);

function run(defaultColumns, opts = {}) {
  return checkDefaultColumns({
    sections,
    defaultColumns,
    subVendorColumns: SUB_VENDOR_COLUMNS,
    shapeColumns: { nychaFiscalYear: NYCHA_FISCAL_YEAR_COLUMNS, ogeAllYears: OGE_ALL_YEARS_COLUMNS },
    ...opts,
  });
}

function findingsFor(result, check) {
  return result.findings.filter((f) => f.check === check);
}

test("parser: reads label, kind, resolved domain and the valid list; ignores the provenance header", () => {
  const nycha = sections.get("Contracts_NYCHA no FY :: COLUMNS");
  assert.equal(nycha.kind, "COLUMNS");
  assert.equal(nycha.domain, "Contracts_nycha");
  assert.equal(nycha.valid.size, 35);
  assert.ok(!nycha.valid.has("year"));

  const ogeAllYears = sections.get("Contracts_OGE :: COLUMNS");
  assert.equal(ogeAllYears.domain, "Registered Contracts_oge(expense) All Years");

  const crit = sections.get("Contracts_NYCHA :: CRITERIA");
  assert.equal(crit.kind, "CRITERIA");
  assert.ok(crit.valid.has("vendor_name"));

  for (const key of sections.keys()) assert.match(key, / :: (COLUMNS|CRITERIA)$/);
});

test("parser: an aborted section is marked aborted, with no valid list", () => {
  const parsed = parseProbeResults(
    "===== Spending :: COLUMNS =====\nABORTED: HTTP 403 after 7 successful probe(s).\n"
  );
  const s = parsed.get("Spending :: COLUMNS");
  assert.equal(s.aborted, true);
  assert.equal(s.valid, null);
});

test("the resolved vocabulary depends on criteria: same domain, different lists (#40)", () => {
  // Real evidence for why each list is checked against every call-shape variant.
  assert.ok(sections.get("Contracts_NYCHA :: COLUMNS").valid.has("year")); // with fiscal_year
  assert.ok(!sections.get("Contracts_NYCHA no FY :: COLUMNS").valid.has("year")); // vendor_name only
  assert.ok(sections.get("Contracts_OGE :: COLUMNS").valid.has("apt_pin")); // no fiscal_year
  assert.ok(!sections.get("Contracts_OGE FY :: COLUMNS").valid.has("apt_pin")); // with fiscal_year
});

const NYCHA_FY = "Contracts_NYCHA (fiscal_year) + NYCHA_FISCAL_YEAR_COLUMNS";
const NYCHA_NO_FY = "Contracts_NYCHA (no fiscal_year)";
const OGE_FY = "Contracts_OGE (fiscal_year)";
const OGE_NO_FY = "Contracts_OGE (no fiscal_year) + OGE_ALL_YEARS_COLUMNS";
// Variants added after the snapshot was taken; they have never been sent live.
const NEVER_RUN = new Set([
  "Contracts_NYCHA contract_id",
  "Contracts_NYCHA no criteria",
  "Contracts_OGE contract_id",
]);

function unverified(result, check) {
  return findingsFor(result, check)
    .filter((f) => f.type !== "missing-probe")
    .map((f) => [f.type, f.probe, f.column]);
}

test("current NYCHA and OGE lists, per call shape, have no unverified column in the snapshot", () => {
  const result = run(DEFAULT_COLUMNS);
  for (const check of [NYCHA_FY, NYCHA_NO_FY, OGE_FY, OGE_NO_FY]) {
    assert.deepEqual(unverified(result, check), [], check);
    for (const f of findingsFor(result, check)) {
      assert.ok(NEVER_RUN.has(f.probe), `${check}: unexpected missing probe ${f.probe}`);
    }
  }
  // The two shapes whose variants are all in the snapshot pass outright.
  assert.ok(result.passed.some((c) => c.name === NYCHA_FY));
  assert.ok(result.passed.some((c) => c.name === OGE_FY));
});

test("each shape-specific column is checked only against its own shape's variants (#40)", () => {
  const byName = new Map(COLUMN_CHECKS.map((c) => [c.name, c]));
  assert.deepEqual(byName.get(NYCHA_FY).probes, ["Contracts_NYCHA"]);
  assert.deepEqual(byName.get(OGE_FY).probes, ["Contracts_OGE FY"]);
  for (const p of byName.get(NYCHA_NO_FY).probes) assert.notEqual(p, "Contracts_NYCHA");
  for (const p of byName.get(OGE_NO_FY).probes) assert.notEqual(p, "Contracts_OGE FY");

  const shapeColumns = { nychaFiscalYear: ["year"], ogeAllYears: ["apt_pin"] };
  const nychaFy = byName.get(NYCHA_FY).columns({ defaultColumns: DEFAULT_COLUMNS, shapeColumns });
  const nychaNoFy = byName.get(NYCHA_NO_FY).columns({ defaultColumns: DEFAULT_COLUMNS, shapeColumns });
  assert.ok(nychaFy.includes("year"));
  assert.ok(!nychaNoFy.includes("year"));
  const ogeFy = byName.get(OGE_FY).columns({ defaultColumns: DEFAULT_COLUMNS, shapeColumns });
  const ogeNoFy = byName.get(OGE_NO_FY).columns({ defaultColumns: DEFAULT_COLUMNS, shapeColumns });
  assert.ok(!ogeFy.includes("apt_pin"));
  assert.ok(ogeNoFy.includes("apt_pin"));
});

test("regression #40: 'year' in the NYCHA base list or 'apt_pin' in the OGE base list is flagged, in the variant that omits it", () => {
  const broken = {
    ...DEFAULT_COLUMNS,
    Contracts_NYCHA: ["year", ...DEFAULT_COLUMNS.Contracts_NYCHA],
    Contracts_OGE: [...DEFAULT_COLUMNS.Contracts_OGE, "apt_pin"],
  };
  const result = run(broken);
  assert.equal(result.ok, false);
  assert.deepEqual(unverified(result, NYCHA_NO_FY), [["unverified", "Contracts_NYCHA no FY", "year"]]);
  assert.deepEqual(unverified(result, OGE_FY), [["unverified", "Contracts_OGE FY", "apt_pin"]]);
  // The shapes that do accept them stay clean.
  assert.deepEqual(unverified(result, NYCHA_FY), []);
  assert.deepEqual(unverified(result, OGE_NO_FY), []);
});

test("a shape-specific column the live list omits is flagged in that shape", () => {
  const result = run(DEFAULT_COLUMNS, {
    shapeColumns: { nychaFiscalYear: ["year", "apt_pin"], ogeAllYears: ["apt_pin"] },
  });
  assert.deepEqual(unverified(result, NYCHA_FY), [["unverified", "Contracts_NYCHA", "apt_pin"]]);
});

test("missing shape-specific lists are a finding, not a silent pass", () => {
  const result = run(DEFAULT_COLUMNS, { shapeColumns: {} });
  for (const check of [NYCHA_FY, OGE_NO_FY]) {
    const f = findingsFor(result, check);
    assert.deepEqual(f.map((x) => x.type), ["unmapped-domain"], check);
  }
  assert.ok(!result.passed.some((c) => c.name === NYCHA_FY));
});

test("regression #16 / v1.6.1: citywide 'year' and sub_contract_registration_date are flagged", () => {
  const result = run(
    { ...DEFAULT_COLUMNS, Contracts: [...DEFAULT_COLUMNS.Contracts, "year"] },
    { subVendorColumns: [...SUB_VENDOR_COLUMNS, "sub_contract_registration_date"] }
  );
  const cols = result.findings
    .filter((f) => f.type === "unverified" && f.probe === "Contracts registered/expense")
    .map((f) => `${f.check}:${f.column}`);
  assert.ok(cols.includes("Contracts:year"));
  assert.ok(cols.includes("Contracts + SUB_VENDOR_COLUMNS:sub_contract_registration_date"));
});

test("absence is reported as UNVERIFIED, never as rejected (floor, not ceiling)", () => {
  const result = run({ ...DEFAULT_COLUMNS, Revenue: [...DEFAULT_COLUMNS.Revenue, "zzz_absent"] });
  const [f] = findingsFor(result, "Revenue");
  assert.equal(f.type, "unverified");
  assert.match(f.message, /UNVERIFIED, not proven rejected/);
  assert.doesNotMatch(f.message, /\bis rejected\b/);
  assert.match(formatReport(result), /UNVERIFIED/);
});

test("a column recorded in verifiedAbsent with evidence is not a finding", () => {
  const result = run(
    { ...DEFAULT_COLUMNS, Revenue: [...DEFAULT_COLUMNS.Revenue, "zzz_absent"] },
    { verifiedAbsent: { "Revenue::zzz_absent": "test evidence" } }
  );
  assert.deepEqual(findingsFor(result, "Revenue"), []);
});

test("a probe variant missing from the output fails the check instead of passing silently", () => {
  // The snapshot predates the Contracts FY variant, so it must report missing-probe.
  const result = run(DEFAULT_COLUMNS);
  const missing = findingsFor(result, "Contracts").filter((f) => f.type === "missing-probe");
  assert.deepEqual(missing.map((f) => f.probe), ["Contracts registered/expense FY"]);
  assert.ok(!result.passed.some((c) => c.name === "Contracts"));
});

// ─── Contracts per (status, category, fiscal_year) — issue #42 ──────────────
// The fixture carries real 2026-10-16 output for every contracts shape except
// registered/expense FY, pending/expense FY and registered/revenue contract_id.
const CONTRACT_PROBE_SHAPES = [
  ["Contracts registered/expense", { status: "registered", category: "expense" }],
  ["Contracts registered/revenue", { status: "registered", category: "revenue" }],
  ["Contracts registered/revenue FY", { status: "registered", category: "revenue", fiscal_year: "2025" }],
  ["Contracts registered/all", { status: "registered", category: "all" }],
  ["Contracts registered/all FY", { status: "registered", category: "all", fiscal_year: "2025" }],
  ["Contracts pending/expense", { status: "pending", category: "expense" }],
  ["Contracts pending/revenue", { status: "pending", category: "revenue" }],
  ["Contracts pending/revenue FY", { status: "pending", category: "revenue", fiscal_year: "2025" }],
  ["Contracts pending/all", { status: "pending", category: "all" }],
  ["Contracts pending/all FY", { status: "pending", category: "all", fiscal_year: "2025" }],
];

test("every column contractsColumns sends for a shape is in that shape's real live list (#42)", () => {
  for (const [probe, input] of CONTRACT_PROBE_SHAPES) {
    const section = sections.get(`${probe} :: COLUMNS`);
    assert.ok(section?.valid, `fixture lacks ${probe}`);
    for (const sub of [false, true]) {
      const cols = contractsColumns(contractsCriteria(input), sub);
      const absent = cols.filter((c) => !section.valid.has(c));
      assert.deepEqual(absent, [], `${probe} sub=${sub} (${section.domain})`);
    }
  }
});

test("COLUMN_CHECKS maps each contracts list to exactly its shapes' probes (#42)", () => {
  const byName = new Map(COLUMN_CHECKS.map((c) => [c.name, c]));
  assert.deepEqual(byName.get("Contracts_revenue").probes, [
    "Contracts registered/revenue",
    "Contracts registered/revenue FY",
    "Contracts registered/revenue contract_id",
  ]);
  for (const name of ["Contracts", "Contracts + SUB_VENDOR_COLUMNS"]) {
    assert.deepEqual(byName.get(name).probes, [
      "Contracts registered/expense",
      "Contracts registered/expense FY",
      "Contracts registered/all",
      "Contracts registered/all FY",
    ]);
  }
  assert.deepEqual(byName.get("Contracts_pending").probes, [
    "Contracts pending/expense",
    "Contracts pending/expense FY",
    "Contracts pending/revenue",
    "Contracts pending/revenue FY",
    "Contracts pending/all",
    "Contracts pending/all FY",
  ]);
  // Each entry builds the list the tool sends for that shape.
  const reg = (category) => contractsCriteria({ status: "registered", category });
  const args = { defaultColumns: DEFAULT_COLUMNS, subVendorColumns: SUB_VENDOR_COLUMNS };
  assert.deepEqual(byName.get("Contracts_revenue").columns(args), contractsColumns(reg("revenue"), true));
  assert.deepEqual(byName.get("Contracts").columns(args), contractsColumns(reg("all"), false));
  assert.deepEqual(byName.get("Contracts + SUB_VENDOR_COLUMNS").columns(args), contractsColumns(reg("all"), true));
  assert.deepEqual(
    byName.get("Contracts_pending").columns(args),
    contractsColumns(contractsCriteria({ status: "pending", category: "all" }), false)
  );
});

test("current Contracts_revenue and Contracts_pending lists have no unverified column in the snapshot (#42)", () => {
  const result = run(DEFAULT_COLUMNS);
  assert.deepEqual(unverified(result, "Contracts_revenue"), []);
  assert.deepEqual(
    findingsFor(result, "Contracts_revenue").map((f) => [f.type, f.probe]),
    [["missing-probe", "Contracts registered/revenue contract_id"]]
  );
  assert.deepEqual(unverified(result, "Contracts_pending"), []);
  assert.deepEqual(
    findingsFor(result, "Contracts_pending").map((f) => [f.type, f.probe]),
    [["missing-probe", "Contracts pending/expense FY"]]
  );
  assert.deepEqual(unverified(result, "Contracts"), []);
  assert.deepEqual(unverified(result, "Contracts + SUB_VENDOR_COLUMNS"), []);
});

test("regression #42: sending the expense list for registered/revenue is flagged, 18 columns, prime_contract_id first", () => {
  const result = run({ ...DEFAULT_COLUMNS, Contracts_revenue: DEFAULT_COLUMNS.Contracts });
  const flagged = findingsFor(result, "Contracts_revenue")
    .filter((f) => f.type === "unverified" && f.probe === "Contracts registered/revenue")
    .map((f) => f.column);
  assert.equal(flagged.length, 18); // matches issue #42: only prime_vendor and contract_class survive
  assert.equal(flagged[0], "prime_contract_id");
  assert.ok(!flagged.includes("prime_vendor"));
  assert.ok(!flagged.includes("contract_class"));
});

test("Budget is checked with and without its year criterion; the snapshot has neither variant", () => {
  const budget = COLUMN_CHECKS.find((c) => c.name === "Budget");
  assert.deepEqual(budget.probes, ["Budget year", "Budget no year"]);
  const result = run(DEFAULT_COLUMNS);
  assert.deepEqual(
    findingsFor(result, "Budget").map((f) => [f.type, f.probe]),
    [
      ["missing-probe", "Budget year"],
      ["missing-probe", "Budget no year"],
    ]
  );
});

test("a COLUMNS section holding the 1101 request-parameter error is UNPARSED-PROBE, not a column list", () => {
  // Real 1101 text (Contracts_NYCHA :: CRITERIA in the snapshot), as it would
  // appear if a COLUMNS probe's criteria were rejected before its columns were read.
  const crit = sections.get("Contracts_NYCHA :: CRITERIA").body;
  assert.match(crit, /^Provided request parameter /);
  const parsed = parseProbeResults(`===== Contracts_NYCHA :: COLUMNS =====\n${crit}\n`);
  const s = parsed.get("Contracts_NYCHA :: COLUMNS");
  assert.equal(s.valid, null);
  assert.equal(s.domain, null);

  const result = checkDefaultColumns({
    sections: parsed,
    defaultColumns: { Contracts_NYCHA: DEFAULT_COLUMNS.Contracts_NYCHA },
    shapeColumns: { nychaFiscalYear: NYCHA_FISCAL_YEAR_COLUMNS },
    checks: COLUMN_CHECKS.filter((c) => c.name === NYCHA_FY),
  });
  assert.deepEqual(result.findings.map((f) => f.type), ["unparsed-probe"]);
  assert.match(result.findings[0].message, /no response-column "Valid values/);
});

test("a CRITERIA section accepts only the request-parameter form", () => {
  const cols = sections.get("Contracts_NYCHA :: COLUMNS").body;
  const parsed = parseProbeResults(`===== Contracts_NYCHA :: CRITERIA =====\n${cols}\n`);
  assert.equal(parsed.get("Contracts_NYCHA :: CRITERIA").valid, null);
});

test("an aborted probe fails the check", () => {
  const aborted = parseProbeResults(
    "===== Revenue :: COLUMNS =====\nABORTED: HTTP 403 after 3 successful probe(s).\n"
  );
  const result = checkDefaultColumns({
    sections: aborted,
    defaultColumns: { Revenue: DEFAULT_COLUMNS.Revenue },
    checks: COLUMN_CHECKS.filter((c) => c.domainKey === "Revenue"),
  });
  assert.deepEqual(result.findings.map((f) => f.type), ["unparsed-probe"]);
});

test("a DEFAULT_COLUMNS key with no COLUMN_CHECKS entry is a finding", () => {
  const result = run({ ...DEFAULT_COLUMNS, Spending_NYCHA: ["year"] });
  assert.ok(
    result.findings.some((f) => f.type === "unmapped-domain" && f.check === "Spending_NYCHA")
  );
});

test("every DEFAULT_COLUMNS key is mapped, and every mapped probe is in probe-api-spec.sh", () => {
  const mapped = new Set(COLUMN_CHECKS.map((c) => c.domainKey));
  for (const key of Object.keys(DEFAULT_COLUMNS)) assert.ok(mapped.has(key), `unmapped: ${key}`);

  const script = readFileSync(new URL("../scripts/probe-api-spec.sh", import.meta.url), "utf8");
  const labels = new Set([...script.matchAll(/^cols "([^"]+)"/gm)].map((m) => m[1]));
  for (const check of COLUMN_CHECKS) {
    for (const probe of check.probes) {
      assert.ok(labels.has(probe), `COLUMN_CHECKS '${check.name}' needs probe '${probe}', which the script never sends`);
    }
  }
});

test("CLI: exit code 1 on findings, full report reaches a pipe, no network; 2 on unreadable input", async () => {
  // process.exitCode, not process.exit(): the report must not be truncated when
  // stdout is a pipe. spawnSync captures stdout through a pipe.
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../scripts/check-default-columns.mjs", import.meta.url).pathname;
  const fixture = new URL("./fixtures/probe-results-sample.txt", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^Probe output: /);
  assert.match(r.stdout, /Not covered by any probe/);
  assert.match(r.stdout, /\d+ finding\(s\)\.\n?$/);

  const missing = spawnSync(process.execPath, [script, fixture + ".does-not-exist"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read/);
});
