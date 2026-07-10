# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

Contracts field gaps deferred from #3/#13, now confirmed against the CheckbookNYC
API config (`NYCComptroller/Checkbook`:
`source/web/modules/custom/checkbook_api/src/config/contracts.json`) — the
authoritative token source, read as published open-source config (no live API calls).

- **#6 registration_date** — `search_contracts` gains `registration_date_from` /
  `registration_date_to` (registered contracts only), which send the `registration_date`
  range criterion, and the prime-expense response column `prime_contract_registration_date`
  is now in the default Contracts column set. Confirmed against `contracts_active_expense`:
  `requestParameters.registration_date` (`{valueType:"range",dataType:"date",format:"YYYY-MM-DD"}`)
  and `displayConfiguration.xml.overrideColumns`/`rowElements` (`prime_contract_registration_date`).
- **#8 contract_includes_sub_vendors (filter, remainder)** — `search_contracts` gains an
  optional `contract_includes_sub_vendors` filter (registered contracts only), sent as a
  `value` criterion. The criterion name/type/max-length are confirmed against
  `contracts_active_expense.requestParameters.contract_includes_sub_vendors`
  (`{valueType:"value",dataType:"text",maxLength:"2"}`). The accepted 2-character code
  **enumeration is not published in the config** (no `allowedValues`), so the caller-supplied
  code is passed through verbatim and is documented as such — not guessed. (The sub-vendor
  response *columns* already shipped in #3/v1.2.0.)
- **#10 received_date + request filters (remainder)** — the `received_date` applicability
  question is resolved: `received_date` is a **pending-contract** concept only
  (`contracts_pending.requestParameters.received_date`, range/date; absent from every
  registered config, which use `registration_date` instead). `search_contracts` gains
  `received_date_from` / `received_date_to` (pending contracts only) sending the
  `received_date` range criterion, plus the universal value filters `purpose`
  (server-side "contains" match) and `pin`, both confirmed as request parameters in every
  contracts config.
- `node:test` coverage for the new criteria builders (registration_date/received_date status
  gating, contract_includes_sub_vendors pass-through, purpose/pin), the new default column,
  and request-XML emission. All fixture/structure-based; no network.

Still deferred (not derivable from the config, per the build-against-docs rule): the exact
value enumeration for `contract_includes_sub_vendors` and `sub_contract_status` (config
declares them as `text`/max-2 with no `allowedValues`). Additional confirmed-but-not-added
request params (`spent_to_date` range, `expense_category`, `apt_pin`) and niche registered
response columns (`prime_contract_apt_pin`, `prime_oca_number`, `percent_covid_spending`,
`percent_other_spending`, `vendor_record_type`) were left out of this pass to keep the
`search_contracts` surface focused; all are present in `contracts.json` if wanted later.

## [1.3.0] - 2026-07-09

### Added

- `search_nycedc_contracts`: new tool routing to the `Contracts_OGE` domain — NYCEDC / Other Government Entities contracts (registered expense only). Filters and response columns transcribed from the CheckbookNYC API config (`contracts_oge.json`) (#7).
- `search_nycha_contracts`: new tool routing to the `Contracts_NYCHA` domain — NYCHA (Housing Authority) contracts at release/line-item granularity (funding source, program/project, responsibility center). Filters and response columns transcribed from the CheckbookNYC API config (`contracts_nycha.json`) (#7).
- Re-added the `Contracts_OGE` and `Contracts_NYCHA` `DataDomain` members (removed as unused in #3) and their documented default response-column sets, now that tools route to them (#7).
- `node:test` coverage for the NYCEDC/NYCHA criteria builders, the entity default columns, and entity `type_of_data` routing.

The two entities use request-criteria names and response columns that differ from citywide Contracts and from each other (verified against `checkbook_api/src/config/contracts_oge.json` and `contracts_nycha.json`, 2026-07-09), so they are implemented as purpose-built tools rather than an overloaded `entity` flag on `search_contracts`.

## [1.2.0] - 2026-07-09

### Added

- `search_contracts`: new `include_sub_vendors` parameter (boolean, default `false`). When set on a registered-contracts search, the response is enriched with the documented sub-vendor / subcontractor columns — `sub_vendor`, `sub_vendor_mwbe_category`, `sub_contract_purpose`, `sub_contract_status`, `sub_contract_current_amount`, `sub_contract_original_amount`, `sub_vendor_paid_to_date`, `sub_contract_registration_date`, `sub_contract_industry`, `sub_woman_owned_business`, `sub_emerging_business` (#8).
- Contracts default response columns: WBE/EBE flags `prime_woman_owned_business` and `prime_emerging_business` (#9).
- Contracts default response columns: lineage/registration fields `mocs_registered`, `contract_class`, `parent_contract_id`, `prime_contract_version` (#10).
- `node:test` coverage for the new column selection (`contractsColumns`), the sub-vendor column set, and the enriched default Contracts columns.

All new fields were confirmed against the documented [Contracts API](https://www.checkbooknyc.com/contract-api) token tables (2026-07-09). The `contract_includes_sub_vendors` filter (#8) and the #10 request filters are intentionally **not** added: their accepted value enumeration / domain applicability could not be confirmed from the docs, so per the project's build-against-docs rule they are deferred rather than guessed. `registration_date` (#6) remains unimplemented pending confirmation of the exact prime-expense column token.

### Changed

- Internal architecture: migrated from the low-level `Server` API to `McpServer.registerTool`, with zod raw shapes as the single source of truth for each tool's input schema (the SDK now generates the `tools/list` JSON Schema). Tool handlers share a `runSearch` / `valueCriteria` / `rangeCriterion` path in the new `src/tools.ts`; `src/index.ts` is now an 11-line entry point. All tool names, descriptions, and the API contract are unchanged from a client's perspective (#3).

## [1.1.0] - 2026-07-06

### Added

- `get_contract`: new `category` parameter (`expense` | `revenue`, default `expense`) (#4).
- `search_payroll`: documented Payroll-domain criteria — `calendar_year`, `pay_frequency`, `pay_date_from`/`pay_date_to`, `amount_min`/`amount_max` (#4).
- `search_revenue`: documented Revenue-domain criteria — `budget_fiscal_year`, `revenue_category`, `revenue_class`, `revenue_source`, `fund_class`, `funding_class` (#4).
- HTTP hardening: 60s timeout, one retry on 5xx/network error, `User-Agent` header (#4).
- `node:test` suite (15 tests) covering request XML construction, domain criteria/columns, numeric coercion, and smart_search response classification against captured fixtures (#4).
- Tag-triggered npm release automation (`.github/workflows/release.yml`) and this changelog (#5).
- Build-only CI workflow gating PRs and pushes to main on `npm ci` + `tsc` across Node 20/22 (#2).

### Fixed

- `search_payroll`: rebuilt against the real Payroll API contract — removed nonexistent `last_name` / `base_salary` criteria (the API has no employee-name search); `fiscal_year` or `calendar_year` is now required, as the API demands (#4).
- `search_budget`: sends the Budget domain's documented `year` criterion instead of the invalid `fiscal_year`; response columns corrected to documented names (#4).
- `search_revenue`: dropped the invalid `budget_code` criterion; response columns corrected (#4).
- `search_spending`: the fiscal_year-or-issue_date_from requirement is now enforced instead of merely suggested (#4).
- XML parsing: numeric tag values are no longer coerced, so `"040"` agency codes keep leading zeros and long IDs keep full precision (#4).

### Changed

- `smart_search`: downgraded to a documented limitation — the checkbooknyc.com `/smart_search` endpoint is Incapsula-WAF-fronted and JS-rendered, so it is generally unusable server-side; the tool now returns a structured unavailability error with fallback guidance and caps `limit` at 100 (#4).
- README: installation section now leads with `npx`; added an explicit API-key subsection (#1).
- `package-lock.json` self-version synced to `package.json`.

## [1.0.1] - 2026-05-22

### Changed

- Added npm keywords for discoverability.

## [1.0.0] - 2026-05-21

### Added

- Initial release: MCP server for NYC Checkbook (Comptroller) data — tools for smart search, contracts, spending, budget, payroll, revenue, and agency spending summaries.
- Comptroller data-accuracy disclaimer appended to all tool responses.
- Acknowledgment of the NYC Comptroller and link to the open-source Checkbook NYC repository.

[Unreleased]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/releases/tag/v1.0.0
