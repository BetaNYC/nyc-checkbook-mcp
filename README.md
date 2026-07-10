# nyc-checkbook-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for NYC Checkbook data — spending, contracts, budget, payroll, and revenue — powered by the [Checkbook NYC public API](https://www.checkbooknyc.com/data-feeds/api).

Checkbook NYC is the NYC Comptroller's financial transparency platform. It tracks $129B+ in annual city spending across 52,000+ vendors and 188,000+ contracts.

Vibe coded with [Claude](https://claude.ai) by [BetaNYC](https://beta.nyc).

---

## API key

**No API key is required.** Checkbook NYC is a public API, so this server works out of the box — no signup, no token, no environment variables to set.

---

## What it does

Exposes 8 tools over MCP:

| Tool | Description |
|---|---|
| `smart_search` | Full-text search across all data — finds contracts by product name, keyword, or vendor |
| `search_contracts` | Structured contract search with filters (agency, vendor, status, amount, dates, MWBE) |
| `get_contract` | Look up a single contract by ID |
| `search_spending` | Search spending (check) records by agency, payee, contract, date, amount |
| `search_budget` | Search budget data by agency, department, fiscal year |
| `search_payroll` | Search payroll records by agency, title, pay frequency, pay date, amount range (no employee names) |
| `search_revenue` | Search revenue data by agency and fiscal year |
| `get_agency_spending` | All spending for a specific agency in a fiscal year |
| `search_nycedc_contracts` | NYCEDC / Other Government Entities (OGE) contracts — separate from citywide |
| `search_nycha_contracts` | NYCHA (Housing Authority) contracts at release/line-item granularity |

> **Important:** Use `smart_search` when looking up a software product, service name, or keyword. Many NYC contracts are held by resellers — searching by the software vendor's name will return nothing. `smart_search` matches the contract's Purpose field where product names actually appear.

---

## Tools reference

### `smart_search`

Full-text search across all Checkbook NYC data. Searches Purpose fields, vendor names, and all text fields.

> **Availability caveat (verified 2026-07-06):** the underlying checkbooknyc.com `/smart_search` web endpoint is fronted by an Incapsula WAF and renders its results client-side with JavaScript, so it is generally **not usable server-side**. When blocked, this tool returns a structured error with fallback guidance (use `search_contracts` / `search_spending`, or browse [checkbooknyc.com/smart_search](https://www.checkbooknyc.com/smart_search) in a browser).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes | — | Search term — product name, keyword, or phrase |
| `limit` | number | no | 25 | Max results to return (max 100) |

```
smart_search("ArchiveSocial")
smart_search("Salesforce")
smart_search("social media archiving")
```

---

### `search_contracts`

Search registered or pending NYC contracts with structured filters.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `status` | string | no | `registered` | `registered` or `pending` |
| `category` | string | no | `expense` | `expense`, `revenue`, or `all` |
| `fiscal_year` | string | no | — | e.g. `"2024"` |
| `agency_code` | string | no | — | 3-digit code, e.g. `"858"` for OTI/DoITT |
| `vendor_name` | string | no | — | Prime vendor name (first 3 chars matched) |
| `vendor_code` | string | no | — | Vendor ID code |
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
| `include_sub_vendors` | boolean | no | `false` | Append sub-vendor / subcontractor detail columns (`sub_vendor`, `sub_vendor_mwbe_category`, `sub_contract_current_amount`, …) to the response. Registered contracts only. |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page (max 1000) |

Registered-contract responses include documented WBE/EBE flags (`prime_woman_owned_business`, `prime_emerging_business`) and lineage/registration columns (`mocs_registered`, `contract_class`, `parent_contract_id`, `prime_contract_version`) in addition to the core fields.

```
search_contracts(agency_code="858", fiscal_year="2024")
search_contracts(vendor_name="SHI International", status="registered")
search_contracts(amount_min=100000, amount_max=500000, mwbe_category="3")
search_contracts(agency_code="858", fiscal_year="2024", include_sub_vendors=true)
```

---

### `get_contract`

Look up a single contract by ID.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `contract_id` | string | yes | — | e.g. `"CT185820201424467"` or `"DO185820252009241"` |
| `status` | string | no | `registered` | `registered` or `pending` |
| `category` | string | no | `expense` | `expense` or `revenue` |

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

## API notes

- **Endpoint:** `POST https://www.checkbooknyc.com/api`
- **Format:** XML (handled internally — tools accept and return JSON)
- **Rate limits:** No official limit documented; be reasonable
- **Coverage:** Citywide agencies + NYCEDC and NYCHA as other government entities (OGE)
- **Fiscal year:** NYC fiscal year runs July 1 – June 30 (FY2025 = July 2024 – June 2025)
- **`smart_search` vs structured search:** `smart_search` uses Checkbook's web interface full-text endpoint and is better for product/keyword lookups. Structured tools use the official XML API and are better for precise filtering by agency, amount, or date.

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

Publishing is automated. Pushing a tag of the form `v<version>` (matching `package.json`) runs `.github/workflows/release.yml`, which tests, publishes to npm with provenance, and creates a GitHub Release with generated notes. Requires the `NPM_TOKEN` repository secret. Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

---

## Acknowledgments

Thank you to the [NYC Office of the Comptroller](https://comptroller.nyc.gov/) for building and maintaining Checkbook NYC as a public resource, and for open-sourcing the platform at [github.com/NYCComptroller/Checkbook](https://github.com/NYCComptroller/Checkbook). Financial transparency infrastructure like this makes civic research and accountability work possible.

---

## Support our work

Freedom isn't free. [Support BetaNYC](https://beta.nyc/donate/).

## License

MIT © [BetaNYC](https://beta.nyc)
