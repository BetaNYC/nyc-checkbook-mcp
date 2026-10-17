# nyc-checkbook-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/BetaNYC/nyc-checkbook-mcp/blob/main/LICENSE)
[![CI](https://github.com/BetaNYC/nyc-checkbook-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/BetaNYC/nyc-checkbook-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@betanyc/nyc-checkbook-mcp.svg)](https://www.npmjs.com/package/@betanyc/nyc-checkbook-mcp)

Bringing New York City's checkbook to AI assistants everywhere.

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for NYC Checkbook data — spending, contracts, budget, payroll, and revenue — powered by the [Checkbook NYC public API](https://www.checkbooknyc.com/data-feeds/api).

Checkbook NYC is the NYC Comptroller's financial transparency platform. It tracks $129B+ in annual city spending across 52,000+ vendors and 188,000+ contracts.

Vibe coded with [Claude](https://claude.ai) by [BetaNYC](https://beta.nyc).

## Contents

* [Getting started](#getting-started)
* [What it does](#what-it-does)
* [Tools reference](#tools-reference)
* [Example queries](#example-queries)
* [Common agency codes](#common-agency-codes)
* [Installation](#installation)
* [Claude Desktop configuration](#claude-desktop-configuration)
* [API notes and limits](#api-notes-and-limits)
* [Getting help and the upstream project](#getting-help-and-the-upstream-project)
* [Contributing](#contributing)
* [Development](#development)
* [About BetaNYC](#about-betanyc)
* [Related BetaNYC MCP servers](#related-betanyc-mcp-servers)
* [Releases](#releases)
* [Acknowledgments](#acknowledgments)
* [License](#license)

---

## Getting started

To use this server you will need:

* Node 18 or later
* An MCP client, such as Claude Desktop or Claude Code

**No API key is required.** Checkbook NYC is a public API, so this server works out of the box — no signup, no token, no environment variables to set.

Note that the API is rate-limited to **one request per second**. This server enforces that internally, so you do not need to manage it yourself. See [API notes and limits](#api-notes-and-limits).

---

## What it does

Exposes 9 tools over MCP:

| Tool | Description |
|---|---|
| `search_contracts` | Structured contract search with filters (agency, vendor, status, amount, dates, MWBE) |
| `get_contract` | Look up a single contract by ID |
| `search_spending` | Search spending (check) records by agency, payee, contract, date, amount |
| `search_budget` | Search budget data by agency, department, fiscal year |
| `search_payroll` | Search payroll records by agency, title, pay frequency, pay date, amount range (no employee names) |
| `search_revenue` | Search revenue data by agency and fiscal year |
| `get_agency_spending` | All spending for a specific agency in a fiscal year |
| `search_nycedc_contracts` | NYCEDC / Other Government Entities (OGE) contracts — separate from citywide |
| `search_nycha_contracts` | NYCHA (Housing Authority) contracts at release/line-item granularity |

> **Finding a vendor by name?** The contracts API filters vendors only by `vendor_code` (there is no name lookup). Use `search_spending(payee_name="…")` to find checks paid to a named vendor. Note that many NYC contracts are held by resellers, so a software/product name may not match the contract's own vendor.

---

## Tools reference

> **`smart_search` is disabled by default and is intentionally not documented as a usable tool here.** The checkbooknyc.com `/smart_search` path is **not a supported Checkbook NYC API endpoint** — it is a WAF-fronted (Incapsula), JavaScript-rendered web page, confirmed with the NYC Comptroller's office. This server does not call it by default; the tool stays registered but returns opt-in guidance unless `CHECKBOOK_ENABLE_SMART_SEARCH=1` is set (and even then it is almost always WAF-blocked server-side). For vendor-name lookups use `search_spending(payee_name="…")`.

### `search_contracts`

Search registered or pending NYC contracts with structured filters.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `status` | string | no | `registered` | `registered` or `pending` |
| `category` | string | no | `expense` | `expense`, `revenue`, or `all` |
| `fiscal_year` | string | no | — | e.g. `"2024"` |
| `agency_code` | string | no | — | 3-digit code, e.g. `"858"` for OTI/DoITT |
| `vendor_name` | string | no | — | **Not a supported contracts filter** — the Checkbook API has no vendor-name parameter and no name→code lookup. Supplying it returns actionable guidance (use `vendor_code`, or `search_spending(payee_name=…)` for name search). |
| `vendor_code` | string | no | — | Vendor ID code (the only vendor filter for contracts) |
| `contract_id` | string | no | — | e.g. `"CT185820201424467"` |
| `amount_min` | number | no | — | Minimum current contract amount |
| `amount_max` | number | no | — | Maximum current contract amount |
| `start_date_from` | string | no | — | YYYY-MM-DD |
| `start_date_to` | string | no | — | YYYY-MM-DD |
| `end_date_from` | string | no | — | YYYY-MM-DD |
| `end_date_to` | string | no | — | YYYY-MM-DD |
| `award_method` | string | no | — | Award method code |
| `mwbe_category` | string | no | — | M/WBE category code |
| `industry` | string | no | — | Industry code |
| `contract_type` | string | no | — | Contract type code |
| `include_sub_vendors` | boolean | no | `false` | Append sub-vendor / subcontractor detail columns (`sub_vendor`, `sub_vendor_mwbe_category`, `sub_contract_current_amount`, …) to the response. Registered `expense` or `all` only; ignored for `pending` and for `category="revenue"`, whose domains list no sub-vendor columns. |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page (max 1000) |

**Known API limitation:** registered `revenue` searches with `fiscal_year` return no rows. Checkbook NYC reports a match count but sends no records, whatever columns are requested (live, 2026-10-16). The tool refuses that combination with an error and guidance, without sending a request. Search without `fiscal_year` and narrow by date range instead.

Registered `expense` and `all` responses include documented WBE/EBE flags (`prime_woman_owned_business`, `prime_emerging_business`) and lineage/registration columns (`mocs_registered`, `contract_class`, `parent_contract_id`, `prime_contract_version`) in addition to the core fields.

**Record field names depend on `status` and `category`.** The API resolves a different domain for each, and records are returned with the API's own field names, not normalized:

| Shape | Field names | Example fields |
|---|---|---|
| registered, `expense` or `all` | `prime_contract_*` | `prime_contract_id`, `prime_contract_purpose`, `prime_contracting_agency`, `prime_vendor_spent_to_date` |
| registered, `revenue` | plain | `contract_id`, `purpose`, `agency`, `prime_mwbe_category`, `woman_owned_business`, `version` (no spent-to-date, no sub-vendors) |
| `pending`, any category | plain | `contract_id`, `purpose`, `agency`, `received_date` |

```
search_contracts(agency_code="858", fiscal_year="2024")
search_contracts(vendor_code="V0000012345", status="registered")
search_contracts(amount_min=100000, amount_max=500000, mwbe_category="3")
search_contracts(agency_code="858", fiscal_year="2024", include_sub_vendors=true)
```

> **Finding contracts by vendor NAME:** the contracts API filters vendors only by `vendor_code`, not by name (there is no name→code lookup in the API). To search by name, use `search_spending(payee_name="…")` for checks paid to a vendor. Many contracts are held by resellers, so a product/software name may not match the contract's own vendor.

---

### `get_contract`

Look up a single contract by ID.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `contract_id` | string | yes | — | e.g. `"CT185820201424467"` or `"DO185820252009241"` |
| `status` | string | no | `registered` | `registered` or `pending` |
| `category` | string | no | `expense` | `expense` or `revenue`. Field names follow the same per-shape table as `search_contracts`. |

```
get_contract("CT185820201424467")
get_contract("DO185820252009241")
```

---

### `search_spending`

Search NYC spending records (checks issued to vendors).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no* | — | e.g. `"2024"` |
| `agency_code` | string | no | — | 3-digit agency code |
| `payee_name` | string | no | — | Payee/vendor name |
| `contract_id` | string | no | — | Filter by contract |
| `issue_date_from` | string | no* | — | YYYY-MM-DD |
| `issue_date_to` | string | no | — | YYYY-MM-DD |
| `amount_min` | number | no | — | Minimum check amount |
| `amount_max` | number | no | — | Maximum check amount |
| `expense_category` | string | no | — | Expense category code |
| `spending_category` | string | no | — | `"c"` capital, `"e"` expense |
| `mwbe_category` | string | no | — | M/WBE category code |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page (max 1000) |

*Either `fiscal_year` or `issue_date_from` is required (enforced).

```
search_spending(agency_code="858", fiscal_year="2024")
search_spending(payee_name="SHI International", fiscal_year="2025")
```

---

### `search_budget`

Search NYC budget allocations.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2026"` (sent to the API as the Budget domain's `year` criterion) |
| `agency_code` | string | no | — | 3-digit agency code |
| `department_code` | string | no | — | Department code |
| `budget_code` | string | no | — | Budget code |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page |

---

### `search_payroll`

Search NYC payroll records. **Requires `fiscal_year` or `calendar_year`.**

> The Checkbook NYC API does **not** expose employee names — payroll records are keyed by agency, title, pay frequency, and pay date. There is no employee-name search.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no* | — | e.g. `"2026"` |
| `calendar_year` | string | no* | — | e.g. `"2025"` |
| `agency_code` | string | no | — | 3-digit agency code |
| `title` | string | no | — | Job title (partial match) |
| `pay_frequency` | string | no | — | e.g. `"BI-WEEKLY"`, `"SUPPLEMENTAL"` |
| `pay_date_from` | string | no | — | YYYY-MM-DD |
| `pay_date_to` | string | no | — | YYYY-MM-DD |
| `amount_min` | number | no | — | Minimum payment amount |
| `amount_max` | number | no | — | Maximum payment amount |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page |

*Either `fiscal_year` or `calendar_year` is required (enforced).

---

### `search_revenue`

Search NYC revenue data.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2026"` |
| `budget_fiscal_year` | string | no | — | e.g. `"2026"` |
| `agency_code` | string | no | — | 3-digit agency code |
| `revenue_category` | string | no | — | 2-character revenue category code |
| `revenue_class` | string | no | — | Revenue class code |
| `revenue_source` | string | no | — | Revenue source code |
| `fund_class` | string | no | — | Fund class code |
| `funding_class` | string | no | — | Funding class code |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page |

---

### `get_agency_spending`

All spending for a specific agency in a fiscal year.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agency_code` | string | yes | — | 3-digit agency code, e.g. `"858"` for OTI |
| `fiscal_year` | string | yes | — | e.g. `"2025"` |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page |

```
get_agency_spending("858", "2025")   // OTI/DoITT
get_agency_spending("040", "2025")   // NYPD
```

---

### `search_nycedc_contracts`

Search NYCEDC / Other Government Entities (OGE) contracts (Checkbook domain `Contracts_OGE`), which are separate from citywide contracts. Registered expense contracts only.

Results carry `apt_pin` only when you do **not** filter by `fiscal_year`. The API lists that response column as valid without `fiscal_year` and rejected it on a `fiscal_year` search (#40), so it is requested only then.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2024"` |
| `vendor_name` | string | no | — | Prime vendor name (first 3 chars matched) |
| `contract_id` | string | no | — | Contract number |
| `entity_contract_number` | string | no | — | OGE entity contract number |
| `other_government_entities_code` | string | no | — | OGE agency code |
| `award_method` | string | no | — | Award method code |
| `expense_category` | string | no | — | Expense category code |
| `budget_name` | string | no | — | Budget name (first 3 chars matched) |
| `commodity_line` | string | no | — | Commodity line code |
| `pin` | string | no | — | Contract PIN / tracking number |
| `amount_min` / `amount_max` | number | no | — | Current contract amount range |
| `start_date_from` / `start_date_to` | string | no | — | YYYY-MM-DD |
| `end_date_from` / `end_date_to` | string | no | — | YYYY-MM-DD |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page (max 1000) |

---

### `search_nycha_contracts`

Search NYCHA (New York City Housing Authority) contracts (Checkbook domain `Contracts_NYCHA`), reported at release / line-item granularity (funding source, program/project, responsibility center).

**Results carry a `year` field only when you filter by `fiscal_year`.** The API lists the `year` response column as valid with `fiscal_year` and rejected it on a search without (#40), so it is requested only then. Without `fiscal_year`, results carry no year or fiscal-year field. When the year matters, filter by `fiscal_year`, one call per year. Each record still has its own `start_date`, `end_date`, and `approved_date`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2024"` |
| `vendor_name` | string | no | — | Vendor name (contains match) |
| `vendor_code` | string | no | — | Vendor number / code |
| `contract_id` | string | no | — | Contract ID |
| `purchase_order_type` | string | no | — | Purchase order type code |
| `responsibility_center` | string | no | — | Responsibility center code |
| `contract_type` | string | no | — | Contract type code |
| `award_method` | string | no | — | Award method code |
| `industry` | string | no | — | Industry type code |
| `other_government_entities_code` | string | no | — | NYCHA agency code |
| `purpose` | string | no | — | Contract purpose (contains match) |
| `pin` | string | no | — | PO header ID / PIN |
| `amount_min` / `amount_max` | number | no | — | Contract amount range |
| `start_date_from` / `start_date_to` | string | no | — | YYYY-MM-DD |
| `end_date_from` / `end_date_to` | string | no | — | YYYY-MM-DD |
| `approved_date_from` / `approved_date_to` | string | no | — | Release approved date range (YYYY-MM-DD) |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page (max 1000) |

---

## Example queries

Natural-language questions this MCP can answer today, by persona:

- **Watchdog/journalist:** "How much did the city actually pay a given vendor in FY2024, and through which agencies?" — `search_spending` filters payment records by payee name, agency, fiscal year, date range, and amount.

- **Accountability researcher:** "Which registered expense contracts over $500,000 did the Department of Transportation hold in FY2025?" — `search_contracts` filters by agency, fiscal year, amount range, status, industry, and M/WBE category (use `get_contract` for full detail on one contract by ID).

- **Budget analyst:** "What was the NYPD's adopted budget for FY2026, broken down by budget code?" — `search_budget` returns budget lines by agency, department, budget code, and fiscal year (`get_agency_spending` gives the companion "what did they actually spend" view).

- **Labor/compensation reporter:** "What did FDNY paramedics earn in FY2026, and which pay frequencies show the most supplemental pay?" — `search_payroll` filters by agency, job title, pay frequency, pay date, and amount range.

- **Fiscal-policy researcher:** "How much revenue did the Department of Finance collect in FY2025, grouped by revenue category?" — `search_revenue` filters by agency, revenue category/class/source, fund class, and fiscal year.

---

## Common agency codes

| Code | Agency |
|---|---|
| `002` | Department of Finance |
| `040` | Police Department |
| `057` | Fire Department |
| `071` | Department of Correction |
| `072` | Department of Probation |
| `127` | Department of Education |
| `346` | Department of Homeless Services |
| `473` | Department of Social Services |
| `801` | Department of Citywide Administrative Services |
| `826` | Department of Environmental Protection |
| `841` | Department of Transportation |
| `846` | Department of Parks and Recreation |
| `856` | Department of Records and Information Services (DORIS) |
| `858` | Office of Technology and Innovation (OTI / DoITT) |

---

## Installation

### npx (recommended — no install required)

```bash
npx @betanyc/nyc-checkbook-mcp
```

### Global install

```bash
npm install -g @betanyc/nyc-checkbook-mcp
nyc-checkbook-mcp
```

No API key required — Checkbook NYC is a public API.

---

## Claude Desktop configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nyc-checkbook": {
      "command": "npx",
      "args": ["-y", "@betanyc/nyc-checkbook-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "nyc-checkbook": {
      "command": "nyc-checkbook-mcp"
    }
  }
}
```

---

## API notes and limits

### Limits

The NYC Comptroller's office publishes these limits for the Checkbook NYC API. Both were confirmed directly with their team on 2026-07-28.

| Limit | Value | How this server handles it |
|---|---|---|
| Request rate | **1 request per second** | Enforced internally. Every outbound request is serialized and spaced at least 1.1 seconds apart, process-wide, including retries. |
| Records per call | **20,000** | Accepted as the ceiling for `page_size`. The default stays at 50, because the practical limit for an MCP response is your context window rather than the API. |

**Exceeding the rate limit has consequences beyond a throttle.** The API sits behind an Imperva edge that will place a client into a blocked state that persists well past the burst that caused it, and presents as an HTTP 403 on every subsequent request, including from an ordinary browser on the same network. If you fork this server or write your own client, pace your requests.

This server also declines to follow HTTP redirects. A redirect chain is followed inside a single `fetch()` call, where rate pacing cannot reach it, so one logical API call can arrive at the origin as dozens of requests.

### Other notes

- **Endpoint:** `POST https://www.checkbooknyc.com/api`
- **Format:** XML (handled internally — tools accept and return JSON)
- **Authentication:** none. Requests identify themselves only by User-Agent.
- **Coverage:** Citywide agencies + NYCEDC and NYCHA as other government entities (OGE)
- **Fiscal year:** NYC fiscal year runs July 1 – June 30 (FY2025 = July 2024 – June 2025)
- **`smart_search` is disabled by default:** the `/smart_search` web path is not a supported API endpoint (WAF-fronted, JS-rendered), so the server does not call it unless `CHECKBOOK_ENABLE_SMART_SEARCH=1` is set. Use the structured XML-API tools; see the note under *Tools reference*.

---

## Getting help and the upstream project

**Questions about this MCP server** belong in our [issue tracker](https://github.com/BetaNYC/nyc-checkbook-mcp/issues).

**Questions about Checkbook NYC itself**, the data, the API, or the platform, belong upstream with the Comptroller's office. Checkbook NYC is open source, and the office runs a public technical discussion forum:

| | |
|---|---|
| Source code | [github.com/NYCComptroller/Checkbook](https://github.com/NYCComptroller/Checkbook) |
| Discussion forum | [groups.google.com/group/checkbooknyc](https://groups.google.com/group/checkbooknyc) |
| Forum by email | `checkbooknyc` at `googlegroups.com` |
| API documentation | [checkbooknyc.com/data-feeds/api](https://www.checkbooknyc.com/data-feeds/api) |

You can post to the forum by web or by email, and you do not need to be subscribed to post.

Please take questions about data accuracy, field definitions, coverage gaps, and API behavior to the forum rather than to our tracker. They are better answered by the people who maintain the platform, and asking in the open helps everyone else building against the same API.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report an issue, propose a change, and what we ask of code contributions.

One request specific to this project: **do not add code that queries undocumented endpoints or that would exceed the published rate limit.** This server talks to a public service run by a city agency on a fixed budget, and our access depends on being a well-behaved client.

---

## Development

```bash
git clone https://github.com/BetaNYC/nyc-checkbook-mcp.git
cd nyc-checkbook-mcp
npm install
npm run build
```

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Compile in watch mode |
| `npm test` | Build, then run the test suite |
| `npm run check:columns` | Build, then check every default response-column list, per call shape, against `probe-results.txt` (no network; see [scripts/README.md](scripts/README.md)) |
| `npm start` | Run the built server |

### Testing

Tests use the Node built-in test runner and live in `test/`. They run against recorded fixtures in `test/fixtures/` rather than the live API, so the suite needs no network access and cannot trip the rate limit.

Three areas carry tests worth knowing about before you change them:

- **`test/pace.test.mjs`** guards the rate limiter, including the case where several callers are in flight at once. If you change how requests are dispatched, these are the tests that catch a regression into bursting.
- **`test/strict-schema.test.mjs`** asserts that unknown tool parameters are rejected rather than silently dropped.
- **`test/check-default-columns.test.mjs`** tests the default-column checker against a recorded probe snapshot. It proves the checker works, not that the columns are valid today. Only a fresh probe run can show that (see Releases).

### Source layout

- `src/index.ts` starts the server and registers tools
- `src/checkbook.ts` holds the API client, request pacing, XML construction, and response parsing
- `src/tools.ts` holds tool definitions, schemas, and criteria mapping

---

## About BetaNYC

This project is built and maintained by [BetaNYC](https://beta.nyc), New York's
civic technology and open-data community. We work to improve lives in New York
through civic design, technology, data, and public-interest technology.

**Come do civic tech with us.** We run public events, meetups, and hands-on
data classes — including [NYC School of Data](https://www.schoolofdata.nyc/)
and [CityCamp NYC](https://citycamp.nyc), and we host frequent civic-tech gatherings. See what's coming up on our
[events calendar](https://www.beta.nyc/events/).

**Sustain this work.** These MCP servers are free and open source. To help keep this work going and find BetaNYC's
tools, please consider [donating and becoming a Beta
Builder](https://beta.nyc/donate).

## Building on this? Tell us!

If you build something with this project, we'd love to hear about it. We can help other New Yorkers find it. BetaNYC publishes a weekly newsletter,
*This Week in NYC's Civic Technology and Open Data*.

- **[Subscribe to the newsletter](https://beta.nyc/newsletter)** to keep up with
  NYC civic tech, open data, and public-interest technology.
- **Built something, or found a story worth sharing?** [Submit a link for the
  newsletter](https://www.beta.nyc/newsletter-inbox/) and we'll consider it for
  an upcoming issue.

## Related BetaNYC MCP servers

BetaNYC maintains a suite of open-source MCP servers for NYC and NYS civic data.
See the full directory, with install details for each, at
**[beta.nyc/ai-tools](https://beta.nyc/ai-tools)**.

This server pairs directly with:

- **[nyc-budget-mcp](https://github.com/BetaNYC/New-York-City-Budget)**: trace agency spending and contracts back to the Council discretionary awards (Schedule C) that funded them.
- **[nyc-record-mcp](https://github.com/BetaNYC/nyc-record-mcp)**: connect a registered contract to the procurement solicitation and award notice that preceded it.

---

## Releases

**Before tagging, check the default response columns against the live API.** A single rejected response column fails the whole request, so it can disable a tool outright, and default columns have been wrong four times (#16, v1.6.1, #40, #42). With no MCP client running:

```bash
bash scripts/probe-api-spec.sh   # 43 paced requests, ~65s; run it once, alone
npm run check:columns            # must exit 0
```

**Then make one paced live call per contract shape and confirm each returns at least one row**: `search_contracts` for registered expense, registered revenue (without `fiscal_year`; with it, the API is known to return no rows, see below), registered `all`, and pending; `get_contract` for one revenue contract; plus `search_nycha_contracts` and `search_nycedc_contracts` with and without `fiscal_year`. Space the calls out, and run them alone. The checker cannot catch this: a column the API *accepts* can still make it return no rows (`contract_class` on revenue contracts, #42). The server now reports that case as an error ("matched N records but returned none"), not as an empty page, so an `isError` here is the signal to bisect the column list. If even `contract_id` alone returns no rows, the defect is upstream, not in a column: registered revenue with `fiscal_year` is one such case (live, 2026-10-16; 399 matched, no rows for any column set).

If the probe aborts with a 403, that is a rate-limit block: stop, and do not re-run it to check. If the checker reports `UNVERIFIED`, follow [scripts/README.md](scripts/README.md#checking-the-default-response-columns-pre-release). `probe-results.txt` is git-ignored.

Publishing is automated. Pushing a tag of the form `v<version>` (matching `package.json`) runs `.github/workflows/release.yml`, which tests, publishes to npm with provenance, and creates a GitHub Release with generated notes. Requires the `NPM_TOKEN` repository secret. Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

---

## Acknowledgments

Thank you to the [NYC Office of the Comptroller](https://comptroller.nyc.gov/) for building and maintaining Checkbook NYC as a public resource, and for open-sourcing the platform at [github.com/NYCComptroller/Checkbook](https://github.com/NYCComptroller/Checkbook). Financial transparency infrastructure like this makes civic research and accountability work possible.

---

## Support our work

Freedom isn't free. [Support BetaNYC](https://beta.nyc/donate/).

## License

MIT © [BetaNYC](https://beta.nyc)
