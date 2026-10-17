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
import { SUB_VENDOR_COLUMNS } from "../dist/tools.js";

const sections = parseProbeResults(
  readFileSync(new URL("./fixtures/probe-results-sample.txt", import.meta.url), "utf8")
);

function run(defaultColumns, opts = {}) {
  return checkDefaultColumns({
    sections,
    defaultColumns,
    subVendorColumns: SUB_VENDOR_COLUMNS,
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

test("current Contracts_NYCHA and Contracts_OGE defaults pass against both variants in the snapshot", () => {
  const result = run(DEFAULT_COLUMNS);
  assert.deepEqual(findingsFor(result, "Contracts_NYCHA"), []);
  assert.deepEqual(findingsFor(result, "Contracts_OGE"), []);
  assert.ok(result.passed.some((c) => c.name === "Contracts_NYCHA"));
  assert.ok(result.passed.some((c) => c.name === "Contracts_OGE"));
});

test("regression #40: re-adding NYCHA 'year' or OGE 'apt_pin' is flagged, in the variant that omits it", () => {
  const broken = {
    ...DEFAULT_COLUMNS,
    Contracts_NYCHA: ["year", ...DEFAULT_COLUMNS.Contracts_NYCHA],
    Contracts_OGE: [...DEFAULT_COLUMNS.Contracts_OGE, "apt_pin"],
  };
  const result = run(broken);
  assert.equal(result.ok, false);

  const nycha = findingsFor(result, "Contracts_NYCHA");
  assert.deepEqual(
    nycha.map((f) => [f.type, f.probe, f.column]),
    [["unverified", "Contracts_NYCHA no FY", "year"]]
  );
  const oge = findingsFor(result, "Contracts_OGE");
  assert.deepEqual(
    oge.map((f) => [f.type, f.probe, f.column]),
    [["unverified", "Contracts_OGE FY", "apt_pin"]]
  );
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
