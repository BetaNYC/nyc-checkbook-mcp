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
// Why this exists: three releases shipped a default response column the live API
// rejects (#16 citywide `year`, v1.6.1 `sub_contract_registration_date`, #40
// NYCHA `year` / OGE `apt_pin`). One rejected column fails the whole request, so
// each one disabled a tool outright. Each was transcribed from published docs or
// config, and each was patched by hand. This checks all of them at once.
//
// What a finding means. The probe's lists are a FLOOR, not a ceiling (see
// scripts/README.md): a name absent from a valid-values list has, more than
// once, still worked. So a column missing from a list is reported as UNVERIFIED,
// not as rejected. It still fails the check, because shipping an unverified
// column is how all three outages happened. Resolve it by testing the column with
// ONE paced live request, then either remove it from DEFAULT_COLUMNS or record
// the evidence in LIVE_VERIFIED_ABSENT below.
//
// Domain resolution depends on the criteria sent. The same type_of_data
// resolves to different column vocabularies with and without fiscal_year (#40:
// Contracts_NYCHA lists `year` as valid with fiscal_year and rejected it on a
// vendor_name-only search; Contracts_OGE lists `apt_pin` without fiscal_year and
// rejected it with). So each list is checked against every
// probe variant matching a call shape a tool can actually send, and a column
// must be valid in all of them.
//
// Exit codes: 0 every check passed; 1 at least one finding; 2 usage or I/O error.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Which probe variants each DEFAULT_COLUMNS list is sent to. `probes` are
 * section labels written by scripts/probe-api-spec.sh (without " :: COLUMNS").
 * Adding a DEFAULT_COLUMNS key, or a tool call shape, means adding it here AND
 * adding a matching `cols` probe to the script.
 */
export const COLUMN_CHECKS = [
  {
    name: "Contracts",
    domainKey: "Contracts",
    tools: "search_contracts (registered/expense), get_contract",
    probes: ["Contracts registered/expense", "Contracts registered/expense FY"],
    columns: ({ defaultColumns }) => defaultColumns.Contracts,
  },
  {
    name: "Contracts + SUB_VENDOR_COLUMNS",
    domainKey: "Contracts",
    tools: "search_contracts include_sub_vendors=true",
    probes: ["Contracts registered/expense", "Contracts registered/expense FY"],
    columns: ({ defaultColumns, subVendorColumns }) => [
      ...defaultColumns.Contracts,
      ...subVendorColumns,
    ],
  },
  {
    name: "Contracts_pending",
    domainKey: "Contracts_pending",
    tools: "search_contracts status=pending",
    probes: ["Contracts pending/expense", "Contracts pending/expense FY"],
    columns: ({ defaultColumns }) => defaultColumns.Contracts_pending,
  },
  {
    name: "Contracts_OGE",
    domainKey: "Contracts_OGE",
    tools: "search_nycedc_contracts",
    probes: ["Contracts_OGE", "Contracts_OGE FY"],
    columns: ({ defaultColumns }) => defaultColumns.Contracts_OGE,
  },
  {
    name: "Contracts_NYCHA",
    domainKey: "Contracts_NYCHA",
    tools: "search_nycha_contracts",
    probes: ["Contracts_NYCHA", "Contracts_NYCHA no FY"],
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
    tools: "search_budget (sends the `year` criterion, not fiscal_year)",
    probes: ["Budget year"],
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
  "search_contracts / get_contract with category='revenue' or 'all' (sent with the " +
    "Contracts list; the registered/revenue domain's live list has no prime_* columns)",
  "search_revenue without fiscal_year",
  "any criteria combination other than the probed variants",
];

/**
 * Columns confirmed by a live request to work in a variant whose valid-values
 * list omits them. Key: "<probe label>::<column>". Value: evidence (date, request
 * shape, result). Empty today: nothing currently needs it.
 */
export const LIVE_VERIFIED_ABSENT = {};

const SECTION_RE = /^===== (.+) :: (COLUMNS|CRITERIA) =====$/;
const VALID_RE = /for '([^']*)' domain\. Valid values are '([^']*)'/;

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
    const m = line.match(VALID_RE);
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
    const columns = check.columns({ defaultColumns, subVendorColumns });
    if (!Array.isArray(columns)) {
      findings.push({
        type: "unmapped-domain",
        check: check.name,
        message: `COLUMN_CHECKS entry '${check.name}' points at DEFAULT_COLUMNS.${check.domainKey}, which does not exist.`,
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
            : `Probe '${probe}' has no "Valid values are '...'" list: ${section.body.slice(0, 200)}`,
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
  let defaultColumns, subVendorColumns;
  try {
    ({ DEFAULT_COLUMNS: defaultColumns } = await import("../dist/checkbook.js"));
    ({ SUB_VENDOR_COLUMNS: subVendorColumns } = await import("../dist/tools.js"));
  } catch (err) {
    console.error(`check-default-columns: cannot load dist/ (${err.message}). Run \`npm run build\` first.`);
    return 2;
  }
  const result = checkDefaultColumns({
    sections: parseProbeResults(text),
    defaultColumns,
    subVendorColumns,
  });
  console.log(`Probe output: ${file}`);
  console.log(formatReport(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
