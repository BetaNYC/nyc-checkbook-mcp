# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.2] - UNRELEASED (pending operator live-verification)

> **Do not tag/publish this version until the operator has verified the new
> filters against the live Checkbook NYC API.** Every filter added here is
> transcribed from the CheckbookNYC **open-source config** only — the same source
> #17 (v1.3.1) proved does **not** match the live contracts domain. They are
> therefore shipped **disabled by default** behind a fail-fast gate and must be
> operator-confirmed before release.

### Added

- `search_contracts`: five new **UNVERIFIED**, config-sourced filters for the
  citywide contracts domain, each **disabled by default** and gated behind the
  environment variable `CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1`. When
  disabled, supplying any of them returns actionable fail-fast guidance instead of
  firing an unverified token at the live API (mirrors how #17 made `vendor_name`
  fail fast):
  - `registration_date_from` / `registration_date_to` — `registration_date` range,
    registered contracts only (#6). Param name appears in #17's live-corroborated
    accepted-param set, but the range filter itself is not yet live-verified.
  - `purpose` — server-side "contains" keyword match (#10). In #17's param set;
    not yet live-verified.
  - `pin` — contract PIN / tracking number (#10). In #17's param set; not yet
    live-verified.
  - `contract_includes_sub_vendors` — 2-char sub-vendor status code, registered
    only (#8). Param name in #17's set; the accepted code enumeration is **not
    published**, so the value is passed through verbatim.
  - `received_date_from` / `received_date_to` — `received_date` range, pending
    contracts only (#10). **Weakest footing:** not in #17's registered-domain set,
    and the pending domain was never live-tested.
- `node:test` coverage (fixture/structure only, zero network) for the new criteria
  builders, status gating (registration_date registered-only, received_date
  pending-only), the fail-fast gate, and a regression guard that
  `DEFAULT_COLUMNS.Contracts` still excludes `year` and `prime_contract_registration_date`.

### Notes

- **Superseded PR #14.** PR #14 built these fields (plus a
  `prime_contract_registration_date` response column) against the pre-#17
  open-source config and now conflicts with main. This release re-authors only the
  surviving request-side filters onto the post-#17 architecture.
- **Deliberately excluded:** the `prime_contract_registration_date` **response
  column** #14 added to `DEFAULT_COLUMNS.Contracts`. It is absent from #17's frozen,
  live-confirmed column set and is the exact class (`year`) the live API rejects — a
  bad response column fails the whole request, so it is not re-introduced.
- README is intentionally untouched (owned by PR #15).

## [1.3.1] - 2026-07-16

### Fixed

- `search_contracts` / `get_contract`: corrected the request-parameter and response-column vocabulary for the citywide Registered Contracts domain (#16). Two mismatches caused every contracts query to fail against the live API:
  - `vendor_name` was mapped to the request parameter `prime_vendor`, which the Registered Contracts domain does not accept as a filter (it is a response column only). The contracts API has **no vendor-name filter and no name→code lookup** — vendors filter only by `vendor_code`. `vendor_name` now fails fast with actionable guidance (use `vendor_code`, or `search_spending`/`smart_search` for name search) instead of returning an opaque error.
  - `year` was requested as a response column, which the domain rejects (its vocabulary is the `prime_contract_*` / `prime_vendor` set). This also broke `get_contract`, which requests the same default column set. `year` has been removed from `DEFAULT_COLUMNS.Contracts`.
- Verified against the live Checkbook NYC API on 2026-07-16: a plain registered/expense query returns records with the corrected columns and no error; `agency_code` and `vendor_code` filters are accepted. OGE/NYCHA contract domains are unaffected (their configs legitimately include a `year` element).

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

[Unreleased]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.3.1...HEAD
[1.3.2]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/releases/tag/v1.0.0
