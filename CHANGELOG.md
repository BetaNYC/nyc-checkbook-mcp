# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/releases/tag/v1.0.0
