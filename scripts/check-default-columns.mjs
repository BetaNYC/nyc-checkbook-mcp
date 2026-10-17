#!/usr/bin/env node
// Compare every DEFAULT_COLUMNS list against the live API's own "Valid values"
// lists, as captured by scripts/probe-api-spec.sh. Pre-release step; see
// scripts/README.md ("Checking the default response columns").
//
//   npm run check:columns                       # reads ./probe-results.txt
//   npm run check:columns -- path/to/probe-results.txt
//
// Makes NO network requests. It only reads a file the probe already wrote.
//
// Why this exists: four releases shipped a default response column the live API
// rejects (#16 citywide `year`, v1.6.1 `sub_contract_registration_date`, #40
// NYCHA `year` / OGE `apt_pin`, #42 the expense list sent for registered
// revenue). One rejected column fails the whole request, so each one broke a
// tool for every call of the shape that rejects it (#40: one shape each for
// NYCHA and OGE). The first three were transcribed from published docs or
// config; #42 applied one shape's list to another. Each was patched by hand.
// This checks all of them at once.
//
// What a finding means. The probe's lists are a FLOOR, not a ceiling (see
// scripts/README.md): a name absent from a valid-values list has, more than
// once, still worked. So a column missing from a list is reported as UNVERIFIED,
// not as rejected. It still fails the check, because shipping an unverified
// column is how every one of these outages happened. Resolve it by testing the column with
// ONE paced live request, then either remove it from DEFAULT_COLUMNS or record
// the evidence in LIVE_VERIFIED_ABSENT below.
//
// Domain resolution depends on the criteria sent. The same type_of_data
// resolves to different column vocabularies with and without fiscal_year (#40:
// Contracts_NYCHA lists `year` as valid with fiscal_year and rejected it on a
// vendor_name-only search; Contracts_OGE lists `apt_pin` without fiscal_year and
// rejected it with). So the tools send a different list per call shape
// (nychaContractsColumns / nycedcContractsColumns in src/tools.ts), and each
// COLUMN_CHECKS entry checks ONE shape's list against the probe variants for
// that shape only. A column must be valid in every variant mapped to its shape.
// The citywide Contracts domain also varies by (status, category) (#42), so
// contractsColumns() picks Contracts, Contracts_revenue, or Contracts_pending.
//
// Exit codes: 0 every check passed; 1 at least one finding; 2 usage or I/O error.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Which probe variants each call shape's column list is checked against.
 * `probes` are section labels written by scripts/probe-api-spec.sh (without
 * " :: COLUMNS"). `columns` receives the lists loaded from dist/ and must build
 * the same list the tool sends for that shape (test/tools.test.mjs pins the
 * NYCHA/OGE composition to nychaContractsColumns / nycedcContractsColumns).
 * Adding a DEFAULT_COLUMNS key, or a tool call shape, means adding it here AND
 * adding a matching `cols` probe to the script.
 */
export const COLUMN_CHECKS = [
  {
    name: "Contracts",
    domainKey: "Contracts",
    tools: "search_contracts (registered, expense or all), get_contract (registered/expense)",
    probes: [
      "Contracts registered/expense",
      "Contracts registered/expense FY",
      "Contracts registered/all",
      "Contracts registered/all FY",
    ],
    columns: ({ defaultColumns }) => defaultColumns.Contracts,
  },
  {
    name: "Contracts + SUB_VENDOR_COLUMNS",
    domainKey: "Contracts",
    tools: "search_contracts registered expense/all, include_sub_vendors=true",
    probes: [
      "Contracts registered/expense",
      "Contracts registered/expense FY",
      "Contracts registered/all",
      "Contracts registered/all FY",
    ],
    columns: ({ defaultColumns, subVendorColumns }) => [
      ...defaultColumns.Contracts,
      ...subVendorColumns,
    ],
  },
  {
    name: "Contracts_revenue",
    domainKey: "Contracts_revenue",
    tools: "search_contracts registered/revenue, get_contract registered/revenue (#42)",
    probes: [
      "Contracts registered/revenue",
      "Contracts registered/revenue FY",
      "Contracts registered/revenue contract_id",
    ],
    columns: ({ defaultColumns }) => defaultColumns.Contracts_revenue,
  },
  {
    name: "Contracts_pending",
    domainKey: "Contracts_pending",
    tools: "search_contracts status=pending, any category",
    probes: [
      "Contracts pending/expense",
      "Contracts pending/expense FY",
      "Contracts pending/revenue",
      "Contracts pending/revenue FY",
      "Contracts pending/all",
      "Contracts pending/all FY",
    ],
    columns: ({ defaultColumns }) => defaultColumns.Contracts_pending,
  },
  {
    name: "Contracts_OGE (fiscal_year)",
    domainKey: "Contracts_OGE",
    tools: "search_nycedc_contracts with fiscal_year",
    probes: ["Contracts_OGE FY"],
    columns: ({ defaultColumns }) => defaultColumns.Contracts_OGE,
  },
  {
    name: "Contracts_OGE (no fiscal_year) + OGE_ALL_YEARS_COLUMNS",
    domainKey: "Contracts_OGE",
    tools: "search_nycedc_contracts without fiscal_year (no other criteria, or contract_id)",
    probes: ["Contracts_OGE", "Contracts_OGE contract_id"],
    columns: ({ defaultColumns, shapeColumns }) =>
      shapeColumns.ogeAllYears && [...defaultColumns.Contracts_OGE, ...shapeColumns.ogeAllYears],
  },
  {
    name: "Contracts_NYCHA (fiscal_year) + NYCHA_FISCAL_YEAR_COLUMNS",
    domainKey: "Contracts_NYCHA",
    tools: "search_nycha_contracts with fiscal_year",
    probes: ["Contracts_NYCHA"],
    columns: ({ defaultColumns, shapeColumns }) =>
      shapeColumns.nychaFiscalYear && [...defaultColumns.Contracts_NYCHA, ...shapeColumns.nychaFiscalYear],
  },
  {
    name: "Contracts_NYCHA (no fiscal_year)",
    domainKey: "Contracts_NYCHA",
    tools: "search_nycha_contracts without fiscal_year (vendor_name, contract_id, or no criteria)",
    probes: ["Contracts_NYCHA no FY", "Contracts_NYCHA contract_id", "Contracts_NYCHA no criteria"],
    columns: ({ defaultColumns }) => defaultColumns.Contracts_NYCHA,
  },
  {
    name: "Spending",
    domainKey: "Spending",
    tools: "search_spending, get_agency_spending",
    probes: ["Spending", "Spending issue_date"],
    columns: ({ defaultColumns }) => defaultColumns.Spending,
  },
  {
    name: "Budget",
    domainKey: "Budget",
    tools: "search_budget, with fiscal_year (sent as the `year` criterion) or without",
    probes: ["Budget year", "Budget no year"],
    columns: ({ defaultColumns }) => defaultColumns.Budget,
  },
  {
    name: "Payroll",
    domainKey: "Payroll",
    tools: "search_payroll",
    probes: ["Payroll", "Payroll calendar_year"],
    columns: ({ defaultColumns }) => defaultColumns.Payroll,
  },
  {
    name: "Revenue",
    domainKey: "Revenue",
    tools: "search_revenue",
    probes: ["Revenue"],
    columns: ({ defaultColumns }) => defaultColumns.Revenue,
  },
];

/**
 * Call shapes a tool can send that no probe covers yet. Printed on every run so
 * a green result is never read as covering them.
 */
export const NOT_COVERED = [
  "get_contract with status='pending', or registered/expense, with its contract_id criterion " +
    "(checked only against the same status/category probed without contract_id)",
  "search_revenue without fiscal_year",
  "search_nycha_contracts / search_nycedc_contracts with fiscal_year plus other criteria, " +
    "or without fiscal_year with criteria other than vendor_name / contract_id",
  "any criteria combination other than the probed variants",
];

/**
 * Columns confirmed by a live request to work in a variant whose valid-values
 * list omits them. Key: "<probe label>::<column>". Value: evidence (date, request
 * shape, result). Empty today: nothing currently needs it.
 */
export const LIVE_VERIFIED_ABSENT = {};

const SECTION_RE = /^===== (.+) :: (COLUMNS|CRITERIA) =====$/;
// Each section kind accepts only its own error form. A COLUMNS probe that comes
// back with the 1101 request-parameter error (its criteria were rejected) lists
// CRITERIA names, and comparing columns against it would be meaningless, so it
// is left unparsed and reported as UNPARSED-PROBE.
const VALID_RE = {
  COLUMNS: /Provided response column '[^']*' value is not allowed for '([^']*)' domain\. Valid values are '([^']*)'/,
  CRITERIA: /Provided request parameter '[^']*' is not valid for '([^']*)' domain\. Valid values are '([^']*)'/,
};

/**
 * Parse probe-api-spec.sh output. Returns a Map keyed by "<label> :: <KIND>".
 * Text before the first section header is ignored (fixtures use it for
 * provenance notes).
 */
export function parseProbeResults(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(SECTION_RE);
    if (header) {
      current = { label: header[1], kind: header[2], domain: null, valid: null, aborted: false, body: "" };
      sections.set(`${header[1]} :: ${header[2]}`, current);
      continue;
    }
    if (!current || line.trim() === "") continue;
    if (line.startsWith("DONE (")) continue;
    if (line.startsWith("ABORTED:")) {
      current.aborted = true;
      continue;
    }
    current.body += line;
    const m = line.match(VALID_RE[current.kind]);
    if (m) {
      current.domain = m[1];
      current.valid = new Set(m[2].split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return sections;
}

/**
 * Compare default column lists against parsed probe sections.
 * Pure: no I/O, no network.
 */
export function checkDefaultColumns({
  sections,
  defaultColumns,
  subVendorColumns = [],
  shapeColumns = {},
  checks = COLUMN_CHECKS,
  verifiedAbsent = LIVE_VERIFIED_ABSENT,
}) {
  const findings = [];
  const passed = [];

  const mapped = new Set(checks.map((c) => c.domainKey));
  for (const key of Object.keys(defaultColumns)) {
    if (!mapped.has(key)) {
      findings.push({
        type: "unmapped-domain",
        check: key,
        message: `DEFAULT_COLUMNS.${key} has no entry in COLUMN_CHECKS, so nothing checks it.`,
      });
    }
  }

  for (const check of checks) {
    const columns = check.columns({ defaultColumns, subVendorColumns, shapeColumns });
    if (!Array.isArray(columns)) {
      findings.push({
        type: "unmapped-domain",
        check: check.name,
        message:
          `COLUMN_CHECKS entry '${check.name}' cannot build its column list: ` +
          `DEFAULT_COLUMNS.${check.domainKey} or a shape-specific list it needs is missing.`,
      });
      continue;
    }
    let clean = true;
    for (const probe of check.probes) {
      const section = sections.get(`${probe} :: COLUMNS`);
      if (!section) {
        clean = false;
        findings.push({
          type: "missing-probe",
          check: check.name,
          probe,
          message: `No '${probe} :: COLUMNS' section in the probe output. Re-run scripts/probe-api-spec.sh (once, alone).`,
        });
        continue;
      }
      if (section.aborted || !section.valid) {
        clean = false;
        findings.push({
          type: "unparsed-probe",
          check: check.name,
          probe,
          message: section.aborted
            ? `Probe '${probe}' aborted (non-200). Wait out any block; do not re-run to check.`
            : `Probe '${probe}' has no ${section.kind === "COLUMNS" ? "response-column" : "request-parameter"} ` +
              `"Valid values are '...'" list: ${section.body.slice(0, 200)}`,
        });
        continue;
      }
      for (const column of columns) {
        if (section.valid.has(column)) continue;
        if (Object.prototype.hasOwnProperty.call(verifiedAbsent, `${probe}::${column}`)) continue;
        clean = false;
        findings.push({
          type: "unverified",
          check: check.name,
          probe,
          domain: section.domain,
          column,
          message:
            `'${column}' is not in the live valid list for '${section.domain}' (probe '${probe}'). ` +
            `UNVERIFIED, not proven rejected: test it with ONE paced request, then remove it ` +
            `or record the evidence in LIVE_VERIFIED_ABSENT.`,
        });
      }
    }
    if (clean) passed.push(check);
  }

  return { ok: findings.length === 0, findings, passed };
}

export function formatReport({ ok, findings, passed }, notCovered = NOT_COVERED) {
  const out = [];
  for (const check of passed) {
    out.push(`PASS  ${check.name} [${check.probes.join(" | ")}]`);
  }
  for (const f of findings) {
    const tag = f.type === "unverified" ? "UNVERIFIED" : f.type.toUpperCase();
    out.push(`FAIL  ${f.check}: ${tag}: ${f.message}`);
  }
  out.push("");
  out.push("Not covered by any probe (a PASS above says nothing about these):");
  for (const n of notCovered) out.push(`  - ${n}`);
  out.push("");
  out.push(ok ? "OK: every checked default column appears in its live valid list." : `${findings.length} finding(s).`);
  return out.join("\n");
}

async function main(argv) {
  const file = resolve(argv[0] ?? "probe-results.txt");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`check-default-columns: cannot read ${file}: ${err.message}`);
    console.error("Run `bash scripts/probe-api-spec.sh` first (alone; it makes paced live requests).");
    return 2;
  }
  let defaultColumns, subVendorColumns, shapeColumns;
  try {
    ({ DEFAULT_COLUMNS: defaultColumns } = await import("../dist/checkbook.js"));
    const tools = await import("../dist/tools.js");
    subVendorColumns = tools.SUB_VENDOR_COLUMNS;
    shapeColumns = {
      nychaFiscalYear: tools.NYCHA_FISCAL_YEAR_COLUMNS,
      ogeAllYears: tools.OGE_ALL_YEARS_COLUMNS,
    };
  } catch (err) {
    console.error(`check-default-columns: cannot load dist/ (${err.message}). Run \`npm run build\` first.`);
    return 2;
  }
  const result = checkDefaultColumns({
    sections: parseProbeResults(text),
    defaultColumns,
    subVendorColumns,
    shapeColumns,
  });
  console.log(`Probe output: ${file}`);
  console.log(formatReport(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // exitCode, not process.exit(): exit() can cut off stdout still being flushed
  // to a pipe, truncating the report.
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
