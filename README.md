# nyc-checkbook-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for NYC Checkbook data — spending, contracts, budget, payroll, and revenue — powered by the [Checkbook NYC public API](https://www.checkbooknyc.com/data-feeds/api).

Checkbook NYC is the NYC Comptroller's financial transparency platform. It tracks $129B+ in annual city spending across 52,000+ vendors and 188,000+ contracts.

Vibe coded with [Claude](https://claude.ai) by [BetaNYC](https://beta.nyc).

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
| `search_payroll` | Search payroll records by agency, name, title, salary range |
| `search_revenue` | Search revenue data by agency and fiscal year |
| `get_agency_spending` | All spending for a specific agency in a fiscal year |

> **Important:** Use `smart_search` when looking up a software product, service name, or keyword. Many NYC contracts are held by resellers — searching by the software vendor's name will return nothing. `smart_search` matches the contract's Purpose field where product names actually appear.

---

## Tools reference

### `smart_search`

Full-text search across all Checkbook NYC data. Searches Purpose fields, vendor names, and all text fields. **Use this for product/software name lookups.**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes | — | Search term — product name, keyword, or phrase |
| `limit` | number | no | 25 | Max results to return |

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
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page (max 1000) |

```
search_contracts(agency_code="858", fiscal_year="2024")
search_contracts(vendor_name="SHI International", status="registered")
search_contracts(amount_min=100000, amount_max=500000, mwbe_category="3")
```

---

### `get_contract`

Look up a single contract by ID.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `contract_id` | string | yes | — | e.g. `"CT185820201424467"` or `"DO185820252009241"` |
| `status` | string | no | `registered` | `registered` or `pending` |

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

*Either `fiscal_year` or `issue_date_from` should be provided.

```
search_spending(agency_code="858", fiscal_year="2024")
search_spending(payee_name="SHI International", fiscal_year="2025")
```

---

### `search_budget`

Search NYC budget allocations.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2025"` |
| `agency_code` | string | no | — | 3-digit agency code |
| `department_code` | string | no | — | Department code |
| `budget_code` | string | no | — | Budget code |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page |

---

### `search_payroll`

Search NYC payroll records.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2024"` |
| `agency_code` | string | no | — | 3-digit agency code |
| `last_name` | string | no | — | Employee last name |
| `title` | string | no | — | Job title |
| `salary_min` | number | no | — | Minimum base salary |
| `salary_max` | number | no | — | Maximum base salary |
| `page` | number | no | `1` | Pagination |
| `page_size` | number | no | `50` | Results per page |

---

### `search_revenue`

Search NYC revenue data.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `fiscal_year` | string | no | — | e.g. `"2025"` |
| `agency_code` | string | no | — | 3-digit agency code |
| `budget_code` | string | no | — | Budget code |
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

## Related BetaNYC MCP servers

- [nyc-council-mcp](https://github.com/BetaNYC/nyc-council-mcp) — NYC Council legislative data via Legistar
- [nyc-record-mcp](https://github.com/BetaNYC/nyc-record-mcp) — NYC City Record procurement notices

---

## Acknowledgments

Thank you to the [NYC Office of the Comptroller](https://comptroller.nyc.gov/) for building and maintaining Checkbook NYC as a public resource, and for open-sourcing the platform at [github.com/NYCComptroller/Checkbook](https://github.com/NYCComptroller/Checkbook). Financial transparency infrastructure like this makes civic research and accountability work possible.

---

## License

MIT © [BetaNYC](https://beta.nyc)
